import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { AiClient } from '../ai/client.ts';
import type { Fact } from '../../summary.ts';
import {
	buildSummaryRequest,
	SUMMARY_MAX_TOKENS,
	SUMMARY_MODEL,
	SUMMARY_SYSTEM_PROMPT,
	writeSummary
} from './writer.ts';

// Haiku is altijd nagebootst: deze tests doen nooit een echte API-aanroep.

const FACTS: Fact[] = [
	{
		id: 'f1',
		soort: 'tegenpartij',
		naam: 'Thuisbezorgd',
		nu: 6_200,
		gem3: 2_000,
		gem6: 1_500,
		verschil: 4_200,
		richting: 'hoger',
		sinds: null,
		nieuw: false
	}
];

function message(
	text: string,
	opts: { stop?: Anthropic.StopReason; input?: number; output?: number } = {}
): Anthropic.Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: SUMMARY_MODEL,
		content: [
			{ type: 'thinking', thinking: '', signature: 'sig' },
			{ type: 'text', text, citations: null }
		],
		stop_reason: opts.stop ?? 'end_turn',
		stop_sequence: null,
		usage: { input_tokens: opts.input ?? 900, output_tokens: opts.output ?? 120 }
	} as Anthropic.Message;
}

function client(reply: Anthropic.Message | Error) {
	const create = vi.fn(async () => {
		if (reply instanceof Error) throw reply;
		return reply;
	});
	return { client: { messages: { create } } as unknown as AiClient, create };
}

const zinnen = (tekst: string) => JSON.stringify({ zinnen: [{ tekst, feiten: ['f1'] }] });
const clock = () => {
	let t = 0;
	return () => (t += 600);
};

describe('verzoek voor de samenvatting', () => {
	it('alleen de feiten, zonder tools, met het vaste schema', () => {
		const req = buildSummaryRequest(FACTS);
		expect(req.model).toBe(SUMMARY_MODEL);
		expect(req.max_tokens).toBe(SUMMARY_MAX_TOKENS);
		expect(req.system).toBe(SUMMARY_SYSTEM_PROMPT);
		expect(req).not.toHaveProperty('tools');
		expect(req.output_config?.format?.type).toBe('json_schema');
		const content = req.messages[0]!.content as string;
		expect(content).toContain(
			'{"id":"f1","soort":"tegenpartij","naam":"Thuisbezorgd","nu":6200,"gem3":2000,"gem6":1500,"verschil":4200,"richting":"hoger","sinds":null,"nieuw":false}'
		);
	});

	it('het schema voor het model heeft geen lengtegrenzen', () => {
		const schema = JSON.stringify(buildSummaryRequest(FACTS).output_config?.format);
		expect(schema).not.toMatch(/maxLength|maxItems|minLength/);
		expect(schema).toContain('zinnen');
	});
});

describe('zinnen laten schrijven', () => {
	it('een zin die de controle haalt', async () => {
		const { client: c, create } = client(
			message(zinnen('{f1.naam} kostte {f1.nu}, ruim drie keer zo veel als gemiddeld.'))
		);
		const r = await writeSummary(c, FACTS, '2026-09', { clock: clock() });
		expect(create).toHaveBeenCalledOnce();
		expect(r.ok).toBe(true);
		expect(r.ok && r.sentences[0]!.tekst.replace(/\s/g, ' ')).toBe(
			'Thuisbezorgd kostte € 62, ruim drie keer zo veel als gemiddeld.'
		);
		expect(r.usage).toEqual({
			model: SUMMARY_MODEL,
			inputTokens: 900,
			outputTokens: 120,
			costNanoUsd: 900 * 100 + 120 * 500,
			durationMs: 600
		});
	});

	it('een vrij cijfer valt op de controle', async () => {
		const { client: c } = client(message(zinnen('{f1.naam} kostte 62 euro.')));
		const r = await writeSummary(c, FACTS, '2026-09');
		expect(r).toMatchObject({ ok: false, outcome: 'controle', failure: 'cijfer' });
	});

	it('een letterlijke naam die de app kent valt op de controle', async () => {
		const { client: c } = client(message(zinnen('{f1.naam} steeg, net als bij jumbo.')));
		const r = await writeSummary(c, FACTS, '2026-09', { names: ['Jumbo'] });
		expect(r).toMatchObject({ ok: false, outcome: 'controle', failure: 'naam' });
	});

	it('een weigering, afgekapte uitvoer en ongeldige JSON', async () => {
		const refused = await writeSummary(
			client(message('', { stop: 'refusal' })).client,
			FACTS,
			'2026-09'
		);
		expect(refused).toMatchObject({ ok: false, outcome: 'weigering' });
		const cut = await writeSummary(
			client(message('{"zin', { stop: 'max_tokens' })).client,
			FACTS,
			'2026-09'
		);
		expect(cut).toMatchObject({ ok: false, outcome: 'afgekapt' });
		const invalid = await writeSummary(client(message('geen json')).client, FACTS, '2026-09');
		expect(invalid).toMatchObject({ ok: false, outcome: 'ongeldig' });
		const extra = await writeSummary(
			client(message(JSON.stringify({ zinnen: [{ tekst: 'x', feiten: ['f1'] }], html: '<b>' })))
				.client,
			FACTS,
			'2026-09'
		);
		expect(extra.ok).toBe(false);
	});

	it('een fout van de API is een gewone uitkomst, zonder kosten', async () => {
		const r = await writeSummary(client(new Error('netwerk')).client, FACTS, '2026-09');
		expect(r).toMatchObject({
			ok: false,
			outcome: 'fout',
			usage: { inputTokens: 0, outputTokens: 0, costNanoUsd: 0 }
		});
	});
});
