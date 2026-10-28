import { eq } from 'drizzle-orm';
import type { DB } from '../../../src/lib/server/db/index.ts';
import {
	accounts,
	budgets,
	categories,
	owed,
	owedPayments,
	people,
	peopleIbans,
	receiptLines,
	receipts,
	recurring,
	reservations,
	transactionSplits,
	transactions
} from '../../../src/lib/server/db/schema.ts';
import { createTag } from '../../../src/lib/server/tags.ts';

// De geanonimiseerde fixture voor de semantische laag en de vraag-eval (spec: Vraagveld, Eval):
// veertien maanden verzonnen geldzaken van september 2025 tot en met vandaag (21 oktober 2026),
// met de valkuilen uit de spec: interne overboekingen, sparen, een gesplitste bon met een
// terugbetaling, een retour die in de maand van de boeking telt, een losse terugbetaling die
// per saldo negatief is, een uitgave zonder categorie,
// een reservering voor een jaarlast, een tag, bonregels per productgroep en twee kappers met
// bijna dezelfde naam. Alleen test-IBANs (scripts/test-ibans.txt) en verzonnen namen.

export const FIXTURE_TODAY = '2026-10-21';
const FIRST_MONTH = '2025-09';

const RENT_IBAN = 'NL20INGB0001234567';
const ENERGY_IBAN = 'NL18RABO0123459876';
const HOUSEMATE_IBAN = 'NL69INGB0123456789';

export interface Fixture {
	sns: string;
	revolut: string;
	cat: (name: string) => string;
}

function months(from: string, to: string): string[] {
	const out: string[] = [];
	let [y, m] = from.split('-').map(Number) as [number, number];
	for (;;) {
		const month = `${y}-${String(m).padStart(2, '0')}`;
		if (month > to) return out;
		out.push(month);
		m++;
		if (m > 12) [y, m] = [y + 1, 1];
	}
}

