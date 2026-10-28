import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../../semantic/resolve.ts';
import type { AiClient } from '../ai/client.ts';
import {
	buildQuestionRequest,
	fromModel,
	QUESTION_MAX_TOKENS,
	QUESTION_SYSTEM_PROMPT,
	QUESTION_VARIANT,
	QUESTION_VARIANTS,
	translateQuestion,
	type QuestionOutput
} from './translator.ts';

// Het model is altijd nagebootst: deze tests doen nooit een echte API-aanroep.

const TODAY = '2026-10-21';

const CATALOG: Catalog = {
	categories: [
		{ id: 'c1', name: 'Boodschappen', group: 'Dagelijks', countsForBudget: true, income: false },
		{ id: 'c2', name: 'Inkomen', group: 'Buiten budget', countsForBudget: false, income: true }
	],
	tags: [{ id: 't1', name: 'Lissabon' }],
	accounts: [{ id: 'a1', name: 'Revolut', alias: 'rev' }],
	// Gaan nooit naar het model
	counterparties: ['Albert Heijn', 'Geheime Winkel']
};

const EMPTY: QuestionOutput = {
	soort: 'vraag',
	maat: 'uitgegeven',
	periode: 'dit_jaar',
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

function message(
	text: string,
	opts: { stop?: Anthropic.StopReason; input?: number; output?: number } = {}
): Anthropic.Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: QUESTION_VARIANT.model,
		content: [
			{ type: 'thinking', thinking: '', signature: 'sig' },
			{ type: 'text', text, citations: null }
		],
		stop_reason: opts.stop ?? 'end_turn',
		stop_sequence: null,
		usage: { input_tokens: opts.input ?? 1800, output_tokens: opts.output ?? 150 }
	} as Anthropic.Message;
}

function client(reply: Anthropic.Message | Error) {
	const create = vi.fn(async () => {
		if (reply instanceof Error) throw reply;
		return reply;
	});
	return { client: { messages: { create } } as unknown as AiClient, create };
}

const clock = () => {
	let t = 0;
	return () => (t += 400);
};

describe('verzoek voor een vraag', () => {
	it('alleen de vraag, de eigen namen en de datum; geen tools', () => {
		const req = buildQuestionRequest('Hoeveel bij de AH?', CATALOG, TODAY);
		expect(req.model).toBe(QUESTION_VARIANT.model);
		expect(req.max_tokens).toBe(QUESTION_MAX_TOKENS);
		expect(req.system).toBe(QUESTION_SYSTEM_PROMPT);
		expect(req).not.toHaveProperty('tools');
		const text = JSON.stringify(req.messages);
		expect(text).toContain('Hoeveel bij de AH?');
		expect(text).toContain('2026-10-21');
		expect(text).toContain('Boodschappen');
		expect(text).toContain('Lissabon');
		expect(text).toContain('Revolut');
		// Nooit tegenpartijen, bedragen of resultaten
		expect(text).not.toContain('Albert Heijn');
		expect(text).not.toContain('Geheime Winkel');
		expect(text).not.toMatch(/€|\d+,\d{2}/);
	});

	it('het schema heeft geen grenzen die structured outputs weigert', () => {
		const schema = JSON.stringify(buildQuestionRequest('x', CATALOG, TODAY).output_config);
		expect(schema).toContain('"json_schema"');
		expect(schema).not.toMatch(/"(minimum|maximum|maxLength|maxItems|\$schema)"/);
	});

	it('elke variant van de eval: model en effort', () => {
		const effortOf = (i: number) =>
			buildQuestionRequest('x', CATALOG, TODAY, { variant: QUESTION_VARIANTS[i] }).output_config
				?.effort;
		expect(QUESTION_VARIANTS.map((v) => v.model)).toEqual([
			'claude-haiku-5-5',
			'claude-haiku-5-5',
			'claude-sonnet-5-5'
		]);
		// De standaard-effort: niets meesturen
		expect(effortOf(0)).toBeUndefined();
		expect(effortOf(1)).toBe('high');
		expect(effortOf(2)).toBeUndefined();
	});

	it('een eerdere verduidelijking gaat mee met de gekozen keuze', () => {
		const req = buildQuestionRequest('Hoeveel aan eten?', CATALOG, TODAY, {
			followUp: { clarification: 'Boodschappen of uit eten?', choice: 'Boodschappen' }
		});
		expect(JSON.stringify(req.messages)).toContain('Gekozen: Boodschappen');
	});
});

