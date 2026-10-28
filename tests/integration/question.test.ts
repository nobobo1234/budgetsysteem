// Het vraagveld met een echte database en een nagebootst model (spec: Vraagveld): wat er naar het
// model gaat, wat er bewaard wordt (nooit het resultaat), verduidelijken en kiezen, opnieuw
// uitrekenen zonder model, "klopt niet", de telemetrie en de grenzen. Nooit een echte API-aanroep.
import type Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiClient, type AiClient } from '../../src/lib/server/ai/client.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import { questions } from '../../src/lib/server/db/schema.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';
import {
	askAgain,
	askQuestion,
	choose,
	markWrong,
	questionHistory,
	questionLimiter,
	unavailable
} from '../../src/lib/server/question/index.ts';
import type { QuestionOutput } from '../../src/lib/server/question/translator.ts';
import type { TelemetryDB } from '../../src/lib/server/telemetry/db.ts';
import { aiCalls, receiptReads } from '../../src/lib/server/telemetry/schema.ts';
import type { QuestionResult } from '../../src/lib/question.ts';
import { actions, load } from '../../src/routes/(app)/analyses/vraag/+page.server.ts';
import { buildFixture } from '../fixtures/vraag/fixture.ts';
import { fakeEvent, tempDatabase, tempTelemetry } from './helpers.ts';

// De fixture loopt tot en met 21 oktober 2026; 10:00 UTC is dan 12:00 in Nederland
const NOW = new Date('2026-10-21T10:00:00Z');

let db: DB;
let telemetry: TelemetryDB;
let cleanups: (() => void)[] = [];
beforeEach(() => {
	const d = tempDatabase();
	const t = tempTelemetry();
	db = d.db;
	telemetry = t.telemetry;
	cleanups = [d.cleanup, t.cleanup];
	buildFixture(db);
	questionLimiter.clear();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.useRealTimers();
	useAiClient(null);
	for (const c of cleanups) c();
});

const EMPTY: QuestionOutput = {
	soort: 'vraag',
	maat: 'uitgegeven',
	periode: 'deze_maand',
	van: '',
	tot: '',
	categorieen: [],
	groepen: [],
	tegenpartij: '',
	tag: '',
	rekening: '',
	productgroep: 'geen',
	groeperen: 'geen',
	sorteren: 'bedrag_aflopend',
	limiet: 0,
	aannames: [],
	verduidelijking: '',
	keuzes: [],
	reden: ''
};

function reply(out: Partial<QuestionOutput> | string): Anthropic.Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'claude-haiku-5-5',
		content: [
			{
				type: 'text',
				text: typeof out === 'string' ? out : JSON.stringify({ ...EMPTY, ...out }),
				citations: null
			}
		],
		stop_reason: 'end_turn',
		stop_sequence: null,
		usage: { input_tokens: 2000, output_tokens: 160 }
	} as Anthropic.Message;
}

function fake(...replies: Anthropic.Message[]) {
	const create = vi.fn(async () => replies.shift() ?? reply({ soort: 'kan_niet', reden: 'Op.' }));
	return { client: { messages: { create } } as unknown as AiClient, create };
}

const opts = (client: AiClient | null) => ({ client, telemetry: () => telemetry, now: NOW });

function expectAnswer(r: QuestionResult) {
	if (r.kind !== 'beantwoord') throw new Error(`verwacht een antwoord, kreeg ${r.kind}`);
	return r;
}

const calls = () => telemetry.select().from(aiCalls).all();
const stored = (id: string) => db.select().from(questions).where(eq(questions.id, id)).get()!;

