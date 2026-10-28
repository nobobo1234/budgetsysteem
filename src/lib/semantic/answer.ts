import { formatCents } from '../money.ts';
import { PRODUCT_GROUP_LABEL } from '../productGroups.ts';
import {
	GROUPING_LABEL,
	MEASURE_LABEL,
	PERIOD_LABEL,
	SORT_LABEL,
	type Grouping,
	type Measure,
	type Query
} from './format.ts';
import type { Refusal, ResolvedQuery } from './resolve.ts';

// Het antwoord van het vraagveld (spec: Vraagveld, Antwoord): het getal of de lijst komt uit
// code, en de zin erbij uit een vaste template ("€ 1.284,50 aan Uit eten en bezorgen, 1 januari
// tot en met 27 oktober 2026"). Geen enkel woord van het antwoord komt van het model; alleen de
// aannames van het model staan eronder, na de controle in `modelTextFailure`.

export interface AnswerRow {
	/** Uniek binnen het antwoord; bij een maand `2026-03`, zodat "op tijd" kan sorteren */
	key: string;
	/** Een maand, categorie, tegenpartij, tag of productgroep, als gewone tekst */
	label: string;
	/** Centen, of een aantal bij de maat `aantal` */
	value: number;
}

export interface Answer {
	measure: Measure;
	grouping: Grouping;
	/** `aantal` telt transacties; al het andere is centen */
	unit: 'cent' | 'aantal';
	/** Het getal; bij een lijst het totaal van alle rijen (ook die buiten de limiet vallen) */
	value: number;
	/** Bij een groepering de rijen, gesorteerd en ingekort tot de limiet */
	rows: AnswerRow[] | null;
	/** Hoeveel rijen er waren vóór de limiet */
	rowCount: number;
	sentence: string;
	/** Eerst de datums en definities van code, dan wat het model aannam */
	assumptions: string[];
	/** Het vraagformaat als leesbare regels ("maat: uitgegeven") */
	query: string[];
}

const amount = (cents: number) => formatCents(cents);

/** "Uit eten en bezorgen", "Boodschappen en Vervoer", "Wonen, Energie en water en Vervoer". */
export function listText(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? '';
	return `${items.slice(0, -1).join(', ')} en ${items.at(-1)}`;
}

/**
 * Waarop de vraag betrekking heeft: " aan Boodschappen bij Albert Heijn van SNS". `to` is het
 * voorzetsel voor categorieën: "aan" bij uitgaven, "voor" bij een limiet, "in" bij inkomsten.
 */
