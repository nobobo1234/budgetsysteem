import { describe, expect, it } from 'vitest';
import { listItem, listOutput, receiptOutput } from './fixtures.ts';
import {
	MAX_LIST_ITEMS,
	outputJsonSchema,
	ReceiptOutputSchema,
	SYSTEM_PROMPT,
	userInstruction
} from './schema.ts';

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
		expect(enums).toContainEqual(['bon', 'lijst']);
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

describe('screenshot met transacties', () => {
	const schema = outputJsonSchema() as {
		properties: Record<string, { items?: { properties: Record<string, unknown> } }>;
		required: string[];
	};

	it('vraagt eerst of het een bon of een lijst is, en per transactie vier velden met zekerheid', () => {
		expect(Object.keys(schema.properties)[0]).toBe('beeld');
		expect(schema.required).toEqual(expect.arrayContaining(['beeld', 'transacties']));
		const item = schema.properties.transacties!.items!.properties;
		expect(Object.keys(item)).toEqual(['datum', 'tegenpartij', 'bedrag', 'valuta']);
		for (const f of Object.values(item) as { properties: Record<string, unknown> }[]) {
			expect(Object.keys(f.properties)).toEqual(['waarde', 'zekerheid', 'notitie']);
		}
	});

	it('accepteert een lijst en handhaaft het maximum aantal transacties', () => {
		const one = listItem('2026-10-20', 'Voorbeeld', '-1.00');
		expect(ReceiptOutputSchema.safeParse(listOutput([one])).success).toBe(true);
		expect(
			ReceiptOutputSchema.safeParse(
				listOutput(Array.from({ length: MAX_LIST_ITEMS + 1 }, () => one))
			).success
		).toBe(false);
		const { beeld: _, ...withoutKind } = receiptOutput();
		expect(ReceiptOutputSchema.safeParse(withoutKind).success).toBe(false);
		expect(ReceiptOutputSchema.safeParse({ ...receiptOutput(), beeld: 'foto' }).success).toBe(
			false
		);
	});

	it('de prompt legt bon of lijst, het teken en de ontvangstdatum uit', () => {
		expect(SYSTEM_PROMPT).toContain('"lijst"');
		expect(SYSTEM_PROMPT).toContain('negatief voor geld dat eraf ging');
		expect(SYSTEM_PROMPT).toContain('Gebruik die datum nooit als datum van een bon');
		expect(userInstruction(1)).toBe('Lees deze bon volgens het schema.');
		expect(userInstruction(2, '2026-10-21')).toBe(
			'Hierboven staan 2 delen van één bon, van boven naar beneden. Lees de bon volgens het schema.\nOntvangen op 2026-10-21.'
		);
	});
});
