import { createHash } from 'node:crypto';
import { isValidDate } from '../../dates.ts';
import { parseDecimal } from '../../money.ts';
import { detectDelimiter, parseCsv } from './csv.ts';
import {
	ImportError,
	MAX_IMPORT_BYTES,
	openingFromClosing,
	type ImportRecord,
	type ParsedBankFile
} from './types.ts';

// De CSV-export van Revolut (Nederlandse taal, alle valuta in één bestand). Kolommen:
// Type, Product, Startdatum, Datum voltooid, Beschrijving, Bedrag, Kosten, Valuta, Status, Saldo.
// Bedragen met een punt (`-13.98`), datums als `2025-08-06 16:59:33`. Per valuta geldt:
// vorig saldo + Bedrag − Kosten = Saldo. Dat controleren we, zodat een verkeerde aanname over
// het formaat het bestand weigert in plaats van ongemerkt verkeerde bedragen boekt.
//
// Vreemde valuta worden omgerekend tegen de koers die je zelf betaalde: elke wissel voegt
// kronen (of dollars) toe aan een potje met de euro's die ze kostten, wisselkosten inbegrepen.
// Een betaling neemt naar verhouding euro's uit dat potje (gemiddelde kostprijs). Wissels zelf
// zijn geen uitgave en worden niet geboekt; wissel je terug naar euro, dan wordt alleen het
// verschil met de kostprijs geboekt als koersverschil.

const COLUMNS = {
	type: 'type',
	product: 'product',
	started: 'startdatum',
	completed: 'datum voltooid',
	description: 'beschrijving',
	amount: 'bedrag',
	fee: 'kosten',
	currency: 'valuta',
	state: 'status',
	balance: 'saldo'
} as const;

type Layout = Record<keyof typeof COLUMNS, number>;

type Kind = 'gewoon' | 'opwaarderen' | 'wisselen';

const TYPES: Record<string, Kind> = {
	Kaartbetaling: 'gewoon',
	Kaartterugbetaling: 'gewoon',
	Overschrijving: 'gewoon',
	'In rekening brengen': 'gewoon',
	// Geld erbij vanaf je eigen bankrekening of kaart: een eigen overboeking
	'Geld toevoegen': 'opwaarderen',
	Wisselen: 'wisselen'
};

const DONE = 'VOLTOOID';
/** Teruggedraaid of nog niet afgerond: telt niet mee. Een lopende boeking komt in een latere export. */
const SKIPPED = new Set(['ONGEDAAN GEMAAKT', 'IN BEHANDELING']);
const PRODUCT = 'Betaalrekening';

const DATETIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const CURRENCY = /^[A-Z]{3}$/;

interface Row {
	index: number;
	kind: Kind;
	type: string;
	started: string;
	completed: string;
	description: string;
	amount: number;
	fee: number;
	currency: string;
	balance: number;
	/** Bedrag − Kosten: wat er echt bij of af ging, in centen van de valuta */
	delta: number;
	reference: string;
}

function layoutFromHeader(header: string[]): Layout | null {
	const lower = header.map((h) => h.trim().toLowerCase());
	const out: Partial<Layout> = {};
	for (const [key, name] of Object.entries(COLUMNS) as [keyof Layout, string][]) {
		const idx = lower.indexOf(name);
		if (idx === -1) return null;
		out[key] = idx;
	}
	return out as Layout;
}

/** Herkent de Revolut-export aan de kolomkoppen op de eerste regel. */
export function isRevolutCsv(text: string): boolean {
	const clean = text.startsWith('\uFEFF') ? text.slice(1) : text;
	const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
	const header = parseCsv(firstLine, detectDelimiter(firstLine))[0] ?? [];
	return layoutFromHeader(header) !== null;
}

function validDateTime(s: string): boolean {
	const m = DATETIME.exec(s);
	if (!m) return false;
	const [, y, mo, d, h, mi, se] = m.map(Number) as number[];
	return isValidDate(y!, mo!, d!) && h! < 24 && mi! < 60 && se! < 60;
}

/** Tekst uit het bestand in een foutmelding: kort en zonder rare tekens. */
function quote(s: string): string {
	return `"${s.replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 40)}"`;
}

