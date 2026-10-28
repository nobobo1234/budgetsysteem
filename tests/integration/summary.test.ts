// Maandsamenvatting met een echte database en een nagebootste Haiku: de feiten zoals Budget ze
// telt, wat er naar Haiku gaat, bewaren en opnieuw schrijven, het maandbudget, de grens van vijf
// keer, "klopt niet" en de telemetrie. Nooit een echte API-aanroep.
import type Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiClient, type AiClient } from '../../src/lib/server/ai/client.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	categories,
	monthSummaries,
	owed,
	owedPayments,
	people,
	peopleIbans,
	tags,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';
import { monthFacts, REPAYMENTS } from '../../src/lib/server/summary/facts.ts';
import {
	markSentenceWrong,
	monthSummary,
	summaryAgain
} from '../../src/lib/server/summary/index.ts';
import { syncAutoTags } from '../../src/lib/server/tags.ts';
import { aiBudget } from '../../src/lib/server/telemetry/ai.ts';
import type { TelemetryDB } from '../../src/lib/server/telemetry/db.ts';
import { aiCalls, receiptReads } from '../../src/lib/server/telemetry/schema.ts';
import { actions } from '../../src/routes/(app)/afsluiting/[maand]/+page.server.ts';
import { fakeEvent, tempDatabase, tempTelemetry } from './helpers.ts';

const MONTH = '2026-09';
const TODAY = '2026-10-05';
const NOW = new Date('2026-10-05T10:00:00Z');
const SANNE_IBAN = 'NL91ABNA0417164300';

let db: DB;
let telemetry: TelemetryDB;
let cleanups: (() => void)[] = [];
beforeEach(() => {
	const d = tempDatabase();
	const t = tempTelemetry();
	db = d.db;
	telemetry = t.telemetry;
	cleanups = [d.cleanup, t.cleanup];
});
afterEach(() => {
	useAiClient(null);
	for (const c of cleanups) c();
});

const category = (name: string) =>
	db.select().from(categories).where(eq(categories.name, name)).get()!.id;
const sns = () => db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;

function book(
	date: string,
	cents: number,
	categoryName: string,
	counterparty: string,
	extra: Partial<typeof transactions.$inferInsert> = {}
): string {
	return db
		.insert(transactions)
		.values({
			amountCents: -cents,
			date,
			counterparty,
			description: 'Omschrijving die nooit naar Haiku mag',
			categoryId: category(categoryName),
			accountId: sns(),
			source: 'import',
			...extra
		})
		.returning()
		.get().id;
}

/** Drie rustige maanden en dan een september waarin uit eten verdubbelt. */
function history() {
	for (const m of ['2026-06', '2026-07', '2026-08']) {
		book(`${m}-05`, 30_000, 'Boodschappen', 'ALBERT HEIJN 1403 UTRECHT');
		book(`${m}-12`, 9_000, 'Uit eten en bezorgen', 'Pizzeria Roma');
	}
	book(`${MONTH}-05`, 30_500, 'Boodschappen', 'ALBERT HEIJN 1403 UTRECHT');
	book(`${MONTH}-12`, 9_000, 'Uit eten en bezorgen', 'Pizzeria Roma');
	book(`${MONTH}-20`, 9_400, 'Uit eten en bezorgen', 'Thuisbezorgd.nl');
}

function message(text: string, stop: Anthropic.StopReason = 'end_turn'): Anthropic.Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'claude-haiku-5-5',
		content: [{ type: 'text', text, citations: null }],
		stop_reason: stop,
		stop_sequence: null,
		usage: { input_tokens: 800, output_tokens: 100 }
	} as Anthropic.Message;
}

/** Nagebootste Haiku: schrijft één zin over het eerste feit, of wat de test opgeeft. */
function haiku(text = '{f1.naam} kostte {f1.nu}, tegenover gemiddeld {f1.gem3}.') {
	const create = vi.fn(async (_request: Anthropic.MessageCreateParamsNonStreaming) =>
		message(JSON.stringify({ zinnen: [{ tekst: text, feiten: ['f1'] }] }))
	);
	const client = { messages: { create } } as unknown as AiClient;
	return { client, create };
}

const opts = (client: AiClient | null) => ({ client, telemetry: () => telemetry, now: NOW });
const calls = () => telemetry.select().from(aiCalls).all();

