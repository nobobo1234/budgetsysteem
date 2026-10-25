import { describe, expect, it } from 'vitest';
import { receiptOutput } from './fixtures.ts';
import { outputJsonSchema, ReceiptOutputSchema } from './schema.ts';

type Node = Record<string, unknown>;

function walk(node: unknown, visit: (n: Node) => void): void {
	if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
	if (node === null || typeof node !== 'object') return;
	visit(node as Node);
	for (const value of Object.values(node)) walk(value, visit);
}

describe('outputJsonSchema', () => {
	const schema = outputJsonSchema();

	it('gebruikt alleen wat structured outputs ondersteunt', () => {
		walk(schema, (n) => {
			for (const key of ['$schema', 'maxLength', 'minLength', 'maxItems', 'minimum', 'maximum']) {
				expect(n, key).not.toHaveProperty(key);
			}
			if (n.type === 'object') expect(n.additionalProperties).toBe(false);
		});
	});

	it('heeft geen optionele velden en geen unions (complexiteitsgrenzen van de API)', () => {
		walk(schema, (n) => {
			expect(n).not.toHaveProperty('anyOf');
			expect(Array.isArray(n.type)).toBe(false);
			if (n.type === 'object') {
				expect(Object.keys(n.properties as Node).sort()).toEqual(
					[...(n.required as string[])].sort()
				);
			}
		});
	});

	it('houdt de vaste waarden als enum, zodat het model zich eraan moet houden', () => {
		const enums: unknown[] = [];
		walk(schema, (n) => {
			if (n.enum) enums.push(n.enum);
		});
		expect(enums).toContainEqual(['zeker', 'twijfel', 'onleesbaar']);
		expect(enums).toContainEqual(['', 'pin', 'creditcard', 'contant', 'cadeaukaart', 'overig']);
		expect(enums).toContainEqual([
			'artikel',
			'korting',
			'bonus',
			'statiegeld',
			'statiegeld_retour',
			'fooi',
			'overig'
		]);
	});
});

describe('ReceiptOutputSchema', () => {
	it('handhaaft de grenzen die niet naar het model gaan', () => {
		expect(ReceiptOutputSchema.safeParse(receiptOutput()).success).toBe(true);
		const tooMany = receiptOutput({
			regels: Array.from({ length: 151 }, () => ({
				omschrijving: 'x',
				bedrag: '0.01',
				soort: 'artikel' as const
			}))
		});
		expect(ReceiptOutputSchema.safeParse(tooMany).success).toBe(false);
		const longStore = receiptOutput();
		longStore.winkel.waarde = 'x'.repeat(101);
		expect(ReceiptOutputSchema.safeParse(longStore).success).toBe(false);
	});
});