describe('een vraag stellen', () => {
	it('het model vertaalt, code rekent; bewaard zonder resultaat', async () => {
		const { client, create } = fake(
			reply({
				categorieen: ['Uit eten en bezorgen'],
				periode: 'dit_jaar',
				aannames: ['uit eten = de categorie Uit eten en bezorgen']
			})
		);
		const r = expectAnswer(
			await askQuestion(db, 'Hoeveel gaf ik dit jaar uit aan uit eten?', opts(client))
		);
		expect(r.answer.value).toBe(71100);
		expect(r.answer.sentence.replace(/\s/g, ' ')).toBe(
			'€ 711,00 aan Uit eten en bezorgen, 1 januari tot en met 21 oktober 2026'
		);
		expect(r.answer.assumptions[0]).toBe('dit jaar = 1 januari tot en met 21 oktober 2026');
		expect(r.answer.assumptions.at(-1)).toBe('uit eten = de categorie Uit eten en bezorgen');

		// Naar het model: de vraag en eigen namen, nooit tegenpartijen, omschrijvingen of bedragen
		const sent = JSON.stringify(create.mock.calls[0]);
		expect(sent).toContain('Hoeveel gaf ik dit jaar uit aan uit eten?');
		expect(sent).toContain('2026-10-21');
		expect(sent).not.toMatch(/Albert Heijn|ALBERT|Pizzeria|Thuisbezorgd|NL\d\d[A-Z]{4}/);
		expect(sent).not.toContain('711');

		const row = stored(r.id);
		expect(row).toMatchObject({ kind: 'beantwoord', reason: null, rowCount: null, verdict: null });
		expect(JSON.stringify(row)).not.toContain('71100');
		expect(row.format).toMatchObject({ soort: 'vraag', maat: 'uitgegeven' });

		expect(calls()).toEqual([
			expect.objectContaining({
				feature: 'vraag',
				outcome: 'beantwoord',
				model: 'claude-haiku-5-5',
				inputTokens: 2000,
				outputTokens: 160,
				costNanoUsd: 2000 * 100 + 160 * 500,
				failure: null,
				ref: row.telemetryRef
			})
		]);
	});

	it('een categorie die niet bestaat: kan niet, met een voorbeeld dat wel kan', async () => {
		const { client } = fake(reply({ categorieen: ['Snoepgoed'] }));
		const r = await askQuestion(db, 'Hoeveel aan snoep?', opts(client));
		expect(r).toMatchObject({ kind: 'kan_niet', reason: expect.stringContaining('Snoepgoed') });
		expect(stored(r.id)).toMatchObject({ kind: 'kan_niet', reason: 'categorie' });
		expect(calls()[0]).toMatchObject({ outcome: 'kan_niet', failure: 'categorie' });
	});

	it('het model zegt zelf dat het niet kan', async () => {
		const { client } = fake(reply({ soort: 'kan_niet', reden: 'Dat is een voorspelling.' }));
		const r = await askQuestion(db, 'Hoeveel ga ik volgend jaar uitgeven?', opts(client));
		expect(r).toMatchObject({ kind: 'kan_niet', reason: 'Dat is een voorspelling.' });
		expect(stored(r.id)).toMatchObject({ kind: 'kan_niet', reason: 'model' });
	});

	it('een antwoord dat niet door de controle komt, geeft geen getal', async () => {
		const { client } = fake(reply({ aannames: ['ongeveer 700 euro'] }), reply('geen json'));
		const first = await askQuestion(db, 'Hoeveel deze maand?', opts(client));
		expect(first).toMatchObject({ kind: 'kan_niet' });
		expect(stored(first.id)).toMatchObject({ kind: 'kan_niet', reason: 'controle', format: null });
		const second = await askQuestion(db, 'Hoeveel deze maand?', opts(client));
		expect(stored(second.id)).toMatchObject({ reason: 'ongeldig' });
		expect(calls().map((c) => [c.outcome, c.failure])).toEqual([
			['controle', 'cijfer'],
			['ongeldig', null]
		]);
	});
});