describe('feiten uit de database', () => {
	it('per categorie en tegenpartij, zoals Budget telt', () => {
		history();
		const { facts } = monthFacts(db, MONTH);
		expect(facts.map((f) => [f.soort, f.naam, f.nu, f.gem3])).toEqual([
			['categorie', 'Uit eten en bezorgen', 18_400, 9_000],
			// De nette naam, zonder domein (spec: namen van tegenpartijen)
			['tegenpartij', 'Thuisbezorgd', 9_400, 0]
		]);
		expect(facts[1]).toMatchObject({ nieuw: true });
	});

	it('zonder historie geen feiten', () => {
		book(`${MONTH}-12`, 9_000, 'Uit eten en bezorgen', 'Pizzeria Roma');
		expect(monthFacts(db, MONTH).facts).toEqual([]);
	});

	it('een terugboeking telt in de maand van de boeking die hij verrekent', () => {
		history();
		const jacket = book(`${MONTH}-15`, 12_000, 'Kleding', 'Kledingzaak');
		// Het geld komt in oktober terug, maar verrekent de jas van september
		book('2026-10-02', -12_000, 'Kleding', 'Kledingzaak', { correctionOf: jacket });
		const names = monthFacts(db, MONTH).facts.map((f) => f.naam);
		expect(names).not.toContain('Kleding');
		expect(names).not.toContain('Kledingzaak');
	});

	it('personen worden huisgenoot A, terugbetalingen samen verrekening huisgenoten', () => {
		history();
		const sanne = db.insert(people).values({ name: 'Sanne' }).returning().get().id;
		db.insert(peopleIbans).values({ personId: sanne, iban: SANNE_IBAN }).run();
		// Je betaalde Sanne voor een concertkaartje
		book(`${MONTH}-08`, 6_000, 'Uitgaan', 'S. de Vries', { counterIban: SANNE_IBAN });
		// Sanne betaalde je terug voor een etentje: inkomend, in Uit eten
		const back = book(`${MONTH}-22`, -4_000, 'Uit eten en bezorgen', 'S. de Vries', {
			counterIban: SANNE_IBAN
		});
		const post = db
			.insert(owed)
			.values({ personId: sanne, amountCents: 4_000, direction: 'te_krijgen', date: `${MONTH}-21` })
			.returning()
			.get().id;
		db.insert(owedPayments)
			.values({ transactionId: back, personId: sanne, owedId: post, amountCents: 4_000 })
			.run();

		const { facts, names } = monthFacts(db, MONTH);
		const byName = new Map(facts.map((f) => [f.naam, f]));
		expect(byName.get('huisgenoot A')).toMatchObject({ soort: 'tegenpartij', nu: 6_000 });
		expect(byName.get(REPAYMENTS)).toMatchObject({ soort: 'tegenpartij', nu: -4_000 });
		expect(JSON.stringify(facts)).not.toMatch(/Sanne|Vries|NL91/);
		// De echte naam mag ook niet letterlijk in een zin
		expect(names).toContain('Sanne');
	});

	it('een tag die in de maand liep', () => {
		history();
		const trip = db
			.insert(tags)
			.values({ name: 'Lissabon', startDate: `${MONTH}-10`, endDate: `${MONTH}-17`, hue: 200 })
			.returning()
			.get().id;
		const hotel = book(`${MONTH}-11`, 32_000, 'Reizen', 'Hotel Alfama');
		syncAutoTags(db, [hotel]);
		const tag = monthFacts(db, MONTH).facts.find((f) => f.soort === 'tag');
		expect(tag).toMatchObject({ naam: 'Lissabon', nu: 32_000, nieuw: true });
		expect(trip).toBeTruthy();
	});
});