/** Vult een verse database (met startcategorieën) met de fixture. */
export function buildFixture(db: DB, today = FIXTURE_TODAY): Fixture {
	const sns = db.select().from(accounts).where(eq(accounts.alias, 'sns')).get()!.id;
	const revolut = db.select().from(accounts).where(eq(accounts.alias, 'rev')).get()!.id;
	const cat = (name: string) =>
		db.select().from(categories).where(eq(categories.name, name)).get()!.id;

	const tx = (
		date: string,
		cents: number,
		counterparty: string,
		category: string | null,
		over: Partial<typeof transactions.$inferInsert> = {}
	): string | null => {
		if (date > today) return null;
		return db
			.insert(transactions)
			.values({
				amountCents: cents,
				date,
				counterparty,
				categoryId: category === null ? null : cat(category),
				accountId: sns,
				source: 'import',
				status: 'bevestigd',
				...over
			})
			.returning({ id: transactions.id })
			.get().id;
	};

	const rent = db
		.insert(recurring)
		.values({
			matchKey: `woonstichting test|${RENT_IBAN}`,
			counterparty: 'Woonstichting Test',
			counterIban: RENT_IBAN,
			interval: 'maand',
			expectedDay: 1,
			medianCents: 85000,
			minCents: 85000,
			maxCents: 85000,
			kind: 'vast',
			nextDate: '2026-11-01',
			accountId: sns,
			categoryId: cat('Wonen'),
			status: 'actief'
		})
		.returning({ id: recurring.id })
		.get().id;
	const energy = db
		.insert(recurring)
		.values({
			matchKey: `energiebedrijf test|${ENERGY_IBAN}`,
			counterparty: 'Energiebedrijf Test',
			counterIban: ENERGY_IBAN,
			interval: 'maand',
			expectedDay: 5,
			medianCents: 9500,
			minCents: 9500,
			maxCents: 9500,
			kind: 'vast',
			nextDate: '2026-11-05',
			accountId: sns,
			categoryId: cat('Energie en water'),
			status: 'actief'
		})
		.returning({ id: recurring.id })
		.get().id;
	// Een jaarpremie die uitgesmeerd wordt: elke maand een reservering
	const insurance = db
		.insert(recurring)
		.values({
			matchKey: 'verzekeraar test|',
			counterparty: 'Verzekeraar Test',
			interval: 'jaar',
			expectedDay: 1,
			medianCents: 36000,
			minCents: 36000,
			maxCents: 36000,
			kind: 'vast',
			nextDate: '2027-01-01',
			spread: true,
			accountId: sns,
			categoryId: cat('Verzekeringen'),
			status: 'actief'
		})
		.returning({ id: recurring.id })
		.get().id;

	const all = months(FIRST_MONTH, today.slice(0, 7));
	all.forEach((m, i) => {
		const d = (day: number) => `${m}-${String(day).padStart(2, '0')}`;
		tx(d(1), -85000, 'Woonstichting Test', 'Wonen', { counterIban: RENT_IBAN, recurringId: rent });
		tx(d(5), -9500, 'Energiebedrijf Test', 'Energie en water', {
			counterIban: ENERGY_IBAN,
			recurringId: energy
		});
		tx(d(24), 285000, 'Werkgever Test BV', 'Inkomen');
		// Vier keer de supermarkt, twee keer de andere
		for (const [day, base] of [
			[3, 3100],
			[10, 4250],
			[17, 2890],
			[24, 5120]
		] as const)
			tx(d(day), -(base + i * 37), 'ALBERT HEIJN 1403 UTRECHT', 'Boodschappen');
		tx(d(7), -2475, 'Jumbo Test', 'Boodschappen');
		tx(d(21), -1980, 'Jumbo Test', 'Boodschappen');
		tx(d(12), -3200, 'Pizzeria Test', 'Uit eten en bezorgen');
		tx(d(19), -(2850 + (i % 3) * 500), 'Thuisbezorgd.nl', 'Uit eten en bezorgen');
		tx(d(8), -1840, 'NS Groep', 'Vervoer', { accountId: revolut });
		tx(d(15), -1199, 'Streamdienst Test', 'Abonnementen');
		// Sparen en een eigen overboeking tellen nooit als uitgave of inkomen
		tx(d(25), -20000, 'Spaarrekening', 'Sparen en beleggen');
		tx(d(2), -10000, 'Eigen rekening Revolut', 'Interne overboeking', {
			categorySource: 'intern'
		});
		tx(d(2), 10000, 'Eigen rekening SNS', 'Interne overboeking', {
			accountId: revolut,
			categorySource: 'intern'
		});
		if (m >= '2026-01')
			db.insert(reservations)
				.values({
					recurringId: insurance,
					month: m,
					amountCents: 3000,
					categoryId: cat('Verzekeringen')
				})
				.run();
	});

	// Limieten vanaf januari; latere maanden nemen ze over
	for (const [name, limit] of [
		['Wonen', 85000],
		['Energie en water', 10000],
		['Boodschappen', 25000],
		['Uit eten en bezorgen', 8000],
		['Vervoer', 4000],
		['Abonnementen', 1500],
		['Verzekeringen', 3000],
		['Kleding', 5000]
	] as const)
		db.insert(budgets)
			.values({ month: '2026-01', categoryId: cat(name), limitCents: limit })
			.run();

	// Twee kappers met bijna dezelfde naam: "kapper" is dubbelzinnig
	tx('2026-03-11', -2800, 'Kapper Knip Test', 'Drogist en verzorging');
	tx('2026-07-09', -3100, 'Kapper Stijl Test', 'Drogist en verzorging');

	// Een retour die in de maand van de boeking telt: augustus, niet september
	const order = tx('2026-08-20', -8995, 'Zalando Test', 'Kleding')!;
	tx('2026-09-03', 8995, 'Zalando Test', 'Kleding', { correctionOf: order });
	tx('2026-09-18', -4590, 'Zalando Test', 'Kleding');

	// Een terugbetaling die de app niet aan de aankoop koppelde: per saldo negatief in september
	tx('2026-07-05', -12000, 'Bol Test', 'Elektronica');
	tx('2026-09-22', 12000, 'Bol Test', 'Elektronica');

	// Een uitgave zonder categorie
	tx('2026-10-09', -1500, 'Onbekende Winkel Test', null);

	// Een gesplitste bon: jij betaalde € 60, je deel is € 20, de huisgenoot betaalde € 40 terug
	const person = db.insert(people).values({ name: 'Huisgenoot Test' }).returning().get().id;
	db.insert(peopleIbans).values({ personId: person, iban: HOUSEMATE_IBAN }).run();
	const dinner = tx('2026-09-14', -6000, 'Pizzeria Test', 'Uit eten en bezorgen')!;
	db.insert(transactionSplits)
		.values([
			{ transactionId: dinner, categoryId: cat('Uit eten en bezorgen'), amountCents: -2000 },
			{
				transactionId: dinner,
				categoryId: cat('Terugbetaling'),
				amountCents: -4000,
				note: 'Voorgeschoten'
			}
		])
		.run();
	const post = db
		.insert(owed)
		.values({
			personId: person,
			amountCents: 4000,
			direction: 'te_krijgen',
			sourceTransactionId: dinner,
			description: 'Pizza',
			date: '2026-09-14',
			status: 'betaald'
		})
		.returning()
		.get().id;
	const repay = tx('2026-09-16', 4000, 'Huisgenoot Test', 'Terugbetaling', {
		counterIban: HOUSEMATE_IBAN
	})!;
	db.insert(owedPayments)
		.values({ transactionId: repay, personId: person, owedId: post, amountCents: 4000 })
		.run();
	// Nog te krijgen: € 23,50 voor de bioscoop
	db.insert(owed)
		.values({
			personId: person,
			amountCents: 2350,
			direction: 'te_krijgen',
			description: 'Bioscoop',
			date: '2026-10-05',
			status: 'open'
		})
		.run();

	// Een reis met een tag
	tx('2026-06-10', -42000, 'Hotel Test Lisboa', 'Reizen');
	tx('2026-06-12', -3600, 'Restaurante Test', 'Uit eten en bezorgen');
	tx('2026-06-14', -1450, 'Metro Test', 'Vervoer', { accountId: revolut });
	createTag(db, { name: 'Lissabon', startDate: '2026-06-10', endDate: '2026-06-16', hue: 220 });

	// Een bon met regels bij een boodschap in oktober (zelfde bedrag als de transactie)
	const groceries = tx('2026-10-11', -2463, 'ALBERT HEIJN 1403 UTRECHT', 'Boodschappen')!;
	const receipt = db
		.insert(receipts)
		.values({ fileId: 'fixture-bon', source: 'app', status: 'zeker', transactionId: groceries })
		.returning()
		.get().id;
	db.insert(receiptLines)
		.values(
			(
				[
					['Bananen', 'artikel', 189, 'groente_fruit'],
					['Paprika', 'artikel', 249, 'groente_fruit'],
					['Halfvolle melk', 'artikel', 119, 'zuivel_eieren'],
					['Kaas jong belegen', 'artikel', 625, 'zuivel_eieren'],
					['Kipfilet', 'artikel', 699, 'vlees_vis'],
					['Chips', 'artikel', 229, 'snacks_snoep'],
					['Wasmiddel', 'artikel', 599, 'huishouden'],
					['Bonus', 'bonus', -246, null]
				] as const
			).map(([description, kind, amountCents, productGroup], position) => ({
				receiptId: receipt,
				position,
				description,
				kind,
				amountCents,
				productGroup
			}))
		)
		.run();

	return { sns, revolut, cat };
}
