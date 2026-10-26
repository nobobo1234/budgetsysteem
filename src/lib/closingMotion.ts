// Beweging van de maandafsluiting (spec: Beweging): de kop komt per woord omhoog, daarna loopt
// het bedrag op en vult de balk. GSAP en SplitText worden pas na de eerste weergave geladen,
// zodat ze niet in de eerste bundel zitten. Samen hooguit 900 ms; bij `prefers-reduced-motion`
// roept de pagina dit niet aan en staat er meteen het eindbeeld.

export interface ClosingMotion {
	heading: HTMLElement;
	/** De balk die van links vult; alleen `transform` */
	bar?: HTMLElement | null;
	/** Het bedrag waar de teller naartoe loopt */
	target: number;
	/** Tussenstand van de teller; `null` zet het eindgetal terug */
	count: (value: number | null) => void;
}

export const TOTAL_MS = 900;

/** Speelt de opbouw af; geeft een functie terug die hem stopt en de kop terugzet. */
export async function playClosing({ heading, bar, target, count }: ClosingMotion) {
	const [{ gsap }, { SplitText }] = await Promise.all([import('gsap'), import('gsap/SplitText')]);
	gsap.registerPlugin(SplitText);
	const split = SplitText.create(heading, { type: 'words', mask: 'words', aria: 'auto' });
	const words = split.words.length;
	// Lange koppen krijgen een kortere stagger, zodat het geheel binnen de 900 ms blijft
	const stagger = Math.min(0.06, 0.2 / Math.max(1, words - 1));
	const state = { value: 0 };
	count(0);
	const tl = gsap.timeline({ onComplete: () => count(null) });
	tl.from(split.words, { yPercent: 100, opacity: 0, duration: 0.35, stagger, ease: 'power3.out' });
	tl.to(
		state,
		{
			value: target,
			duration: 0.5,
			ease: 'power2.out',
			onUpdate: () => count(Math.round(state.value))
		},
		0.3
	);
	if (bar)
		tl.from(
			bar,
			{ scaleX: 0, transformOrigin: 'left center', duration: 0.5, ease: 'power3.out' },
			0.3
		);
	return () => {
		tl.kill();
		if (bar) gsap.set(bar, { clearProps: 'transform' });
		split.revert();
		count(null);
	};
}
