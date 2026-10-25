// Herinneren op Te krijgen (spec: Nog te krijgen). Apart van owed.ts, zodat het startscherm
// (dat owed.ts via de snelinvoer laadt) deze code niet meekrijgt.
import { REMIND_AFTER_DAYS } from './owed.ts';

/** Hoe ver een post richting de herinnering is: 0 vandaag, 1 vanaf 14 dagen open. */
export function remindProgress(daysOpen: number): number {
	return Math.max(0, Math.min(1, daysOpen / REMIND_AFTER_DAYS));
}

/**
 * Tekst om iemand te herinneren via het deelmenu (Web Share). Alleen de naam, wat het was en
 * het bedrag; de app stuurt zelf niets.
 */
export function reminderText(
	name: string,
	posts: readonly { description: string; outstandingCents: number; tikkieUrl: string | null }[],
	format: (cents: number) => string
): string {
	const total = posts.reduce((s, p) => s + p.outstandingCents, 0);
	const what = posts
		.map((p) => p.description.trim())
		.filter(Boolean)
		.slice(0, 3);
	const forWhat =
		what.length === 0
			? ''
			: ` voor ${what.length === 1 ? what[0] : `${what.slice(0, -1).join(', ')} en ${what.at(-1)}`}`;
	const tikkie = posts.find((p) => p.tikkieUrl)?.tikkieUrl;
	return `Hoi ${name}, je moet me nog ${format(total)}${forWhat}.${tikkie ? ` Tikkie: ${tikkie}` : ''}`;
}
