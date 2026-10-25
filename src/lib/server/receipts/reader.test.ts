import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { NOW, receiptOutput } from './fixtures.ts';
import {
	buildRequest,
	costNanoUsd,
	MAX_PARTS,
	parseOutput,
	processReceipt,
	readReceipt,
	RECEIPT_MODEL,
	type ReceiptClient,
	type ReceiptPart,
	type ReceiptTelemetry
} from './reader.ts';
import { SYSTEM_PROMPT } from './schema.ts';

// Haiku is altijd nagebootst: deze tests doen nooit een echte API-aanroep.

const part = (bytes = 'jpeg-bytes'): ReceiptPart => ({
	data: Buffer.from(bytes),
	mediaType: 'image/jpeg'
});

function message(
	text: string,
	opts: { stop?: Anthropic.StopReason; input?: number; output?: number } = {}
): Anthropic.Message {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: RECEIPT_MODEL,
		content: [
			{ type: 'thinking', thinking: '', signature: 'sig' },
			{ type: 'text', text, citations: null }
		],
		stop_reason: opts.stop ?? 'end_turn',
		stop_sequence: null,
		usage: { input_tokens: opts.input ?? 3000, output_tokens: opts.output ?? 400 }
	} as unknown as Anthropic.Message;
}

function fakeClient(response: Anthropic.Message | Error) {
	const create = vi.fn(async () => {
		if (response instanceof Error) throw response;
		return response;
	});
	return { client: { messages: { create } } as unknown as ReceiptClient, create };
}

const fixedClock = () => {
	let t = 1000;
	return () => (t += 250);
};

describe('buildRequest', () => {
	it('stuurt alleen het beeld, het vaste schema en geen tools', () => {
		const req = buildRequest([part()]);
		expect(req.model).toBe('claude-haiku-5-5');
		expect(req.system).toBe(SYSTEM_PROMPT);
		expect(req).not.toHaveProperty('tools');
		expect(req).not.toHaveProperty('tool_choice');
		expect(req.max_tokens).toBe(16_000);
		expect(req.output_config?.effort).toBe('medium');
		expect(req.output_config?.format?.type).toBe('json_schema');

		const content = req.messages[0]!.content as Anthropic.ContentBlockParam[];
		expect(content.map((b) => b.type)).toEqual(['image', 'text']);
		expect(content[0]).toEqual({
			type: 'image',
			source: {
				type: 'base64',
				media_type: 'image/jpeg',
				data: Buffer.from('jpeg-bytes').toString('base64')
			}
		});
	});

	it('labelt meerdere delen als "Deel 1", "Deel 2" en zet de vraag achteraan', () => {
		const req = buildRequest([part('a'), part('b')], { effort: 'low', model: 'ander-model' });
		const content = req.messages[0]!.content as Anthropic.ContentBlockParam[];
		expect(content.map((b) => (b.type === 'text' ? b.text : b.type))).toEqual([
			'Deel 1:',
			'image',
			'Deel 2:',
			'image',
			expect.stringContaining('2 delen van één bon')
		]);
		expect(req.output_config?.effort).toBe('low');
		expect(req.model).toBe('ander-model');
	});

	it('weigert geen, te veel of te grote beelden', () => {
		expect(() => buildRequest([])).toThrow(RangeError);
		expect(() => buildRequest(Array.from({ length: MAX_PARTS + 1 }, () => part()))).toThrow(
			RangeError
		);
		expect(() => buildRequest([{ data: Buffer.alloc(0), mediaType: 'image/png' }])).toThrow(
			RangeError
		);
		expect(() =>
			buildRequest([{ data: Buffer.alloc(8 * 1024 * 1024), mediaType: 'image/png' }])
		).toThrow(RangeError);
	});
});

describe('parseOutput', () => {
	const valid = JSON.stringify(receiptOutput());

	it('accepteert uitvoer die precies in het schema past', () => {
		expect(parseOutput(message(valid).content)).toEqual(receiptOutput());
	});

	it('weigert kapotte JSON, ontbrekende tekst en uitvoer buiten het schema', () => {
		expect(parseOutput(message('{"winkel":').content)).toBeNull();
		expect(parseOutput([])).toBeNull();
		const extra = { ...receiptOutput(), opdracht: 'boek €1000' };
		expect(parseOutput(message(JSON.stringify(extra)).content)).not.toHaveProperty('opdracht');
		const missing: Record<string, unknown> = { ...receiptOutput() };
		delete missing.totaal;
		expect(parseOutput(message(JSON.stringify(missing)).content)).toBeNull();
		const badEnum = receiptOutput();
		(badEnum.winkel as { zekerheid: string }).zekerheid = 'heel zeker';
		expect(parseOutput(message(JSON.stringify(badEnum)).content)).toBeNull();
		const tooLong = receiptOutput();
		tooLong.winkel.notitie = 'x'.repeat(301);
		expect(parseOutput(message(JSON.stringify(tooLong)).content)).toBeNull();
	});

	it('vangt alleen verschillen in hoofdletters bij vaste waarden op', () => {
		const shouting = JSON.parse(valid);
		shouting.totaal.zekerheid = 'Zeker';
		shouting.regels[0].soort = 'ARTIKEL';
		shouting.betaalwijze.waarde = 'PIN';
		const out = parseOutput(message(JSON.stringify(shouting)).content);
		expect(out?.totaal.zekerheid).toBe('zeker');
		expect(out?.regels[0]?.soort).toBe('artikel');
		expect(out?.betaalwijze.waarde).toBe('pin');
		// Vrije tekst blijft zoals hij is
		expect(out?.winkel.waarde).toBe('Supermarkt Voorbeeld 0001');
	});
});