describe('van het model naar het vraagformaat', () => {
	it('lege velden worden null, een eigen periode wordt van en tot', () => {
		const r = fromModel({
			...EMPTY,
			periode: 'eigen',
			van: '2026-03',
			tot: '2026-03',
			categorieen: ['Boodschappen'],
			limiet: 5,
			groeperen: 'tegenpartij'
		});
		expect(r).toEqual({
			ok: true,
			format: {
				soort: 'vraag',
				maat: 'uitgegeven',
				periode: { van: '2026-03', tot: '2026-03' },
				filters: {
					categorieen: ['Boodschappen'],
					groepen: [],
					tegenpartij: null,
					tag: null,
					rekening: null,
					productgroep: null
				},
				groeperen: 'tegenpartij',
				sorteren: 'bedrag_aflopend',
				limiet: 5,
				aannames: []
			}
		});
	});

	it('een tegenpartij gaat door modelName', () => {
		const r = fromModel({ ...EMPTY, tegenpartij: 'bol.com' });
		expect(r.ok && r.format.soort === 'vraag' && r.format.filters.tegenpartij).toBe('bol');
	});

	it('geen cijfers of links in tekst die in beeld komt', () => {
		expect(fromModel({ ...EMPTY, aannames: ['dit jaar = 2026'] })).toEqual({
			ok: false,
			failure: 'cijfer'
		});
		expect(
			fromModel({ ...EMPTY, soort: 'kan_niet', reden: 'Kijk op https://voorbeeld.nl' })
		).toEqual({ ok: false, failure: 'domein' });
		expect(
			fromModel({
				...EMPTY,
				soort: 'verduidelijken',
				verduidelijking: 'Welk jaar?',
				keuzes: ['2025', '2026']
			})
		).toEqual({ ok: false, failure: 'cijfer' });
	});

	it('een verduidelijking en een weigering', () => {
		expect(
			fromModel({
				...EMPTY,
				soort: 'verduidelijken',
				verduidelijking: 'Bedoel je boodschappen of uit eten?',
				keuzes: ['Boodschappen', 'Uit eten']
			})
		).toEqual({
			ok: true,
			format: {
				soort: 'verduidelijken',
				vraag: 'Bedoel je boodschappen of uit eten?',
				keuzes: ['Boodschappen', 'Uit eten']
			}
		});
		expect(fromModel({ ...EMPTY, soort: 'kan_niet', reden: 'Dat is een voorspelling.' })).toEqual({
			ok: true,
			format: { soort: 'kan_niet', reden: 'Dat is een voorspelling.' }
		});
	});

	it('een vraag zonder maat of een verduidelijking met één keuze is ongeldig', () => {
		expect(fromModel({ ...EMPTY, maat: 'geen' })).toEqual({ ok: false, failure: 'schema' });
		expect(
			fromModel({ ...EMPTY, soort: 'verduidelijken', verduidelijking: 'Welke?', keuzes: ['een'] })
		).toEqual({ ok: false, failure: 'schema' });
	});
});

describe('vertalen met een nagebootst model', () => {
	it('een geldig antwoord wordt het vraagformaat, met tokens, kosten en duur', async () => {
		const { client: c } = client(
			message(JSON.stringify({ ...EMPTY, categorieen: ['Boodschappen'] }))
		);
		const r = await translateQuestion(c, 'Hoeveel aan boodschappen?', CATALOG, TODAY, {
			clock: clock()
		});
		expect(r.ok).toBe(true);
		expect(r.usage).toEqual({
			model: 'claude-haiku-5-5',
			inputTokens: 1800,
			outputTokens: 150,
			costNanoUsd: 1800 * 100 + 150 * 500,
			durationMs: 400
		});
	});

	it('weigering, afgekapt, geen JSON, een controle die faalt en een API-fout', async () => {
		const ask = async (reply: Anthropic.Message | Error) =>
			translateQuestion(client(reply).client, 'x', CATALOG, TODAY, { clock: clock() });
		const valid = JSON.stringify(EMPTY);
		expect((await ask(message(valid, { stop: 'refusal' }))).ok).toBe(false);
		expect(await ask(message(valid, { stop: 'refusal' }))).toMatchObject({ outcome: 'weigering' });
		expect(await ask(message(valid, { stop: 'max_tokens' }))).toMatchObject({
			outcome: 'afgekapt'
		});
		expect(await ask(message('geen json'))).toMatchObject({ outcome: 'ongeldig' });
		expect(await ask(message(JSON.stringify({ ...EMPTY, extra: 1 })))).toMatchObject({
			outcome: 'ongeldig'
		});
		expect(
			await ask(message(JSON.stringify({ ...EMPTY, aannames: ['ongeveer 12 euro'] })))
		).toMatchObject({ outcome: 'controle', failure: 'cijfer' });
		const failed = await ask(new Error('netwerk'));
		expect(failed).toMatchObject({ outcome: 'fout', usage: { costNanoUsd: 0, inputTokens: 0 } });
	});

	it('Sonnet kost meer per token dan Haiku', async () => {
		const { client: c } = client(message(JSON.stringify(EMPTY)));
		const r = await translateQuestion(c, 'x', CATALOG, TODAY, { variant: QUESTION_VARIANTS[2] });
		expect(r.usage.costNanoUsd).toBe(1800 * 2000 + 150 * 10_000);
	});
});
