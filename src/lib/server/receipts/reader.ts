import type Anthropic from '@anthropic-ai/sdk';
import { toIsoDate } from '../../dates.ts';
import {
	checkList,
	checkReceipt,
	type CheckedList,
	type CheckedReceipt,
	type FieldStatus
} from './checks.ts';
import {
	outputJsonSchema,
	ReceiptOutputSchema,
	SYSTEM_PROMPT,
	userInstruction,
	type ReceiptOutput
} from './schema.ts';

// Eén bon (één of meer beelden) naar Claude Haiku 5.5 met het vaste JSON-schema. Haiku krijgt
// geen tools (spec: LLM01) en alleen de foto (LLM02); de uitvoer is onbetrouwbaar en gaat door
// Zod en de controles (LLM10). De client wordt meegegeven, zodat tests hem nabootsen en nooit
// een echte aanroep doen.

export const RECEIPT_MODEL = 'claude-haiku-5-5';
/** Ruim voor denken plus een lange bon; begrenst ook de kosten per aanroep (spec: LLM06). */
export const RECEIPT_MAX_TOKENS = 16_000;
/** Haiku 5.5 kent `effort`; `medium` is zijn standaard, hier expliciet zodat de eval hem kan variëren. */
export const RECEIPT_EFFORT = 'medium';
/** Lange bonnen in stukken plus meerdere foto's; ruim onder de 20 beelden per verzoek. */
export const MAX_PARTS = 10;
/** De API weigert beelden boven 10 MB base64, dus zo'n 7,5 MB ruw. */
const MAX_PART_BYTES = 7 * 1024 * 1024;

/**
 * Prijzen van Claude Haiku 5.5 in nano-dollar per token: $0,10 / $0,50 per miljoen tokens tot
 * 100K tokens prompt, $0,50 / $2,50 daarboven. Gehele getallen, zodat er nooit afgerond hoeft
 * te worden. Bron: https://platform.claude.com/docs/en/about-claude/pricing
 */
const PRICE_NANO_USD = {
	small: { input: 100, output: 500 },
	large: { input: 500, output: 2500 }
} as const;
const LARGE_PROMPT_TOKENS = 100_000;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ReceiptPart {
	data: Buffer;
	mediaType: 'image/jpeg' | 'image/png';
}

/** Alleen wat deze module van de SDK-client gebruikt; in tests een nagebootste versie. */
export interface ReceiptClient {
	messages: { create: Anthropic['messages']['create'] };
}

export interface ReadOptions {
	model?: string;
	effort?: Effort;
	/** Ontvangstdatum (JJJJ-MM-DD), voor "Vandaag" of een datum zonder jaar in een lijst. */
	received?: string;
	signal?: AbortSignal;
	/** Klok voor de duur; alleen voor tests. */
	clock?: () => number;
}

export interface ReadUsage {
	model: string;
	parts: number;
	inputTokens: number;
	outputTokens: number;
	costNanoUsd: number;
	durationMs: number;
}

export type ReadFailure = 'weigering' | 'afgekapt' | 'ongeldig';

export type ReadResult =
	| { ok: true; output: ReceiptOutput; usage: ReadUsage }
	| { ok: false; reason: ReadFailure; usage: ReadUsage };

export function costNanoUsd(inputTokens: number, outputTokens: number): number {
	const price = inputTokens > LARGE_PROMPT_TOKENS ? PRICE_NANO_USD.large : PRICE_NANO_USD.small;
	return inputTokens * price.input + outputTokens * price.output;
}

/** Het verzoek zelf, los gebouwd zodat tests kunnen nagaan wat er naar de API gaat. */
export function buildRequest(
	parts: ReceiptPart[],
	opts: Pick<ReadOptions, 'model' | 'effort' | 'received'> = {}
): Anthropic.MessageCreateParamsNonStreaming {
	if (parts.length === 0 || parts.length > MAX_PARTS) throw new RangeError('aantal delen');
	const content: Anthropic.ContentBlockParam[] = [];
	parts.forEach((part, i) => {
		if (part.data.length === 0 || part.data.length > MAX_PART_BYTES) {
			throw new RangeError('beeld te groot of leeg');
		}
		// Bij meerdere beelden een label per beeld (docs: Vision, Multiple images)
		if (parts.length > 1) content.push({ type: 'text', text: `Deel ${i + 1}:` });
		content.push({
			type: 'image',
			source: { type: 'base64', media_type: part.mediaType, data: part.data.toString('base64') }
		});
	});
	// Beelden eerst, dan de vraag (docs: Vision)
	content.push({ type: 'text', text: userInstruction(parts.length, opts.received) });

	return {
		model: opts.model ?? RECEIPT_MODEL,
		max_tokens: RECEIPT_MAX_TOKENS,
		system: SYSTEM_PROMPT,
		messages: [{ role: 'user', content }],
		output_config: {
			effort: opts.effort ?? RECEIPT_EFFORT,
			format: { type: 'json_schema', schema: outputJsonSchema() }
		}
	};
}

/**
 * Leest één bon. Een weigering, afgekapte uitvoer of uitvoer die niet door het schema komt is
 * een gewone uitkomst (`ok: false`); fouten van de API (netwerk, 429, 5xx) gooit hij door, zodat
 * de worker zelf kiest of hij het later opnieuw probeert. De SDK probeert zelf al twee keer.
 */
