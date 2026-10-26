import { addDays, isIsoDate, toIsoDate } from '../../dates.ts';
import { MAX_CENTS, parseDecimal } from '../../money.ts';
import {
	PAYMENT_METHODS,
	type LineKind,
	type ModelConfidence,
	type PaymentMethod,
	type ReceiptOutput
} from './schema.ts';

// Controles in code op de uitvoer van Haiku (spec: Bonnetjes en koppelen, Verwerking stap 4 en 5).
// Een veld is alleen zeker als het model het zeker noemt én alle controles slagen; bij twijfel
// van het model wordt het controleren, en een lege waarde of een mislukte controle is onzeker.

/** Uitkomst per veld en per bon; dezelfde waarden als `receipts.status`. */
export type FieldStatus = 'zeker' | 'controleren' | 'onzeker';

export type CheckFailure =
	| 'leeg'
	| 'onleesbaar'
	| 'ongeldig'
	| 'niet_positief'
	| 'nul'
	| 'in_de_toekomst'
	| 'te_oud'
	| 'regels_kloppen_niet';

export interface CheckedField<T> {
	value: T | null;
	status: FieldStatus;
	modelConfidence: ModelConfidence;
	/** Notitie van het model: onbetrouwbare tekst, nooit als HTML tonen. */
	note: string;
	failures: CheckFailure[];
}

export interface CheckedLine {
	description: string;
	/** Bedrag met het teken waarmee het meetelt in het totaal. */
	cents: number;
	kind: LineKind;
}

export interface CheckedReceipt {
	store: CheckedField<string>;
	date: CheckedField<string>;
	totalCents: CheckedField<number>;
	currency: CheckedField<string>;
	paymentMethod: CheckedField<PaymentMethod>;
	lines: CheckedLine[];
	/** `null` als het model geen (bruikbare) regels gaf; dan is er niets op te tellen. */
	linesSumCents: number | null;
	/** Slechtste uitkomst van winkel, datum, totaal en valuta. */
	outcome: FieldStatus;
}

/** Hoeveel de opgetelde regels van het totaal mogen afwijken (spec: €0,05). */
export const LINE_TOLERANCE_CENTS = 5;
/** Hoe oud een bon mag zijn voordat hij altijd langs de review-inbox gaat. */
export const MAX_AGE_DAYS = 60;

const NEGATIVE_KINDS: ReadonlySet<LineKind> = new Set(['korting', 'bonus', 'statiegeld_retour']);
const CURRENCY = /^[A-Z]{3}$/;

function status(
	value: unknown,
	confidence: ModelConfidence,
	failures: CheckFailure[]
): FieldStatus {
	if (value === null || failures.length > 0) return 'onzeker';
	if (confidence === 'zeker') return 'zeker';
	if (confidence === 'twijfel') return 'controleren';
	return 'onzeker';
}

function build<T>(
	raw: { zekerheid: ModelConfidence; notitie: string },
	value: T | null,
	failures: CheckFailure[]
): CheckedField<T> {
	// Een waarde naast "onleesbaar" is tegenstrijdig: dan liever niets dan een gok
	if (raw.zekerheid === 'onleesbaar' && value !== null) failures.push('onleesbaar');
	return {
		value,
		status: status(value, raw.zekerheid, failures),
		modelConfidence: raw.zekerheid,
		note: raw.notitie.trim(),
		failures
	};
}

function readText(text: string, failures: CheckFailure[]): string | null {
	const t = text.trim();
	if (t === '') {
		failures.push('leeg');
		return null;
	}
	return t;
}

/** Bedrag uit het model: alleen de strikte machinevorm `12.34`, nooit parseFloat. */
export function parseModelAmount(text: string): number | null {
	const t = text.trim().replace(/^−/, '-');
	if (!/^-?\d+(?:\.\d{1,2})?$/.test(t)) return null;
	const cents = parseDecimal(t);
	return cents !== null && Math.abs(cents) <= MAX_CENTS ? cents : null;
}

/** Bedrag zoals het meetelt in het totaal: kortingen en ingeleverd statiegeld altijd negatief. */
export function signedLineCents(cents: number, kind: LineKind): number {
	return NEGATIVE_KINDS.has(kind) ? -Math.abs(cents) : cents;
}