describe('samenvatting schrijven en bewaren', () => {
	it('stuurt alleen de feiten naar Haiku en bewaart de ingevulde zinnen', async () => {
		history();
		const { client, create } = haiku();
		const s = await monthSummary(db, MONTH, TODAY, opts(client));
		expect(s).toMatchObject({ source: 'haiku', reason: null, callsLeft: 4 });
		expect(s!.sentences[0]!.tekst.replace(/\s/g, ' ')).toBe(
			'Uit eten en bezorgen kostte € 184, tegenover gemiddeld € 90.'
		);
		const request = create.mock.calls[0]![0];
		expect(request).not.toHaveProperty('tools');
		expect(JSON.stringify(request)).not.toMatch(/Omschrijving|ALBERT HEIJN|NL\d\d[A-Z]{4}/);
		expect(calls()).toMatchObject([
			{ feature: 'samenvatting', outcome: 'geschreven', inputTokens: 800, wrong: 0 }
		]);
	});

	it('opent de maand opnieuw zonder nieuwe aanroep; een late import geeft een nieuwe', async () => {
		history();
		const { client, create } = haiku();
		await monthSummary(db, MONTH, TODAY, opts(client));
		await monthSummary(db, MONTH, TODAY, opts(client));
		expect(create).toHaveBeenCalledOnce();

		book(`${MONTH}-28`, 5_000, 'Uit eten en bezorgen', 'Pizzeria Roma');
		const s = await monthSummary(db, MONTH, TODAY, opts(client));
		expect(create).toHaveBeenCalledTimes(2);
		expect(s!.facts[0]!.nu).toBe(23_400);
		expect(s!.callsLeft).toBe(3);
	});

	it('twee keer tegelijk openen geeft één aanroep', async () => {
		history();
		const { client, create } = haiku();
		await Promise.all([
			monthSummary(db, MONTH, TODAY, opts(client)),
			monthSummary(db, MONTH, TODAY, opts(client))
		]);
		expect(create).toHaveBeenCalledOnce();
	});

	it('niets opvallends: geen aanroep en de vaste zin', async () => {
		for (const m of ['2026-06', '2026-07', '2026-08', MONTH])
			book(`${m}-05`, 30_000, 'Boodschappen', 'Albert Heijn');
		const { client, create } = haiku();
		const s = await monthSummary(db, MONTH, TODAY, opts(client));
		expect(s).toMatchObject({ source: 'leeg', sentences: [] });
		expect(create).not.toHaveBeenCalled();
	});

	it('geen kaart voor een lopende maand of een maand zonder gegevens', async () => {
		const { client, create } = haiku();
		expect(await monthSummary(db, '2026-10', TODAY, opts(client))).toBeNull();
		expect(await monthSummary(db, '2026-05', TODAY, opts(client))).toBeNull();
		expect(create).not.toHaveBeenCalled();
	});

	it('een zin die de controle niet haalt, geeft de vaste tekst', async () => {
		history();
		const { client } = haiku('{f1.naam} steeg met 104 procent.');
		const s = await monthSummary(db, MONTH, TODAY, opts(client));
		expect(s).toMatchObject({ source: 'vast', reason: 'controle' });
		expect(s!.sentences).toHaveLength(2);
		expect(s!.sentences[0]!.tekst).toMatch(/^Uit eten en bezorgen kostte/);
		expect(calls()).toMatchObject([{ outcome: 'controle', failure: 'cijfer' }]);
	});

	it('een fout van de API geeft de vaste tekst', async () => {
		history();
		const create = vi.fn(async () => {
			throw new Error('overbelast');
		});
		const s = await monthSummary(
			db,
			MONTH,
			TODAY,
			opts({ messages: { create } } as unknown as AiClient)
		);
		expect(s).toMatchObject({ source: 'vast', reason: 'fout' });
		expect(calls()).toMatchObject([{ outcome: 'fout', costNanoUsd: 0 }]);
	});

	it('zonder sleutel de vaste tekst, en vanzelf Haiku zodra die er is', async () => {
		history();
		expect(await monthSummary(db, MONTH, TODAY, opts(null))).toMatchObject({
			source: 'vast',
			reason: 'geen_sleutel'
		});
		const { client, create } = haiku();
		expect(await monthSummary(db, MONTH, TODAY, opts(client))).toMatchObject({ source: 'haiku' });
		expect(create).toHaveBeenCalledOnce();
	});
});