export async function readReceipt(
	client: ReceiptClient,
	parts: ReceiptPart[],
	opts: ReadOptions = {}
): Promise<ReadResult> {
	const clock = opts.clock ?? performance.now.bind(performance);
	const request = buildRequest(parts, opts);
	const started = clock();
	const message = await client.messages.create(request, { signal: opts.signal });

	const usage: ReadUsage = {
		model: message.model,
		parts: parts.length,
		inputTokens: message.usage.input_tokens,
		outputTokens: message.usage.output_tokens,
		costNanoUsd: costNanoUsd(message.usage.input_tokens, message.usage.output_tokens),
		durationMs: Math.round(clock() - started)
	};

	// Eerst de stopreden: bij een weigering of afkappen klopt de uitvoer niet met het schema
	if (message.stop_reason === 'refusal') return { ok: false, reason: 'weigering', usage };
	if (message.stop_reason === 'max_tokens') return { ok: false, reason: 'afgekapt', usage };

	const output = parseOutput(message.content);
	return output === null ? { ok: false, reason: 'ongeldig', usage } : { ok: true, output, usage };
}

/** Haalt de JSON uit het antwoord en valideert hem; alles wat afwijkt is `null`. */
export function parseOutput(content: Anthropic.ContentBlock[]): ReceiptOutput | null {
	const text = content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
	if (text === undefined) return null;
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return null;
	}
	const parsed = ReceiptOutputSchema.safeParse(lowerEnums(json));
	return parsed.success ? parsed.data : null;
}

// Enumwaarden kunnen alleen in hoofdletters afwijken (docs: Structured outputs); die vangen we op
// door ze klein te maken, de rest laat `safeParse` gewoon weigeren.
const ENUM_KEYS = new Set(['beeld', 'zekerheid', 'soort']);

function lowerEnums(node: unknown, key = ''): unknown {
	if (typeof node === 'string') return ENUM_KEYS.has(key) ? node.toLowerCase() : node;
	if (Array.isArray(node)) return node.map((item) => lowerEnums(item));
	if (node === null || typeof node !== 'object') return node;
	const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, lowerEnums(v, k)]));
	// Betaalwijze is het enige veld waarvan de waarde zelf een enum is
	const method = (out as { betaalwijze?: { waarde?: unknown } }).betaalwijze;
	if (method && typeof method.waarde === 'string') method.waarde = method.waarde.toLowerCase();
	return out;
}

// Telemetrie per aanroep (spec: Telemetrie en monitoring, AI): tokens, kosten, duur en uitkomst.
// De worker geeft een callback mee die dit in de telemetrie-database zet; hier alleen de vorm.

export type ReceiptOutcome = FieldStatus | ReadFailure | 'fout';

export interface ReceiptTelemetry {
	model: string;
	parts: number;
	inputTokens: number;
	outputTokens: number;
	costNanoUsd: number;
	durationMs: number;
	outcome: ReceiptOutcome;
}

export type ReceiptTelemetryHook = (event: ReceiptTelemetry) => void;

export type ProcessResult =
	| {
			ok: true;
			output: ReceiptOutput;
			checked: CheckedReceipt;
			/** Alleen bij een screenshot met transacties; dan telt de uitkomst van de lijst. */
			list: CheckedList | null;
			usage: ReadUsage;
	  }
	| { ok: false; reason: ReadFailure; usage: ReadUsage };

/**
 * Lezen plus controleren, met één telemetriegebeurtenis per aanroep. `now` is het moment van
 * uploaden: daartegen gelden "niet in de toekomst" en "niet ouder dan 60 dagen".
 */
export async function processReceipt(
	client: ReceiptClient,
	parts: ReceiptPart[],
	now: Date,
	opts: ReadOptions & { onTelemetry?: ReceiptTelemetryHook } = {}
): Promise<ProcessResult> {
	const clock = opts.clock ?? performance.now.bind(performance);
	const started = clock();
	let result: ReadResult;
	try {
		result = await readReceipt(client, parts, { received: toIsoDate(now), ...opts, clock });
	} catch (e) {
		emit(opts.onTelemetry, {
			model: opts.model ?? RECEIPT_MODEL,
			parts: parts.length,
			inputTokens: 0,
			outputTokens: 0,
			costNanoUsd: 0,
			durationMs: Math.round(clock() - started),
			outcome: 'fout'
		});
		throw e;
	}
	if (!result.ok) {
		emit(opts.onTelemetry, { ...result.usage, outcome: result.reason });
		return result;
	}
	const checked = checkReceipt(result.output, now);
	const list = result.output.beeld === 'lijst' ? checkList(result.output, now) : null;
	emit(opts.onTelemetry, { ...result.usage, outcome: (list ?? checked).outcome });
	return { ok: true, output: result.output, checked, list, usage: result.usage };
}

function emit(hook: ReceiptTelemetryHook | undefined, event: ReceiptTelemetry): void {
	if (!hook) return;
	// Telemetrie mag het lezen nooit laten mislukken
	try {
		hook(event);
	} catch {
		// bewust genegeerd
	}
}