export function checkReceipt(output: ReceiptOutput, now: Date): CheckedReceipt {
	// Winkel
	const storeFailures: CheckFailure[] = [];
	const store = build(output.winkel, readText(output.winkel.waarde, storeFailures), storeFailures);

	const dateField = checkDate(output.datum, now);

	// Regels: alleen optellen als ze allemaal leesbaar zijn
	const lines: CheckedLine[] = [];
	let linesValid = output.regels.length > 0;
	for (const line of output.regels) {
		const cents = parseModelAmount(line.bedrag);
		if (cents === null) {
			linesValid = false;
			continue;
		}
		lines.push({
			description: line.omschrijving.trim(),
			cents: signedLineCents(cents, line.soort),
			kind: line.soort
		});
	}
	const linesSumCents = linesValid ? lines.reduce((sum, l) => sum + l.cents, 0) : null;

	// Totaal: aanwezig, positief, en gelijk aan de regels (als die er zijn)
	const totalFailures: CheckFailure[] = [];
	let total: number | null = null;
	const totalText = readText(output.totaal.waarde, totalFailures);
	if (totalText !== null) {
		total = parseModelAmount(totalText);
		if (total === null) totalFailures.push('ongeldig');
		else if (total <= 0) totalFailures.push('niet_positief');
		else if (linesSumCents !== null && Math.abs(linesSumCents - total) > LINE_TOLERANCE_CENTS) {
			totalFailures.push('regels_kloppen_niet');
		}
	}
	const totalField = build(output.totaal, total, totalFailures);

	const currencyField = checkCurrency(output.valuta);

	// Betaalwijze: alleen informatief, telt niet mee in de uitkomst
	const paymentFailures: CheckFailure[] = [];
	const method = output.betaalwijze.waarde;
	const paymentValue: PaymentMethod | null =
		method !== '' && PAYMENT_METHODS.includes(method) ? method : null;
	if (paymentValue === null) paymentFailures.push('leeg');
	const paymentField = build(output.betaalwijze, paymentValue, paymentFailures);

	return {
		store,
		date: dateField,
		totalCents: totalField,
		currency: currencyField,
		paymentMethod: paymentField,
		lines,
		linesSumCents,
		outcome: worst([store.status, dateField.status, totalField.status, currencyField.status])
	};
}

type RawField = { waarde: string; zekerheid: ModelConfidence; notitie: string };

/** Datum: geldig, niet in de toekomst en niet ouder dan 60 dagen. */
function checkDate(raw: RawField, now: Date): CheckedField<string> {
	const failures: CheckFailure[] = [];
	let date = readText(raw.waarde, failures);
	if (date !== null) {
		const today = toIsoDate(now);
		if (!isIsoDate(date)) {
			failures.push('ongeldig');
			date = null;
		} else if (date > today) {
			failures.push('in_de_toekomst');
		} else if (date < addDays(today, -MAX_AGE_DAYS)) {
			failures.push('te_oud');
		}
	}
	return build(raw, date, failures);
}

/** Valuta: een ISO 4217-code van drie letters. */
function checkCurrency(raw: RawField): CheckedField<string> {
	const failures: CheckFailure[] = [];
	let currency = readText(raw.waarde, failures);
	if (currency !== null) {
		currency = currency.toUpperCase();
		if (!CURRENCY.test(currency)) {
			failures.push('ongeldig');
			currency = null;
		}
	}
	return build(raw, currency, failures);
}

// Een screenshot van een bankapp met meerdere transacties (spec: Verwerking stap 6). Per
// transactie dezelfde regels als bij een bon: zeker alleen als het model zeker is én de
// controles slagen. Een lijst boekt nooit vanzelf; de uitkomst bepaalt alleen wat er is
// aangevinkt als je hem bevestigt.

export interface CheckedListItem {
	date: CheckedField<string>;
	counterparty: CheckedField<string>;
	/** Met teken: negatief is afgeschreven. In de valuta van `currency`, in centen. */
	amountCents: CheckedField<number>;
	currency: CheckedField<string>;
	/** Slechtste uitkomst van de vier velden. */
	outcome: FieldStatus;
}

export interface CheckedList {
	items: CheckedListItem[];
	/** Slechtste uitkomst van de transacties; onzeker als er geen enkele te lezen was. */
	outcome: FieldStatus;
}

export function checkList(output: ReceiptOutput, now: Date): CheckedList {
	const items = output.transacties.map((t): CheckedListItem => {
		const date = checkDate(t.datum, now);

		const nameFailures: CheckFailure[] = [];
		const counterparty = build(
			t.tegenpartij,
			readText(t.tegenpartij.waarde, nameFailures),
			nameFailures
		);

		// Bedrag: aanwezig, leesbaar en niet nul; het teken blijft staan
		const amountFailures: CheckFailure[] = [];
		let amount: number | null = null;
		const amountText = readText(t.bedrag.waarde, amountFailures);
		if (amountText !== null) {
			amount = parseModelAmount(amountText);
			if (amount === null) amountFailures.push('ongeldig');
			else if (amount === 0) amountFailures.push('nul');
		}
		const amountCents = build(t.bedrag, amount, amountFailures);

		const currency = checkCurrency(t.valuta);
		return {
			date,
			counterparty,
			amountCents,
			currency,
			outcome: worst([date.status, counterparty.status, amountCents.status, currency.status])
		};
	});
	return {
		items,
		outcome: items.length === 0 ? 'onzeker' : worst(items.map((i) => i.outcome))
	};
}

const RANK: Record<FieldStatus, number> = { zeker: 0, controleren: 1, onzeker: 2 };

export function worst(statuses: FieldStatus[]): FieldStatus {
	return statuses.reduce<FieldStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), 'zeker');
}