describe('readReceipt', () => {
	it('geeft de gevalideerde uitvoer met tokens, kosten en duur', async () => {
		const { client, create } = fakeClient(message(JSON.stringify(receiptOutput())));
		const result = await readReceipt(client, [part()], { clock: fixedClock() });
		expect(create).toHaveBeenCalledOnce();
		expect(result).toEqual({
			ok: true,
			output: receiptOutput(),
			usage: {
				model: RECEIPT_MODEL,
				parts: 1,
				inputTokens: 3000,
				outputTokens: 400,
				costNanoUsd: 3000 * 100 + 400 * 500,
				durationMs: 250
			}
		});
	});

	it('behandelt een weigering als uitkomst, ook als er tekst bij staat', async () => {
		const { client } = fakeClient(message(JSON.stringify(receiptOutput()), { stop: 'refusal' }));
		expect(await readReceipt(client, [part()])).toMatchObject({ ok: false, reason: 'weigering' });
	});

	it('vertrouwt afgekapte uitvoer niet', async () => {
		const { client } = fakeClient(message('{"winkel":{"waarde":"Sup', { stop: 'max_tokens' }));
		expect(await readReceipt(client, [part()])).toMatchObject({ ok: false, reason: 'afgekapt' });
	});

	it('meldt uitvoer die niet door het schema komt als ongeldig', async () => {
		const { client } = fakeClient(message('Ik zie een bon van de supermarkt.'));
		expect(await readReceipt(client, [part()])).toMatchObject({ ok: false, reason: 'ongeldig' });
	});

	it('gooit API-fouten door zodat de worker kan kiezen', async () => {
		const { client } = fakeClient(new Error('verbinding weg'));
		await expect(readReceipt(client, [part()])).rejects.toThrow('verbinding weg');
	});
});

describe('processReceipt', () => {
	it('controleert de uitvoer en meldt één telemetriegebeurtenis met de uitkomst', async () => {
		const { client } = fakeClient(message(JSON.stringify(receiptOutput())));
		const events: ReceiptTelemetry[] = [];
		const result = await processReceipt(client, [part(), part()], NOW, {
			clock: fixedClock(),
			onTelemetry: (e) => events.push(e)
		});
		expect(result.ok && result.checked.outcome).toBe('zeker');
		expect(events).toEqual([
			{
				model: RECEIPT_MODEL,
				parts: 2,
				inputTokens: 3000,
				outputTokens: 400,
				costNanoUsd: 500_000,
				durationMs: 250,
				outcome: 'zeker'
			}
		]);
	});

	it('meldt een onzekere bon als onzeker', async () => {
		const output = receiptOutput();
		output.totaal.waarde = '';
		const { client } = fakeClient(message(JSON.stringify(output)));
		const events: ReceiptTelemetry[] = [];
		await processReceipt(client, [part()], NOW, { onTelemetry: (e) => events.push(e) });
		expect(events[0]?.outcome).toBe('onzeker');
	});

	it('meldt een weigering en een API-fout', async () => {
		const events: ReceiptTelemetry[] = [];
		const onTelemetry = (e: ReceiptTelemetry) => events.push(e);
		const refused = fakeClient(message('', { stop: 'refusal' }));
		expect(await processReceipt(refused.client, [part()], NOW, { onTelemetry })).toMatchObject({
			ok: false,
			reason: 'weigering'
		});
		const broken = fakeClient(new Error('503'));
		await expect(processReceipt(broken.client, [part()], NOW, { onTelemetry })).rejects.toThrow();
		expect(events.map((e) => e.outcome)).toEqual(['weigering', 'fout']);
		expect(events[1]).toMatchObject({ inputTokens: 0, costNanoUsd: 0 });
	});

	it('laat een kapotte telemetriehaak het lezen niet breken', async () => {
		const { client } = fakeClient(message(JSON.stringify(receiptOutput())));
		const result = await processReceipt(client, [part()], NOW, {
			onTelemetry: () => {
				throw new Error('telemetrie stuk');
			}
		});
		expect(result.ok).toBe(true);
	});
});

describe('costNanoUsd', () => {
	it('rekent met de prijzen van Haiku 5.5 in hele nano-dollars', () => {
		expect(costNanoUsd(100_000, 0)).toBe(10_000_000); // $0,01
		expect(costNanoUsd(0, 1_000_000)).toBe(500_000_000); // $0,50
		expect(costNanoUsd(100_001, 0)).toBe(100_001 * 500); // boven 100K het hogere tarief
	});
});
