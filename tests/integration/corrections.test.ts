import { readFileSync } from 'node:fs';
import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectedBalance } from '../../src/lib/balance.ts';
import { monthOverview, spendingByCategory } from '../../src/lib/server/budgets.ts';
import {
	correctionCandidates,
	correctionInfo,
	linkCorrection,
	refundTargets,
	unlinkCorrection
} from '../../src/lib/server/corrections.ts';
import type { DB } from '../../src/lib/server/db/index.ts';
import {
	accounts,
	auditLog,
	categories,
	owed,
	owedPayments,
	transactionSplits,
	transactions
} from '../../src/lib/server/db/schema.ts';
import { parseBankFile } from '../../src/lib/server/import/index.ts';
import { importRecords } from '../../src/lib/server/import/importer.ts';
import type { ImportRecord } from '../../src/lib/server/import/types.ts';
import { forgiveOwed, owedOverview, settlePayment } from '../../src/lib/server/owed.ts';
import { findOrCreatePerson } from '../../src/lib/server/people.ts';
import {
	createTransaction,
	deleteTransaction,
	updateTransaction,
	ValidationError
} from '../../src/lib/server/transactions.ts';
import { newTransactionSchema } from '../../src/lib/server/validation.ts';
import { actions as importActions } from '../../src/routes/(app)/import/+page.server.ts';
import { actions as txActions } from '../../src/routes/(app)/transacties/[id]/+page.server.ts';
import { fakeEvent, ORIGIN, tempDatabase } from './helpers.ts';

let db: DB;
let cleanup: () => void;
let sns: string;
let cat: (name: string) => string;

const TODAY = '2026-10-23';

beforeEach(() => {
	({ db, cleanup } = tempDatabase());
	sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
	cat = (name) => db.select().from(categories).where(eq(categories.name, name)).get()!.id;
});
afterEach(() => cleanup());

function tx(over: Partial<Record<string, unknown>> = {}) {
	const input = newTransactionSchema.parse({
		id: crypto.randomUUID(),
		amountCents: -7995,
		date: '2026-09-20',
		counterparty: 'Zalando SE',
		categoryId: cat('Kleding'),
		accountId: sns,
		...over
	});
	createTransaction(db, input, TODAY);
	return input.id;
}

const row = (id: string) => db.select().from(transactions).where(eq(transactions.id, id)).get()!;
const link = (refund: string, original: string, opts = {}) =>
	db.transaction((t) => linkCorrection(t, refund, original, opts));
const unlink = (refund: string) => db.transaction((t) => unlinkCorrection(t, refund));
const spent = (month: string, name: string) => spendingByCategory(db, month).get(cat(name)) ?? 0;

function outstanding(sourceTransactionId: string) {
	const paid = (id: string) =>
		db
			.select()
			.from(owedPayments)
			.where(eq(owedPayments.owedId, id))
			.all()
			.reduce((s, p) => s + p.amountCents, 0);
	return db
		.select()
		.from(owed)
		.where(eq(owed.sourceTransactionId, sourceTransactionId))
		.orderBy(asc(owed.createdAt))
		.all()
		.map((o) => ({ amount: o.amountCents, open: o.amountCents - paid(o.id), status: o.status }));
}