describe('maandbudget en grenzen', () => {
	it('is het AI-budget op, dan de vaste tekst zonder aanroep; bonnen tellen mee', async () => {
		history();
		// Een bon van $ 6 deze maand, boven het standaardbudget van $ 5
		telemetry
			.insert(receiptReads)
			.values({
				at: '2026-10-02T08:00:00.000Z',
				receiptId: null,
				model: 'claude-haiku-5-5',
				parts: 1,
				inputTokens: 0,
				outputTokens: 0,
				costNanoUsd: 6_000_000_000,
				durationMs: 1000,
				outcome: 'zeker'
			})
			.run();
		expect(aiBudget(telemetry, NOW, 500)).toMatchObject({ month: '2026-10', available: false });
		const { client, create } = haiku();
		const s = await monthSummary(db, MONTH, TODAY, opts(client));
		expect(s).toMatchObject({ source: 'vast', reason: 'budget' });
		expect(create).not.toHaveBeenCalled();
		await expect(summaryAgain(db, MONTH, TODAY, opts(client))).rejects.toThrow(
			'Het AI-budget van deze maand is op.'
		);
	});

	it('kosten van vorige maand tellen niet mee', () => {
		telemetry
			.insert(aiCalls)
			.values({
				at: '2026-09-30T21:00:00.000Z', // 23:00 in Nederland: nog september
				ref: crypto.randomUUID(),
				feature: 'samenvatting',
				model: 'claude-haiku-5-5',
				inputTokens: 0,
				outputTokens: 0,
				costNanoUsd: 9_000_000_000,
				durationMs: 1,
				outcome: 'geschreven'
			})
			.run();
		expect(aiBudget(telemetry, NOW, 500)).toMatchObject({ spentNanoUsd: 0, available: true });
	});

	it('opnieuw hooguit vijf keer per maand; daarna blijft de tekst staan', async () => {
		history();
		const { client, create } = haiku();
		await monthSummary(db, MONTH, TODAY, opts(client));
		for (let i = 0; i < 4; i++) await summaryAgain(db, MONTH, TODAY, opts(client));
		expect(create).toHaveBeenCalledTimes(5);
		await expect(summaryAgain(db, MONTH, TODAY, opts(client))).rejects.toThrow(ValidationError);
		expect(create).toHaveBeenCalledTimes(5);

		// Een late import na vijf keer: de vaste tekst met de nieuwe cijfers
		book(`${MONTH}-28`, 5_000, 'Uit eten en bezorgen', 'Pizzeria Roma');
		const s = await monthSummary(db, MONTH, TODAY, opts(client));
		expect(s).toMatchObject({ source: 'vast', reason: 'limiet', callsLeft: 0 });
		expect(create).toHaveBeenCalledTimes(5);
	});
});

describe('klopt niet', () => {
	it('bewaart het bij de zin en telt het één keer in de telemetrie', async () => {
		history();
		const { client } = haiku();
		await monthSummary(db, MONTH, TODAY, opts(client));
		markSentenceWrong(db, MONTH, 0, () => telemetry);
		markSentenceWrong(db, MONTH, 0, () => telemetry);
		const row = db.select().from(monthSummaries).get()!;
		expect((row.sentences as { wrong: boolean }[])[0]!.wrong).toBe(true);
		expect(calls()).toMatchObject([{ wrong: 1 }]);
		expect(() => markSentenceWrong(db, MONTH, 3, () => telemetry)).toThrow(ValidationError);
	});

	it('de acties op de pagina: klopt niet en opnieuw', async () => {
		history();
		const { client, create } = haiku();
		useAiClient(() => client);
		await monthSummary(db, MONTH, TODAY, opts(client));

		const post = (action: string, form: Record<string, string> = {}) => {
			const event = fakeEvent({
				path: `/afsluiting/${MONTH}?/${action}`,
				routeId: '/(app)/afsluiting/[maand]',
				method: 'POST',
				params: { maand: MONTH }
			});
			const body = new FormData();
			for (const [k, v] of Object.entries(form)) body.set(k, v);
			return { ...event, request: new Request(event.request.url, { method: 'POST', body }) };
		};

		expect(await actions.summaryWrong!(post('summaryWrong', { index: '0' }) as never)).toEqual({
			summaryWrong: 0
		});
		const bad = await actions.summaryWrong!(post('summaryWrong', { index: '9' }) as never);
		expect(bad).toMatchObject({ status: 400 });
		expect(await actions.summaryAgain!(post('summaryAgain') as never)).toEqual({
			summaryAgain: true
		});
		expect(create).toHaveBeenCalledTimes(2);
	});
});
