import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

// Gedeeld door alle aanroepen naar Claude (spec: Vragen en samenvattingen met AI, Model): de
// client, de prijs per aanroep en het JSON-schema voor structured outputs. Elke functie heeft
// haar eigen model, `max_tokens` en `effort`; de uitvoer is altijd onbetrouwbare invoer.

/** Alleen wat de app van de SDK-client gebruikt; in tests een nagebootste versie. */
export interface AiClient {
	messages: { create: Anthropic['messages']['create'] };
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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

export function costNanoUsd(inputTokens: number, outputTokens: number): number {
	const price = inputTokens > LARGE_PROMPT_TOKENS ? PRICE_NANO_USD.large : PRICE_NANO_USD.small;
	return inputTokens * price.input + outputTokens * price.output;
}

/** Sleutelwoorden die structured outputs weigert; de grenzen zelf controleert `safeParse`. */
const UNSUPPORTED = new Set(['$schema', 'maxLength', 'minLength', 'maxItems', 'default']);

function strip(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(strip);
	if (node === null || typeof node !== 'object') return node;
	return Object.fromEntries(
		Object.entries(node)
			.filter(([key]) => !UNSUPPORTED.has(key))
			.map(([key, value]) => [key, strip(value)])
	);
}

/**
 * JSON-schema voor `output_config.format`. Zelf gebouwd in plaats van met `zodOutputFormat` uit
 * de SDK: die zet ook `enum` alleen nog in de beschrijving, terwijl het model zich dan niet aan de
 * vaste waarden hoeft te houden.
 */
export function outputSchema(schema: z.ZodType): Record<string, unknown> {
	return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** De tekst van het antwoord als JSON, of `undefined` als die er niet is of geen JSON is. */
export function jsonOf(content: Anthropic.ContentBlock[]): unknown {
	const text = content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text;
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// De client voor aanroepen buiten de job-worker (de samenvatting, later het vraagveld). De
// server zet hem bij het starten als er een API-sleutel is; tests zetten een nagebootste.

let provider: (() => AiClient) | null = null;

export function useAiClient(next: (() => AiClient) | null): void {
	provider = next;
}

/** `null` zonder API-sleutel: dan valt alles terug op de vaste tekst. */
export function aiClient(): AiClient | null {
	return provider ? provider() : null;
}
