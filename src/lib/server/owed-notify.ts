import { formatCents } from '../money.ts';
import type { DB } from './db/index.ts';
import { owedReminders } from './owed.ts';
import { alreadySent, markSent, notify } from './push/notify.ts';
import type { Send } from './recurring-notify.ts';

// Pushmelding "een Tikkie staat 14 dagen open" (spec: Meldingen, Nog te krijgen → Herinnering).
// Eén keer per post. Komen er meerdere tegelijk bij (zoals bij de eerste keer), dan gaat er één
// gebundelde melding uit in plaats van een rij meldingen achter elkaar.

const keyOf = (id: string) => `open:${id}`;

/** Stuurt de melding voor posten te krijgen die 14 dagen of langer openstaan; geeft 1 of 0. */
export async function notifyOpenTikkies(
	db: DB,
	today: string,
	send: Send = notify
): Promise<number> {
	const fresh = owedReminders(db, today).filter((p) => !alreadySent(db, 'tikkie', keyOf(p.id)));
	const [first, ...rest] = fresh;
	if (!first) return 0;
	const totalCents = fresh.reduce((s, p) => s + p.outstandingCents, 0);
	const message =
		fresh.length === 1
			? {
					text: 'Een Tikkie staat 14 dagen open',
					detail: first.personName
						? `${first.personName} moet je nog ${formatCents(first.outstandingCents)} terugbetalen`
						: `${formatCents(first.outstandingCents)} staat 14 dagen open`
				}
			: {
					text: `${fresh.length} Tikkies staan 14 dagen open`,
					detail: `${fresh.length} Tikkies staan 14 dagen open, samen ${formatCents(totalCents)}`
				};
	const result = await send('tikkie', { key: keyOf(first.id), url: '/te-krijgen', ...message }, db);
	if (result.status !== 'verstuurd') return 0;
	// De rest ging mee in deze melding
	markSent(
		db,
		'tikkie',
		rest.map((p) => keyOf(p.id))
	);
	return 1;
}