describe('verduidelijken en kiezen', () => {
	it('code vindt twee kappers; een keuze rekent meteen uit, zonder model', async () => {
		const { client, create } = fake(reply({ tegenpartij: 'kapper', periode: 'dit_jaar' }));
		const r = await askQuestion(db, 'Hoeveel bij de kapper?', opts(client));
		expect(r).toMatchObject({
			kind: 'verduidelijken',
			clarification: { source: 'code', choices: ['Kapper Knip Test', 'Kapper Stijl Test'] }
		});
		expect(calls()[0]).toMatchObject({ outcome: 'verduidelijken', failure: 'tegenpartij' });

		const chosen = expectAnswer(await choose(db, r.id, 1, opts(client)));
		expect(chosen.answer.value).toBe(3100);
		expect(create).toHaveBeenCalledTimes(1);
		// Bewaard met de gekozen naam, zodat opnieuw uitrekenen geen keuze meer nodig heeft
		expect(stored(r.id)).toMatchObject({ kind: 'beantwoord' });
		const again = expectAnswer(await askAgain(db, r.id, opts(client)));
		expect(again.answer.value).toBe(3100);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it('het model vraagt terug; een keuze stelt de vraag opnieuw met de keuze erbij', async () => {
		const { client, create } = fake(
			reply({
				soort: 'verduidelijken',
				verduidelijking: 'Bedoel je boodschappen of uit eten?',
				keuzes: ['Boodschappen', 'Uit eten en bezorgen']
			}),
			reply({ categorieen: ['Boodschappen'] })
		);
		const r = await askQuestion(db, 'Hoeveel aan eten?', opts(client));
		expect(r).toMatchObject({ kind: 'verduidelijken', clarification: { source: 'model' } });
		const chosen = expectAnswer(await choose(db, r.id, 0, opts(client)));
		expect(chosen.question).toBe('Hoeveel aan eten? (Boodschappen)');
		expect(JSON.stringify(create.mock.calls[1])).toContain('Gekozen: Boodschappen');
		await expect(choose(db, r.id, 3, opts(client))).rejects.toThrow(ValidationError);
	});
});

describe('eerdere vragen', () => {
	it('opnieuw uitrekenen zonder model; de geschiedenis heeft vraag, soort en aannames', async () => {
		const { client, create } = fake(reply({ categorieen: ['Boodschappen'] }));
		const r = expectAnswer(await askQuestion(db, 'Boodschappen deze maand?', opts(client)));
		const again = expectAnswer(await askAgain(db, r.id, opts(client)));
		expect(again.answer.value).toBe(r.answer.value);
		expect(create).toHaveBeenCalledTimes(1);
		expect(questionHistory(db)).toEqual([
			{
				id: r.id,
				question: 'Boodschappen deze maand?',
				kind: 'beantwoord',
				assumptions: r.answer.assumptions,
				createdAt: expect.any(String)
			}
		]);
	});

	it('alleen de laatste 100 blijven bewaard', async () => {
		const { client } = fake();
		for (let i = 0; i < 25; i++) {
			questionLimiter.clear();
			await askQuestion(db, `vraag ${i}`, opts(client));
		}
		db.insert(questions)
			.values(
				Array.from({ length: 90 }, (_, i) => ({
					question: `oud ${i}`,
					kind: 'kan_niet' as const,
					assumptions: [],
					durationMs: 1,
					createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`
				}))
			)
			.run();
		await askQuestion(db, 'de nieuwste', opts(client));
		expect(db.select().from(questions).all()).toHaveLength(100);
		expect(questionHistory(db, 1)[0]!.question).toBe('de nieuwste');
	});

	it('"klopt niet" telt één keer, in de vraag en de telemetrie', async () => {
		const { client } = fake(reply({}));
		const r = await askQuestion(db, 'Hoeveel deze maand?', opts(client));
		markWrong(db, r.id, () => telemetry);
		markWrong(db, r.id, () => telemetry);
		expect(stored(r.id).verdict).toBe('fout');
		expect(calls()[0]!.wrong).toBe(1);
		const again = expectAnswer(await askAgain(db, r.id, opts(client)));
		expect(again.wrong).toBe(true);
	});
});

describe('grenzen', () => {
	it('een vraag is hooguit 300 tekens', async () => {
		const { client, create } = fake();
		await expect(askQuestion(db, 'a'.repeat(301), opts(client))).rejects.toThrow(/300 tekens/);
		await expect(askQuestion(db, '   ', opts(client))).rejects.toThrow(ValidationError);
		expect(create).not.toHaveBeenCalled();
	});

	it('30 vragen per uur', async () => {
		const { client, create } = fake();
		for (let i = 0; i < 30; i++) await askQuestion(db, `vraag ${i}`, opts(client));
		await expect(askQuestion(db, 'nog een', opts(client))).rejects.toThrow(/dertig vragen/);
		expect(create).toHaveBeenCalledTimes(30);
	});

	it('zonder sleutel of met het maandbudget op: geen aanroep, wel een uitleg', async () => {
		const { client, create } = fake();
		expect(unavailable(opts(null))).toBe('geen_sleutel');
		await expect(askQuestion(db, 'Hoeveel?', opts(null))).rejects.toThrow(/sleutel/);
		// Een bon die het hele maandbudget opmaakte
		telemetry
			.insert(receiptReads)
			.values({
				model: 'claude-haiku-5-5',
				parts: 1,
				inputTokens: 1,
				outputTokens: 1,
				costNanoUsd: 10_000_000_000_000,
				durationMs: 1,
				outcome: 'zeker',
				at: NOW.toISOString()
			})
			.run();
		expect(unavailable(opts(client))).toBe('budget');
		await expect(askQuestion(db, 'Hoeveel?', opts(client))).rejects.toThrow(/AI-budget/);
		expect(create).not.toHaveBeenCalled();
	});
});

describe('de pagina', () => {
	function post(action: string, form: Record<string, string>) {
		const event = fakeEvent({
			path: `/analyses/vraag?/${action}`,
			routeId: '/(app)/analyses/vraag',
			method: 'POST'
		});
		const body = new FormData();
		for (const [k, v] of Object.entries(form)) body.set(k, v);
		return { ...event, request: new Request(event.request.url, { method: 'POST', body }) } as never;
	}

	it('vragen, opnieuw, klopt niet; foute invoer is een 400', async () => {
		const { client } = fake(reply({ categorieen: ['Boodschappen'] }));
		useAiClient(() => client);
		const asked = (await actions.ask!(post('ask', { vraag: 'Boodschappen deze maand?' }))) as {
			result: QuestionResult;
		};
		expect(asked.result.kind).toBe('beantwoord');
		const id = asked.result.id;
		expect(await actions.again!(post('again', { id }))).toMatchObject({ result: { id } });
		expect(await actions.wrong!(post('wrong', { id }))).toEqual({ wrong: id });
		expect(await actions.again!(post('again', { id: 'geen-uuid' }))).toMatchObject({ status: 400 });
		expect(await actions.choose!(post('choose', { id, keuze: '0' }))).toMatchObject({
			status: 400
		});
		expect(await actions.ask!(post('ask', { vraag: 'a'.repeat(301) }))).toMatchObject({
			status: 400
		});
		const page = (await load({} as never)) as { history: unknown[] };
		expect(page.history).toHaveLength(1);
	});
});
