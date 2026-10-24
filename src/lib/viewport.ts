// Het schermtoetsenbord van een telefoon schuift over de pagina heen zonder dat de pagina
// kleiner wordt (iOS); alleen de visual viewport krimpt. Iets dat onderin vastzit, zoals een
// sheet, moet daarom zelf boven het toetsenbord gaan staan.

interface VisualViewportLike {
	height: number;
	offsetTop: number;
}

/** Hoeveel pixels het toetsenbord onderin de pagina bedekt, en hoeveel ruimte er overblijft. */
export function keyboardInset(
	innerHeight: number,
	viewport: VisualViewportLike | null | undefined
): { bottom: number; room: number } {
	if (!viewport) return { bottom: 0, room: innerHeight };
	const bottom = Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop));
	return { bottom, room: Math.max(0, Math.round(viewport.height)) };
}
