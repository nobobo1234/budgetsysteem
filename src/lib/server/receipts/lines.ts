import { and, asc, eq } from 'drizzle-orm';
import type { ProductGroup } from '../../productGroups.ts';
import { recordChange } from '../audit.ts';
import type { Conn, DB } from '../db/index.ts';
import { receiptLines } from '../db/schema.ts';
import { ValidationError } from '../errors.ts';
import { log } from '../log.ts';
import { telemetryDb } from '../telemetry/index.ts';
import { recordCorrection } from '../telemetry/receipts.ts';
import { completeLines } from './outcome.ts';
import type { LineKind } from './schema.ts';
import type { StoredFields } from './stored.ts';

// Bonregels in een eigen tabel (spec: Analyses → Boodschappen per productgroep). Zodra een bon
// verwerkt is (zeker, controleren of na de review-inbox) gaan de gecontroleerde regels naar
// `receipt_lines`; daarna is die tabel leidend, zodat een aangepaste groep blijft staan.

export interface ReceiptLineView {
	id: string;
	position: number;
	/** Zoals op de bon: onbetrouwbare tekst, alleen als gewone tekst tonen. */
	description: string;
	kind: LineKind;
	/** Met het teken waarmee de regel meetelt: korting en bonus negatief. */
	amountCents: number;
	group: ProductGroup | null;
}

/**
 * Zet de regels van een verwerkte bon in de tabel, als ze compleet zijn. Staan ze er al, dan
 * verandert er niets: een groep die je aanpaste blijft zo. Geeft het aantal nieuwe regels.
 */
export function storeLines(db: Conn, receiptId: string, fields: StoredFields): number {
	if (!completeLines(fields)) return 0;
	const existing = db
		.select({ id: receiptLines.id })
		.from(receiptLines)
		.where(eq(receiptLines.receiptId, receiptId))
		.get();
	if (existing) return 0;
	db.insert(receiptLines)
		.values(
			fields.lines.map((line, position) => ({
				receiptId,
				position,
				description: line.description.slice(0, 120),
				kind: line.kind,
				amountCents: line.cents,
				productGroup: line.kind === 'artikel' ? line.group : null
			}))
		)
		.run();
	return fields.lines.length;
}

/** Opnieuw gelezen: de oude regels tellen niet meer. */
export function clearLines(db: Conn, receiptId: string): void {
	db.delete(receiptLines).where(eq(receiptLines.receiptId, receiptId)).run();
}

export function receiptLinesOf(db: Conn, receiptId: string): ReceiptLineView[] {
	return db
		.select({
			id: receiptLines.id,
			position: receiptLines.position,
			description: receiptLines.description,
			kind: receiptLines.kind,
			amountCents: receiptLines.amountCents,
			group: receiptLines.productGroup
		})
		.from(receiptLines)
		.where(eq(receiptLines.receiptId, receiptId))
		.orderBy(asc(receiptLines.position))
		.all();
}

/**
 * De productgroep van een artikel aanpassen. Alleen de tabel verandert, niet de ruwe uitvoer.
 * Koos Haiku al een groep, dan telt het in de telemetrie als correctie; een regel van voor de
 * productgroepen (nog leeg) invullen niet. Geeft `false` als de groep al zo was.
 */
export function setLineGroup(
	db: DB,
	receiptId: string,
	lineId: string,
	group: ProductGroup
): boolean {
	const line = db
		.select()
		.from(receiptLines)
		.where(and(eq(receiptLines.id, lineId), eq(receiptLines.receiptId, receiptId)))
		.get();
	if (!line) throw new ValidationError('Deze regel bestaat niet meer');
	if (line.kind !== 'artikel')
		throw new ValidationError('Alleen een artikel heeft een productgroep');
	if (line.productGroup === group) return false;
	db.transaction((tx) => {
		tx.update(receiptLines).set({ productGroup: group }).where(eq(receiptLines.id, lineId)).run();
		recordChange(
			tx,
			'gecorrigeerd',
			'receipt_lines',
			lineId,
			{ productGroup: line.productGroup },
			{ productGroup: group }
		);
	});
	if (line.productGroup !== null) {
		try {
			recordCorrection(telemetryDb(), receiptId, ['productgroep'], false);
		} catch (e) {
			log.warn(
				{ err: { name: e instanceof Error ? e.name : 'Onbekend' } },
				'telemetrie bon mislukt'
			);
		}
	}
	return true;
}