describe('verrekenen in de oorspronkelijke categorie en maand', () => {
	it('een retour in oktober verlaagt de uitgave van september', () => {
		const jas = tx();
		const retour = tx({ amountCents: 2500, date: '2026-10-04', categoryId: null });
		expect(spent('2026-09', 'Kleding')).toBe(7995);
		link(retour, jas);

		expect(spent('2026-09', 'Kleding')).toBe(5495);
		expect(spent('2026-10', 'Kleding')).toBe(0);
		expect(spendingByCategory(db, '2026-10').get(null)).toBeUndefined();
		const r = row(retour);
		expect(r).toMatchObject({
			correctionOf: jas,
			categoryId: cat('Kleding'),
			categorySource: 'correctie',
			status: 'bevestigd'
		});
	});

	it('het saldo telt de terugboeking op de datum dat het geld binnenkwam', () => {
		const jas = tx();
		const retour = tx({ amountCents: 2500, date: '2026-10-04', categoryId: null });
		link(retour, jas);
		const entries = db.select().from(transactions).all();
		const anchor = { accountId: sns, date: '2026-08-31', amountCents: 100_000 };
		expect(expectedBalance(anchor, entries, '2026-09-30')).toBe(100_000 - 7995);
		expect(expectedBalance(anchor, entries, '2026-10-04')).toBe(100_000 - 7995 + 2500);
	});

	it('een voorbije maand toont wat er na afloop verrekend is', () => {
		const jas = tx();
		const retour = tx({ amountCents: 2500, date: '2026-10-04', categoryId: null });
		link(retour, jas);
		const sep = monthOverview(db, '2026-09', TODAY);
		expect(sep.lateCorrections).toEqual([
			{ id: retour, counterparty: 'Zalando SE', amountCents: 2500, date: '2026-10-04' }
		]);
		expect(monthOverview(db, '2026-10', TODAY).lateCorrections).toEqual([]);
		// In het audit-log, met de maand die veranderde
		const entry = db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.action, 'correctie_gekoppeld'), eq(auditLog.entityId, retour)))
			.get();
		expect(entry?.after).toMatchObject({ correctionOf: jas, month: '2026-09' });
	});

	it('verhuist mee als de categorie van het origineel verandert', () => {
		const jas = tx();
		const retour = tx({ amountCents: 2500, date: '2026-10-04', categoryId: null });
		link(retour, jas);
		updateTransaction(db, jas, { categoryId: cat('Cadeaus') }, TODAY);
		expect(row(retour).categoryId).toBe(cat('Cadeaus'));
		expect(spent('2026-09', 'Cadeaus')).toBe(5495);
	});
});

describe('grenzen', () => {
	it('gedeeltelijk en meerdere keren, samen nooit meer dan het origineel', () => {
		const jas = tx();
		const a = tx({ amountCents: 3000, date: '2026-10-01', categoryId: null });
		const b = tx({ amountCents: 4995, date: '2026-10-02', categoryId: null });
		const c = tx({ amountCents: 1, date: '2026-10-03', categoryId: null });
		link(a, jas);
		link(b, jas);
		expect(spent('2026-09', 'Kleding')).toBe(0);
		expect(() => link(c, jas)).toThrow(ValidationError);
		expect(row(c).correctionOf).toBeNull();
	});

	it('hetzelfde teken, zichzelf of een terugboeking op een terugboeking wordt geweigerd', () => {
		const jas = tx();
		const andere = tx({ amountCents: -1000 });
		const retour = tx({ amountCents: 1000, date: '2026-10-01', categoryId: null });
		expect(() => link(andere, jas)).toThrow(ValidationError);
		expect(() => link(jas, jas)).toThrow(ValidationError);
		link(retour, jas);
		const nogEen = tx({ amountCents: -500, date: '2026-10-02', categoryId: null });
		expect(() => link(nogEen, retour)).toThrow(ValidationError);
	});

	it('het origineel kan niet kleiner worden dan wat er al terugkwam', () => {
		const jas = tx();
		const retour = tx({ amountCents: 5000, date: '2026-10-01', categoryId: null });
		link(retour, jas);
		expect(() => updateTransaction(db, jas, { amountCents: -4000 }, TODAY)).toThrow(
			ValidationError
		);
		expect(updateTransaction(db, jas, { amountCents: -6000 }, TODAY)).toBe(true);
		// Het bedrag van een gekoppelde retour pas je pas aan na losmaken
		expect(() => updateTransaction(db, retour, { amountCents: 4000 }, TODAY)).toThrow(
			ValidationError
		);
	});
});