function referenceKey(r: {
	started: string;
	type: string;
	currency: string;
	amount: number;
	description: string;
}) {
	return createHash('sha256')
		.update([r.started, r.type, r.currency, r.amount, r.description].join('\u001f'))
		.digest('hex')
		.slice(0, 32);
}

function parseRows(text: string): Row[] {
	const clean = text.startsWith('\uFEFF') ? text.slice(1) : text;
	const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
	const rows = parseCsv(clean, detectDelimiter(firstLine));
	const layout = layoutFromHeader(rows[0] ?? []);
	if (!layout) throw new ImportError('Onbekende kolommen in de Revolut-export.');

	const out: Row[] = [];
	// Identieke boekingen (zelfde seconde, bedrag en omschrijving) krijgen een volgnummer
	const occurrences = new Map<string, number>();
	for (const [i, row] of rows.slice(1).entries()) {
		const cell = (key: keyof Layout) => (row[layout[key]] ?? '').trim();
		const state = cell('state');
		if (SKIPPED.has(state)) continue;
		if (state !== DONE) throw new ImportError(`Onbekende Revolut-status ${quote(state)}.`);
		const type = cell('type');
		const kind = TYPES[type];
		if (!kind) throw new ImportError(`Onbekend Revolut-type ${quote(type)}.`);
		if (cell('product') !== PRODUCT) {
			throw new ImportError(
				`Alleen de Revolut-betaalrekening wordt ondersteund, niet ${quote(cell('product'))}.`
			);
		}

		const started = cell('started');
		const completed = cell('completed');
		const currency = cell('currency');
		const amount = parseDecimal(cell('amount'));
		const fee = parseDecimal(cell('fee') || '0');
		const balance = parseDecimal(cell('balance'));
		if (!validDateTime(started) || !validDateTime(completed)) {
			throw new ImportError('Een regel in de Revolut-export heeft geen geldige datum.');
		}
		if (!CURRENCY.test(currency)) {
			throw new ImportError('Een regel in de Revolut-export heeft geen geldige valuta.');
		}
		if (amount === null || fee === null || balance === null) {
			throw new ImportError('Een regel in de Revolut-export heeft geen geldig bedrag of saldo.');
		}

		const description = cell('description').slice(0, 500);
		const key = referenceKey({ started, type, currency, amount, description });
		const nth = (occurrences.get(key) ?? 0) + 1;
		occurrences.set(key, nth);
		out.push({
			index: i,
			kind,
			type,
			started,
			completed,
			description,
			amount,
			fee,
			currency,
			balance,
			delta: amount - fee,
			reference: `revolut:${key}:${nth}`
		});
	}
	return out;
}

/**
 * Controleert per valuta dat elk saldo gelijk is aan het vorige plus Bedrag − Kosten, en geeft
 * het beginsaldo per valuta terug. Boekingen in dezelfde seconde mogen in elke volgorde staan.
 */
function checkBalances(rows: Row[]): Map<string, number> {
	const opening = new Map<string, number>();
	const byCurrency = Map.groupBy(rows, (r) => r.currency);
	for (const [currency, list] of byCurrency) {
		const sorted = list.toSorted(
			(a, b) => a.completed.localeCompare(b.completed) || a.index - b.index
		);
		const first = sorted[0]!;
		let balance = first.balance - first.delta;
		opening.set(currency, balance);
		let i = 0;
		while (i < sorted.length) {
			let end = i;
			while (end < sorted.length && sorted[end]!.completed === sorted[i]!.completed) end++;
			const group = sorted.slice(i, end);
			while (group.length > 0) {
				const next = group.findIndex((r) => r.balance === balance + r.delta);
				if (next === -1) {
					throw new ImportError(
						`Het ${currency}-saldo in de Revolut-export klopt niet met de boekingen; er is niets geïmporteerd.`
					);
				}
				balance = group[next]!.balance;
				group.splice(next, 1);
			}
			i = end;
		}
	}
	return opening;
}

/** `x * num / den`, afgerond op hele centen (halven van nul af). Alles blijft binnen 2^53. */
function scale(x: number, num: number, den: number): number {
	const exact = (x * num) / den;
	return Math.sign(exact) * Math.round(Math.abs(exact));
}