function subject(r: ResolvedQuery, to = 'aan'): string {
	const parts: string[] = [];
	if (r.productGroup) parts.push(`${to} ${PRODUCT_GROUP_LABEL[r.productGroup]}`);
	else if (r.categoryLabels.length > 0) parts.push(`${to} ${listText(r.categoryLabels)}`);
	if (r.counterparty) parts.push(`bij ${r.counterparty}`);
	if (r.tag) parts.push(`met de tag ${r.tag.name}`);
	if (r.account) parts.push(`van ${r.account.name}`);
	return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

const countText = (n: number) => `${n} ${n === 1 ? 'uitgave' : 'uitgaven'}`;

/** De zin bij het antwoord, uit een vaste template per maat. */
export function answerSentence(r: ResolvedQuery, value: number, monthsUsed = 0): string {
	const range = r.period.range;
	const of = subject(r);
	const grouped = r.query.groeperen !== 'geen';
	switch (r.query.maat) {
		case 'uitgegeven':
			if (grouped)
				return `${amount(value)} uitgegeven${of}, ${GROUPING_LABEL[r.query.groeperen]}, ${range}`;
			// Per saldo kan er meer terugkomen dan er uitging, zoals een losse terugbetaling
			return value < 0
				? `${amount(-value)} per saldo terug${of}, ${range}`
				: `${amount(value)}${of || ' aan uitgaven'}, ${range}`;
		case 'aantal':
			return `${countText(value)}${of}, ${range}`;
		case 'gemiddeld_per_maand':
			return `Gemiddeld ${amount(value)} per maand${of || ' aan uitgaven'}, over ${monthsUsed} ${
				monthsUsed === 1 ? 'volle maand' : 'volle maanden'
			} (${range})`;
		case 'vaste_lasten':
			return `${amount(value)} aan vaste lasten${subject(r, 'in')}, ${range}`;
		case 'limiet':
			return `Limiet van ${amount(value)}${subject(r, 'voor')}, ${range}`;
		case 'resterend':
			return value >= 0
				? `Nog ${amount(value)} vrij${subject(r, 'voor')}, ${range}`
				: `${amount(-value)} over de limiet${subject(r, 'voor')}, ${range}`;
		case 'inkomsten':
			return `${amount(value)} aan inkomsten${subject(r, 'in')}, ${range}`;
		case 'netto':
			return value >= 0
				? `${amount(value)} meer binnengekomen dan uitgegeven, ${range}`
				: `${amount(-value)} meer uitgegeven dan binnengekomen, ${range}`;
		case 'te_krijgen':
			return `Nog ${amount(value)} te krijgen van anderen`;
	}
}

/** Waarom code een vraag weigerde, in gewone taal. */
export function refusalText(refusal: Refusal, detail: string | null = null): string {
	const name = detail ? ` "${detail}"` : '';
	switch (refusal) {
		case 'categorie':
			return `De categorie${name} ken ik niet, of er staan geen uitgaven of inkomsten in.`;
		case 'groep':
			return `De groep${name} ken ik niet.`;
		case 'tag':
			return `De tag${name} ken ik niet.`;
		case 'rekening':
			return `De rekening${name} ken ik niet.`;
		case 'tegenpartij':
			return 'Die tegenpartij vind ik niet in je transacties.';
		case 'tegenpartij_vaag':
			return 'Te veel tegenpartijen passen bij die naam. Typ de naam iets vollediger.';
		case 'filter':
			return 'Die combinatie kan ik niet uitrekenen.';
		case 'groepering':
			return 'Zo kan ik dit niet uitsplitsen.';
		case 'productgroep':
			return 'Productgroepen gaan alleen over boodschappen met een bon, zonder andere filters.';
		case 'een_maand':
			return 'Wat er nog vrij is, reken ik per maand uit. Vraag het voor één maand.';
		case 'geen_volle_maand':
			return 'Een gemiddelde per maand heeft minstens één volle maand nodig.';
		case 'periode_datum':
			return 'Die datum bestaat niet.';
		case 'periode_volgorde':
			return 'Het begin van de periode ligt na het eind.';
		case 'periode_toekomst':
			return 'Die periode moet nog beginnen; daar zijn nog geen cijfers van.';
	}
}

/** Voorbeelden van vragen die wel kunnen, bij een weigering (spec: Vraagveld, Antwoord). */
export const CAN_DO_EXAMPLES: Record<'standaard' | Measure, string> = {
	standaard: 'Hoeveel gaf ik vorige maand uit aan boodschappen?',
	uitgegeven: 'Hoeveel gaf ik dit jaar uit aan uit eten?',
	aantal: 'Hoe vaak betaalde ik deze maand bij Albert Heijn?',
	gemiddeld_per_maand: 'Wat geef ik gemiddeld per maand uit aan vervoer?',
	vaste_lasten: 'Hoeveel gingen er vorige maand naar vaste lasten?',
	limiet: 'Wat is mijn limiet voor boodschappen deze maand?',
	resterend: 'Hoeveel heb ik deze maand nog vrij?',
	inkomsten: 'Hoeveel kwam er dit jaar binnen?',
	netto: 'Hoeveel hield ik vorige maand over?',
	te_krijgen: 'Hoeveel krijg ik nog terug van anderen?'
};

/** Het vraagformaat als leesbare regels, voor "de gegenereerde query" onder het antwoord. */
export function queryLines(q: Query): string[] {
	const f = q.filters;
	const lines = [
		`maat: ${MEASURE_LABEL[q.maat]}`,
		'woord' in q.periode
			? `periode: ${PERIOD_LABEL[q.periode.woord]}`
			: `periode: ${q.periode.van} tot en met ${q.periode.tot}`
	];
	if (f.categorieen.length > 0) lines.push(`categorie: ${listText(f.categorieen)}`);
	if (f.groepen.length > 0) lines.push(`groep: ${listText(f.groepen)}`);
	if (f.tegenpartij !== null) lines.push(`tegenpartij bevat: ${f.tegenpartij}`);
	if (f.tag !== null) lines.push(`tag: ${f.tag}`);
	if (f.rekening !== null) lines.push(`rekening: ${f.rekening}`);
	if (f.productgroep !== null) lines.push(`productgroep: ${PRODUCT_GROUP_LABEL[f.productgroep]}`);
	if (q.groeperen !== 'geen') {
		lines.push(`groeperen: ${GROUPING_LABEL[q.groeperen]}`, `sorteren: ${SORT_LABEL[q.sorteren]}`);
		lines.push(`limiet: ${q.limiet ?? 'alle rijen'}`);
	}
	return lines;
}