describe('verdeling over categorieën', () => {
	function splitExpense() {
		const id = tx({ amountCents: -10000, counterparty: 'HEMA', categoryId: null });
		db.insert(transactionSplits)
			.values([
				{ transactionId: id, categoryId: cat('Huishouden'), amountCents: -3000 },
				{ transactionId: id, categoryId: cat('Kleding'), amountCents: -7000 }
			])
			.run();
		return id;
	}

	it('standaard van het grootste deel', () => {
		const hema = splitExpense();
		const retour = tx({ amountCents: 2000, counterparty: 'HEMA', date: '2026-10-01' });
		link(retour, hema);
		expect(row(retour).categoryId).toBe(cat('Kleding'));
		expect(spent('2026-09', 'Kleding')).toBe(5000);
		expect(spent('2026-09', 'Huishouden')).toBe(3000);
	});

	it('of van het deel dat je kiest', () => {
		const hema = splitExpense();
		const retour = tx({ amountCents: 2000, counterparty: 'HEMA', date: '2026-10-01' });
		link(retour, hema, { categoryId: cat('Huishouden') });
		expect(spent('2026-09', 'Huishouden')).toBe(1000);
		expect(() => link(retour, hema, { categoryId: cat('Vervoer') })).toThrow(ValidationError);
	});
});