interface Pot {
	/** Hoeveel er in het potje zit, in centen van de valuta */
	qty: number;
	/** Wat dat in euro's kostte, in centen */
	cost: number;
	/** Laatste bekende koers (kostprijs per hoeveelheid), voor als het potje leeg is */
	rate: { cost: number; qty: number } | null;
	/** Deel van het beginsaldo waarvan de kostprijs geschat is */
	estimated: number;
}

interface Exchange {
	/** Boekingen waarbij valuta eraf ging */
	from: Row[];
	/** Boekingen waarbij valuta erbij kwam, allemaal in `target` */
	to: Row[];
	target: string;
}

/** Leest de Revolut-export en rekent vreemde valuta om naar euro tegen je eigen wisselkoers. */
export function parseRevolutCsv(text: string): ImportRecord[] {
	return readRevolutCsv(text).records;
}

/**
 * Als `parseRevolutCsv`, plus het startsaldo in euro: het euro-saldo aan het eind plus wat de
 * vreemde valuta die er nog staan kostten, min alle boekingen. Zo telt het saldo vreemde valuta
 * tegen de koers die je betaalde, net als de boekingen zelf.
 */
export function readRevolutCsv(text: string): ParsedBankFile {
	if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
		throw new ImportError('Het bestand is groter dan 20 MB.');
	}
	const rows = parseRows(text);
	if (rows.length === 0) throw new ImportError('Het bestand bevat geen voltooide boekingen.');
	const opening = checkBalances(rows);

	const ordered = rows.toSorted(
		(a, b) => a.completed.localeCompare(b.completed) || a.index - b.index
	);

	// Een wissel is een groep boekingen met dezelfde starttijd: valuta eraf en valuta erbij.
	// Meestal een paar, maar wissel je meerdere valuta tegelijk terug (alles naar euro), dan
	// staan ze in dezelfde seconde. Welke helft bij welke hoort is dan niet te zien; dat hoeft
	// ook niet zolang alles naar één valuta gaat: de kostprijs gaat als geheel mee.
	const exchanges = new Map<Row, Exchange>();
	for (const group of Map.groupBy(
		ordered.filter((r) => r.kind === 'wisselen' && r.delta !== 0),
		(r) => r.started
	).values()) {
		const from = group.filter((r) => r.delta < 0);
		const to = group.filter((r) => r.delta > 0);
		const target = to[0]?.currency;
		if (!target || from.length === 0 || from.some((r) => r.currency === target)) {
			throw new ImportError('Een wissel in de Revolut-export heeft geen passende tegenboeking.');
		}
		if (to.some((r) => r.currency !== target)) {
			throw new ImportError(
				'Wissels naar verschillende valuta in dezelfde seconde zijn niet uit elkaar te halen.'
			);
		}
		const exchange = { from, to, target };
		for (const r of group) exchanges.set(r, exchange);
	}

	// Koers van de eerste wissel tussen euro en elke vreemde valuta, voor een beginsaldo met
	// onbekende kostprijs (de export begint pas na de wissel waarmee je het kocht)
	const firstRate = new Map<string, { cost: number; qty: number }>();
	const sum = (list: Row[]) => list.reduce((total, r) => total + Math.abs(r.delta), 0);
	for (const { from, to, target } of new Set(exchanges.values())) {
		const source = from[0]!.currency;
		if (from.some((r) => r.currency !== source)) continue;
		if (source === 'EUR' && !firstRate.has(target)) {
			firstRate.set(target, { cost: sum(from), qty: sum(to) });
		} else if (target === 'EUR' && !firstRate.has(source)) {
			firstRate.set(source, { cost: sum(to), qty: sum(from) });
		}
	}

	const pots = new Map<string, Pot>();
	const pot = (currency: string): Pot => {
		let p = pots.get(currency);
		if (!p) {
			const qty = opening.get(currency) ?? 0;
			const rate = firstRate.get(currency) ?? null;
			if (qty !== 0 && !rate) {
				throw new ImportError(
					`Geen wisselkoers voor ${currency} in de Revolut-export; exporteer ook de periode waarin je ${currency} kocht.`
				);
			}
			const cost = rate ? scale(qty, rate.cost, rate.qty) : 0;
			p = { qty, cost, rate: qty > 0 ? { cost, qty } : null, estimated: Math.max(qty, 0) };
			pots.set(currency, p);
		}
		return p;
	};

	/** Haalt `delta` uit (of stopt het in) het potje en geeft de waarde in euro. */
	const convert = (currency: string, delta: number): { cents: number; estimated: boolean } => {
		if (currency === 'EUR') return { cents: delta, estimated: false };
		const p = pot(currency);
		let estimated = false;
		let cents: number;
		if (p.qty > 0 && (delta > 0 || -delta <= p.qty)) {
			cents = scale(delta, p.cost, p.qty);
		} else {
			// Meer uitgeven dan er in het potje zit: tegen de laatst bekende koers
			const rate = p.rate ?? firstRate.get(currency);
			if (!rate) {
				throw new ImportError(
					`Geen wisselkoers voor ${currency} in de Revolut-export; exporteer ook de periode waarin je ${currency} kocht.`
				);
			}
			if (!p.rate) estimated = true;
			cents =
				p.qty > 0
					? -p.cost + scale(delta + p.qty, rate.cost, rate.qty)
					: scale(delta, rate.cost, rate.qty);
		}
		if (p.estimated > 0 && delta < 0) {
			estimated = true;
			p.estimated = Math.max(0, p.estimated + delta);
		}
		p.qty += delta;
		p.cost += cents;
		if (p.qty > 0) p.rate = { cost: p.cost, qty: p.qty };
		return { cents, estimated };
	};

	const records: ImportRecord[] = [];
	const record = (r: Row, cents: number, extra: Partial<ImportRecord>): ImportRecord => ({
		accountIban: '',
		accountKind: 'revolut',
		date: r.started.slice(0, 10),
		amountCents: cents,
		counterparty: r.description.slice(0, 140),
		counterIban: null,
		description: r.description,
		bankReference: r.reference,
		...extra
	});

	const done = new Set<Row>();
	for (const r of ordered) {
		if (done.has(r)) continue;
		if (r.delta === 0) continue;
		if (r.kind === 'wisselen') {
			const { from, to, target } = exchanges.get(r)!;
			for (const x of [...from, ...to]) done.add(x);
			// Wat de verkochte valuta in euro kostte, gaat mee naar de gekochte
			const cost = from.reduce((total, x) => total - convert(x.currency, x.delta).cents, 0);
			if (target === 'EUR') {
				const result = sum(to) - cost;
				if (result !== 0) {
					// Vaste referentie, ook als de volgorde binnen de seconde per export verschilt
					const first = to.map((x) => x.reference).toSorted()[0]!;
					const sources = [...new Set(from.map((x) => x.currency))].toSorted().join(' en ');
					records.push(
						record(to[0]!, result, {
							// Niet 'Revolut': die tegenpartij is volgens de standaardregel een eigen overboeking
							counterparty: 'Koersverschil',
							description: `Koersverschil bij wisselen ${sources} naar EUR`,
							bankReference: `${first}:koersverschil`,
							internal: false
						})
					);
				}
			} else {
				const p = pot(target);
				p.qty += sum(to);
				p.cost += cost;
				if (p.qty > 0) p.rate = { cost: p.cost, qty: p.qty };
			}
			continue;
		}
		const { cents, estimated } = convert(r.currency, r.delta);
		records.push(
			record(r, cents, {
				internal: r.kind === 'opwaarderen',
				...(r.currency !== 'EUR' && { origAmountCents: r.delta, origCurrency: r.currency }),
				...(estimated && { needsReview: true })
			})
		);
	}

	const eurClosing = rows
		.filter((r) => r.currency === 'EUR')
		.reduce((total, r) => total + r.delta, opening.get('EUR') ?? 0);
	const closing = [...pots.values()].reduce((total, p) => total + p.cost, eurClosing);
	const balance = openingFromClosing(records, closing, { accountIban: '', accountKind: 'revolut' });
	return { records, balances: balance ? [balance] : [] };
}
