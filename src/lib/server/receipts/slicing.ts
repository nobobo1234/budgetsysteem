// Rekenwerk voor beeldformaten, los van de beeldbibliotheek zodat het zonder beelden te testen is
// (spec: Bonnetjes en koppelen, Beeldkwaliteit).
//
// Claude Haiku 5.5 valt in de hoge-resolutieklasse ("Claude 4.7 and later models"): hooguit
// 2576 px aan de lange kant en 4784 visuele tokens, waarbij een token een blok van 28×28 px is.
// Groter verkleint de API zelf, wat kleine tekst minder leesbaar maakt; daarom verkleinen we zelf
// precies tot binnen beide grenzen. Bron: https://platform.claude.com/docs/en/build-with-claude/vision

export const MAX_LONG_EDGE = 2576;
export const MAX_VISUAL_TOKENS = 4784;
export const PATCH_PX = 28;

/** Vanaf deze verhouding (lang/kort) wordt een bon in stukken gesneden. */
export const LONG_RECEIPT_RATIO = 3.5;
/** Breedte van de stukken: ruim genoeg voor bontekst, en laat stukken van 2576 px hoog toe. */
export const SLICE_SHORT_EDGE = 1288;
/** Minimale overlap tussen stukken, als deel van de stuklengte: een paar regels bontekst. */
export const SLICE_OVERLAP = 0.1;
/** Meer stukken maakt het verzoek duur en traag; daarboven wordt het smaller. */
export const MAX_SLICES = 5;

export interface Size {
	width: number;
	height: number;
}

export interface Rect extends Size {
	left: number;
	top: number;
}

export interface SlicePlan {
	/** Formaat waarnaar het hele (rechtgezette) beeld eerst verkleind wordt. */
	scaled: Size;
	/** Uitsneden binnen `scaled`; één stuk betekent niet snijden. */
	pieces: Rect[];
}

export function visualTokens(width: number, height: number): number {
	return Math.ceil(width / PATCH_PX) * Math.ceil(height / PATCH_PX);
}

export function fitsModel(width: number, height: number): boolean {
	return (
		Math.max(width, height) <= MAX_LONG_EDGE && visualTokens(width, height) <= MAX_VISUAL_TOKENS
	);
}

function scale(size: Size, factor: number): Size {
	return {
		width: Math.max(1, Math.round(size.width * factor)),
		height: Math.max(1, Math.round(size.height * factor))
	};
}

/**
 * Grootste formaat met dezelfde verhouding dat binnen `longEdge` en de tokengrens van het model
 * past. Nooit vergroten.
 */
export function fitSize(size: Size, longEdge = MAX_LONG_EDGE): Size {
	assertSize(size);
	const long = Math.max(size.width, size.height);
	let factor = Math.min(1, Math.min(longEdge, MAX_LONG_EDGE) / long);
	let out = scale(size, factor);
	// Tokens schalen kwadratisch; begin bij de exacte schatting en zak in kleine stappen tot het past
	const tokens = visualTokens(out.width, out.height);
	if (tokens > MAX_VISUAL_TOKENS) factor *= Math.sqrt(MAX_VISUAL_TOKENS / tokens);
	out = scale(size, factor);
	while (!fitsModel(out.width, out.height)) {
		factor *= 0.995;
		out = scale(size, factor);
	}
	return out;
}

/** Hoogste stuklengte (lange kant) bij een gegeven korte kant, binnen beide grenzen. */
function maxPieceLength(short: number): number {
	const rows = Math.floor(MAX_VISUAL_TOKENS / Math.ceil(short / PATCH_PX));
	return Math.min(MAX_LONG_EDGE, rows * PATCH_PX);
}

function piecesNeeded(long: number, pieceLength: number, overlap: number): number {
	if (long <= pieceLength) return 1;
	return Math.ceil((long - overlap) / (pieceLength - overlap));
}

/**
 * Plan voor de variant "in stukken": een gewone bon wordt alleen passend gemaakt, een lange bon
 * (meer dan 3,5 keer zo lang als breed) wordt over de lange as in gelijke, overlappende stukken
 * gesneden die elk binnen de grenzen van het model vallen.
 */
export function planSlices(size: Size): SlicePlan {
	assertSize(size);
	const vertical = size.height >= size.width;
	const short = vertical ? size.width : size.height;
	const long = vertical ? size.height : size.width;

	if (long / short <= LONG_RECEIPT_RATIO) {
		const scaled = fitSize(size);
		return { scaled, pieces: [{ left: 0, top: 0, ...scaled }] };
	}

	let shortScaled = Math.min(short, SLICE_SHORT_EDGE);
	let longScaled: number, pieceLength: number, overlap: number, count: number;
	for (;;) {
		longScaled = Math.max(1, Math.round((long * shortScaled) / short));
		pieceLength = Math.min(maxPieceLength(shortScaled), longScaled);
		overlap = Math.round(pieceLength * SLICE_OVERLAP);
		count = piecesNeeded(longScaled, pieceLength, overlap);
		if (count <= MAX_SLICES || shortScaled <= PATCH_PX) break;
		// Te veel stukken: smaller maken zodat het in MAX_SLICES past, en opnieuw rekenen
		const fit = MAX_SLICES * pieceLength - (MAX_SLICES - 1) * overlap;
		shortScaled = Math.max(PATCH_PX, Math.min(shortScaled - 1, Math.floor((short * fit) / long)));
	}
	// Een extreem smalle strook past ook smal niet in MAX_SLICES: dan als één beeld, zoals de API
	if (count > MAX_SLICES) {
		const scaled = fitSize(size);
		return { scaled, pieces: [{ left: 0, top: 0, ...scaled }] };
	}

	// Gelijke stukken, gelijk verdeeld: het laatste stuk eindigt precies aan de onderkant
	const step = count === 1 ? 0 : (longScaled - pieceLength) / (count - 1);
	const pieces: Rect[] = [];
	for (let i = 0; i < count; i++) {
		const start = Math.round(i * step);
		pieces.push(
			vertical
				? { left: 0, top: start, width: shortScaled, height: pieceLength }
				: { left: start, top: 0, width: pieceLength, height: shortScaled }
		);
	}
	const scaled = vertical
		? { width: shortScaled, height: longScaled }
		: { width: longScaled, height: shortScaled };
	return { scaled, pieces };
}

function assertSize(size: Size): void {
	if (
		!Number.isInteger(size.width) ||
		!Number.isInteger(size.height) ||
		size.width < 1 ||
		size.height < 1
	) {
		throw new RangeError('ongeldig beeldformaat');
	}
}