describe('retour van een voorgeschoten uitgave', () => {
	// €90 voor drie met Sanne en Tim: ieder €30
	function shared() {
		return tx({
			amountCents: -9000,
			counterparty: 'Bol.com',
			categoryId: cat('Elektronica'),
			share: { people: 3, with: ['Sanne', 'Tim'] }
		});
	}

	it('voorbeeld uit de spec: €30 terug maakt elk deel €10 lager', () => {
		const bol = shared();
		const retour = tx({ amountCents: 3000, counterparty: 'Bol.com', date: '2026-10-05' });
		link(retour, bol);
		expect(spent('2026-09', 'Elektronica')).toBe(2000);
		expect(outstanding(bol).map((p) => p.open)).toEqual([2000, 2000]);
		expect(outstanding(bol).map((p) => p.status)).toEqual(['deels', 'deels']);
		// Terugbetaling (buiten budget) loopt netjes op nul uit als de rest binnenkomt
		expect(spendingByCategory(db, '2026-09').get(cat('Terugbetaling'))).toBe(4000);
		expect(owedOverview(db, TODAY).toReceiveCents).toBe(4000);
	});

	it('alleen van mijn deel', () => {
		const bol = shared();
		const retour = tx({ amountCents: 2000, counterparty: 'Bol.com', date: '2026-10-05' });
		link(retour, bol, { mode: 'mijn_deel' });
		expect(spent('2026-09', 'Elektronica')).toBe(1000);
		expect(outstanding(bol).map((p) => p.open)).toEqual([3000, 3000]);
		// Meer dan jouw deel: de rest naar verhouding over de anderen
		link(retour, bol, { mode: 'mijn_deel' });
		const groot = tx({ amountCents: 5000, counterparty: 'Bol.com', date: '2026-10-06' });
		unlink(retour);
		link(groot, bol, { mode: 'mijn_deel' });
		expect(spent('2026-09', 'Elektronica')).toBe(0);
		expect(outstanding(bol).map((p) => p.open)).toEqual([2000, 2000]);
	});

	it('heeft iemand al meer betaald dan het nieuwe aandeel, dan wordt het verschil te betalen', () => {
		const bol = shared();
		const sanne = findOrCreatePerson(db, 'Sanne');
		const tikkie = tx({ amountCents: 3000, counterparty: 'Sanne', categoryId: null });
		db.transaction((t) => settlePayment(t, tikkie, { personId: sanne }));
		const retour = tx({ amountCents: 3000, counterparty: 'Bol.com', date: '2026-10-05' });
		link(retour, bol);

		expect(outstanding(bol).map((p) => p.open)).toEqual([0, 2000]);
		const payBack = db.select().from(owed).where(eq(owed.sourceTransactionId, retour)).all();
		expect(payBack).toMatchObject([
			{ personId: sanne, direction: 'te_betalen', amountCents: 1000, status: 'open' }
		]);
		expect(owedOverview(db, TODAY).toPayCents).toBe(1000);

		// Losmaken zet alles terug
		unlink(retour);
		expect(db.select().from(owed).where(eq(owed.sourceTransactionId, retour)).all()).toEqual([]);
		expect(outstanding(bol).map((p) => p.open)).toEqual([0, 3000]);
		expect(spent('2026-09', 'Elektronica')).toBe(3000);
	});

	it('een kwijtgescholden aandeel gaat niet meer omlaag', () => {
		const bol = shared();
		const tim = db.select().from(owed).where(eq(owed.sourceTransactionId, bol)).all()[1]!;
		forgiveOwed(db, tim.id);
		// Jouw deel is nu €60, Sanne €30: €30 terug gaat 2:1
		const retour = tx({ amountCents: 3000, counterparty: 'Bol.com', date: '2026-10-05' });
		link(retour, bol);
		expect(spent('2026-09', 'Elektronica')).toBe(4000);
		expect(outstanding(bol)[0]!.open).toBe(2000);
	});

	it('kwijtschelden na een retour: de verdeling uit de posten (syncShareSplits) blijft kloppen', () => {
		const bol = shared();
		const [sannePost, timPost] = db
			.select()
			.from(owed)
			.where(eq(owed.sourceTransactionId, bol))
			.orderBy(asc(owed.createdAt))
			.all();
		const terug = () => spendingByCategory(db, '2026-09').get(cat('Terugbetaling')) ?? 0;
		const splitOf = (note: string) =>
			db
				.select()
				.from(transactionSplits)
				.where(and(eq(transactionSplits.transactionId, bol), eq(transactionSplits.note, note)))
				.get()!.amountCents;

		// €30 terug: elk deel €10 lager
		const retour = tx({ amountCents: 3000, counterparty: 'Bol.com', date: '2026-10-05' });
		link(retour, bol);
		// De retour verandert de posten niet, dus ook de verdeling van het origineel niet
		expect([splitOf('Mijn deel'), splitOf('Voorgeschoten')]).toEqual([-3000, -6000]);

		// Sanne's resterende €20 kwijtschelden: het deel dat de retour dekte blijft van haar
		forgiveOwed(db, sannePost!.id);
		expect([splitOf('Mijn deel'), splitOf('Voorgeschoten')]).toEqual([-5000, -4000]);
		// Jij: €30 − €10 retour + €20 kwijtgescholden
		expect(spent('2026-09', 'Elektronica')).toBe(4000);
		// Terugbetaling loopt op nul uit zodra Tim zijn €20 betaalt
		const tim = findOrCreatePerson(db, 'Tim');
		const tikkie = tx({
			amountCents: 2000,
			counterparty: 'Tim',
			date: '2026-09-25',
			categoryId: cat('Terugbetaling')
		});
		db.transaction((t) => settlePayment(t, tikkie, { owedId: timPost!.id, personId: tim }));
		expect(terug()).toBe(0);
		expect(outstanding(bol).map((p) => p.open)).toEqual([2000, 0]);

		// Nog een retour van €30: Sanne telt niet meer mee, jij €40 en Tim nog €20 → 2:1
		const tweede = tx({ amountCents: 3000, counterparty: 'Bol.com', date: '2026-10-06' });
		link(tweede, bol);
		expect(spent('2026-09', 'Elektronica')).toBe(2000);
		// Tim betaalde al alles: zijn €10 wordt te betalen
		expect(db.select().from(owed).where(eq(owed.sourceTransactionId, tweede)).all()).toMatchObject([
			{ personId: tim, direction: 'te_betalen', amountCents: 1000 }
		]);

		// Losmaken van de eerste: Sanne's hele aandeel is dan kwijtgescholden en voor jou
		unlink(tweede);
		unlink(retour);
		expect([splitOf('Mijn deel'), splitOf('Voorgeschoten')]).toEqual([-6000, -3000]);
		expect(spent('2026-09', 'Elektronica')).toBe(6000);
		expect(terug()).toBe(1000);
	});

	it('zonder namen moet je eerst kiezen wie er meededen', () => {
		const bol = tx({ amountCents: -9000, counterparty: 'Bol.com', share: { people: 3, with: [] } });
		const retour = tx({ amountCents: 3000, counterparty: 'Bol.com', date: '2026-10-05' });
		expect(() => link(retour, bol)).toThrow(/wie er meededen/);
		// Alleen van jouw deel kan wel
		link(retour, bol, { mode: 'mijn_deel' });
		expect(spent('2026-09', 'Kleding')).toBe(0);
	});

	it('de detailpagina toont de verdeling en de andere keuze', () => {
		const bol = shared();
		const retour = tx({ amountCents: 3000, counterparty: 'Bol.com', date: '2026-10-05' });
		link(retour, bol);
		const info = correctionInfo(db, retour)!;
		expect(info.original?.id).toBe(bol);
		expect(info.shared).toMatchObject({
			mineCents: 1000,
			mode: 'verhouding',
			alternative: 'mijn_deel',
			parts: [
				{ personName: 'Sanne', cents: 1000 },
				{ personName: 'Tim', cents: 1000 }
			]
		});
		expect(correctionInfo(db, bol)!.corrections.map((c) => c.id)).toEqual([retour]);
		expect(correctionInfo(db, bol)!.roomCents).toBe(6000);
	});
});

describe('losmaken en verwijderen', () => {
	it('losmaken maakt er een gewone inkomende boeking op te controleren van', () => {
		const jas = tx();
		const retour = tx({ amountCents: 2500, date: '2026-10-04', categoryId: null });
		link(retour, jas);
		unlink(retour);
		expect(row(retour)).toMatchObject({
			correctionOf: null,
			categoryId: null,
			categorySource: null,
			status: 'te_controleren'
		});
		expect(spent('2026-09', 'Kleding')).toBe(7995);
		expect(unlink(retour)).toBe(false);
	});

	it('het origineel verwijderen maakt de retour los', () => {
		const jas = tx();
		const retour = tx({ amountCents: 2500, date: '2026-10-04', categoryId: null });
		link(retour, jas);
		deleteTransaction(db, jas);
		expect(row(retour)).toMatchObject({ correctionOf: null, status: 'te_controleren' });
	});

	it('een gedeelde uitgave met retour verwijderen laat niets achter', () => {
		const bol = tx({
			amountCents: -9000,
			counterparty: 'Bol.com',
			share: { people: 3, with: ['Sanne', 'Tim'] }
		});
		const retour = tx({ amountCents: 3000, counterparty: 'Bol.com', date: '2026-10-05' });
		link(retour, bol);
		deleteTransaction(db, bol);
		expect(db.select().from(owed).all()).toEqual([]);
		expect(db.select().from(owedPayments).all()).toEqual([]);
		expect(row(retour).status).toBe('te_controleren');
	});
});

describe('koppellijst voor een retour', () => {
	it('uitgaven bij dezelfde tegenpartij in de laatste 60 dagen, waar het bedrag in past', () => {
		const jas = tx({ date: '2026-09-20' });
		tx({ date: '2026-07-01' }); // te oud
		tx({ counterparty: 'Albert Heijn', categoryId: null }); // andere winkel
		const klein = tx({ amountCents: -1000, date: '2026-09-25' }); // past niet
		const retour = tx({
			amountCents: 2500,
			counterparty: 'ZALANDO SE BERLIN',
			date: '2026-10-04',
			categoryId: null
		});
		const { candidates } = correctionCandidates(db, retour);
		expect(candidates.map((c) => c.id)).toEqual([jas]);
		expect(candidates[0]).toMatchObject({ categoryName: 'Kleding', roomCents: 7995 });
		expect(candidates.map((c) => c.id)).not.toContain(klein);
	});

	it('snelinvoer krijgt uitgaven van de laatste 60 dagen met wat er nog terug kan', () => {
		const jas = tx({ date: '2026-09-20' });
		link(tx({ amountCents: 2500, date: '2026-10-04', categoryId: null }), jas);
		tx({ date: '2026-07-01' });
		expect(refundTargets(db, TODAY)).toMatchObject([{ id: jas, roomCents: 5495 }]);
	});
});

describe('snelinvoer met retour', () => {
	it('+25 retour zalando koppelt meteen', () => {
		const jas = tx();
		const retour = tx({
			amountCents: 2500,
			date: '2026-10-04',
			categoryId: null,
			correct: { transactionId: jas }
		});
		expect(row(retour).correctionOf).toBe(jas);
		expect(spent('2026-09', 'Kleding')).toBe(5495);
	});

	it('past de retour niet meer, dan blijft hij staan op te controleren', () => {
		const jas = tx({ amountCents: -2000 });
		const retour = tx({
			amountCents: 2500,
			date: '2026-10-04',
			categoryId: null,
			correct: { transactionId: jas }
		});
		expect(row(retour)).toMatchObject({ correctionOf: null, status: 'te_controleren' });
	});

	it('retour en een post tegelijk wordt geweigerd', () => {
		expect(
			newTransactionSchema.safeParse({
				id: crypto.randomUUID(),
				amountCents: 2500,
				date: '2026-10-04',
				counterparty: 'Zalando',
				categoryId: null,
				accountId: sns,
				settle: { owedId: crypto.randomUUID() },
				correct: { transactionId: crypto.randomUUID() }
			}).success
		).toBe(false);
	});
});

describe('import met terugboekingen', () => {
	const file = (name: string) => readFileSync(`tests/fixtures/${name}`);
	function importFixture(name: string) {
		const { format, records } = parseBankFile(file(name));
		return importRecords(db, records, format);
	}
	const byRef = (ref: string) =>
		db
			.select()
			.from(transactions)
			.where(eq(transactions.bankReference, `NL12SNSB0123456789:${ref}`))
			.get()!;

	it('koppelt een storno automatisch bij precies één passende boeking', () => {
		const summary = importFixture('camt053-storno.xml');
		const original = byRef('STO-0001');
		const storno = byRef('STO-0002');
		expect(storno).toMatchObject({ correctionOf: original.id, status: 'bevestigd' });
		expect(summary.reversals.linked).toEqual([
			{
				id: storno.id,
				counterparty: 'Energie Test B.V.',
				amountCents: 4995,
				date: '2026-09-03',
				originalDate: '2026-08-28'
			}
		]);
		// In het audit-log als automatische koppeling
		expect(
			db
				.select()
				.from(auditLog)
				.where(and(eq(auditLog.action, 'storno_gekoppeld'), eq(auditLog.entityId, storno.id)))
				.get()
		).toBeDefined();
		expect(correctionInfo(db, storno.id)?.auto).toBe(true);
		// Verrekend in augustus. In september staan alleen de contributie (−€20) en de storno
		// daarvan die nog op te controleren staat (+€20); telde de energiestorno daar, dan −€49,95.
		expect(spendingByCategory(db, '2026-08').get(null)).toBe(0);
		expect(spendingByCategory(db, '2026-09').get(null)).toBe(0);
	});

	it('zonder end-to-end-kenmerk op te controleren, met de koppellijst', () => {
		const summary = importFixture('camt053-storno.xml');
		expect(summary.reversals.reviewCount).toBe(1);
		const storno = byRef('STO-0004');
		expect(storno).toMatchObject({ correctionOf: null, status: 'te_controleren' });
		expect(correctionCandidates(db, storno.id).candidates.map((c) => c.id)).toEqual([
			byRef('STO-0003').id
		]);
	});

	it('twee boekingen met hetzelfde kenmerk: niet raden', () => {
		const base: ImportRecord = {
			accountIban: 'NL12SNSB0123456789',
			date: '2026-09-01',
			amountCents: -1000,
			counterparty: 'Energie Test B.V.',
			counterIban: 'NL20INGB0001234567',
			description: 'Termijn',
			bankReference: null,
			endToEndId: 'E2E-DUBBEL'
		};
		const summary = importRecords(
			db,
			[
				base,
				{ ...base, date: '2026-09-02', description: 'Termijn 2' },
				{ ...base, date: '2026-09-05', amountCents: 1000, reversal: true }
			],
			'camt053'
		);
		expect(summary.reversals).toEqual({ linked: [], reviewCount: 1 });
	});

	it('een storno die niet past, koppelt niet automatisch', () => {
		const base: ImportRecord = {
			accountIban: 'NL12SNSB0123456789',
			date: '2026-09-01',
			amountCents: -1000,
			counterparty: 'Energie Test B.V.',
			counterIban: 'NL20INGB0001234567',
			description: 'Termijn',
			bankReference: null,
			endToEndId: 'E2E-TE-VEEL'
		};
		const summary = importRecords(
			db,
			[base, { ...base, date: '2026-09-05', amountCents: 1500, reversal: true }],
			'camt053'
		);
		expect(summary.reversals).toEqual({ linked: [], reviewCount: 1 });
	});

	it('dezelfde export nog eens: niets dubbel, geen tweede koppeling', () => {
		importFixture('camt053-storno.xml');
		const again = importFixture('camt053-storno.xml');
		expect(again.newCount).toBe(0);
		expect(again.reversals).toEqual({ linked: [], reviewCount: 0 });
	});

	it('een eerdere import zonder kenmerk krijgt het alsnog, zodat de storno later past', () => {
		const { format, records } = parseBankFile(file('camt053-storno.xml'));
		// Eerste import: alleen het origineel, alsof het kenmerk nog niet gelezen werd
		importRecords(db, [{ ...records[0]!, endToEndId: undefined }], format);
		expect(byRef('STO-0001').endToEndId).toBeNull();
		importRecords(db, records, format);
		expect(byRef('STO-0001').endToEndId).toBe('E2E-INC-0001');
		expect(byRef('STO-0002').correctionOf).toBe(byRef('STO-0001').id);
	});

	it('met één tik ongedaan te maken vanaf het importoverzicht', async () => {
		importFixture('camt053-storno.xml');
		const storno = byRef('STO-0002');
		const form = new FormData();
		form.set('id', storno.id);
		const event = fakeEvent({ path: '/import', routeId: '/(app)/import', method: 'POST' });
		const request = new Request(`${ORIGIN}/import?/undoReversal`, {
			method: 'POST',
			body: form,
			headers: { origin: ORIGIN }
		});
		const result = await importActions.undoReversal!({ ...event, request } as never);
		expect(result).toEqual({ undone: storno.id });
		expect(byRef('STO-0002')).toMatchObject({ correctionOf: null, status: 'te_controleren' });
	});
});

describe('koppelen op de detailpagina', () => {
	async function post(id: string, action: string, fields: Record<string, string>) {
		const form = new FormData();
		for (const [k, v] of Object.entries(fields)) form.set(k, v);
		const event = fakeEvent({
			path: `/transacties/${id}`,
			routeId: '/(app)/transacties/[id]',
			method: 'POST',
			params: { id }
		});
		const request = new Request(`${ORIGIN}/transacties/${id}?/${action}`, {
			method: 'POST',
			body: form,
			headers: { origin: ORIGIN }
		});
		return (txActions as Record<string, (e: never) => Promise<unknown>>)[action]!({
			...event,
			request
		} as never);
	}

	it('koppelt een retour, wisselt naar alleen mijn deel en maakt weer los', async () => {
		const bol = tx({
			amountCents: -9000,
			counterparty: 'Bol.com',
			categoryId: cat('Elektronica'),
			share: { people: 3, with: ['Sanne', 'Tim'] }
		});
		const retour = tx({ amountCents: 3000, counterparty: 'Bol.com', date: '2026-10-05' });
		expect(await post(retour, 'link', { target: `retour:${bol}` })).toEqual({ linked: true });
		expect(spent('2026-09', 'Elektronica')).toBe(2000);
		expect(await post(retour, 'correctionMode', { mode: 'mijn_deel' })).toEqual({ linked: true });
		expect(spent('2026-09', 'Elektronica')).toBe(0);
		expect(outstanding(bol).map((p) => p.open)).toEqual([3000, 3000]);
		expect(await post(retour, 'unlinkCorrection', {})).toEqual({ unlinked: true });
		expect(row(retour).status).toBe('te_controleren');
	});

	it('weigert een ongeldig doel', async () => {
		const retour = tx({ amountCents: 3000, date: '2026-10-05' });
		const result = (await post(retour, 'link', { target: 'retour:geen-uuid' })) as {
			status: number;
		};
		expect(result.status).toBe(400);
	});

	it('weigert meer terug dan het origineel', async () => {
		const jas = tx({ amountCents: -2000 });
		const retour = tx({ amountCents: 3000, date: '2026-10-05' });
		const result = (await post(retour, 'link', { target: `retour:${jas}` })) as {
			status: number;
		};
		expect(result.status).toBe(400);
		expect(row(retour).correctionOf).toBeNull();
	});
});
