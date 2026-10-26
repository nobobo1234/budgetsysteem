import { and, eq, gt } from 'drizzle-orm';
import {
	closingMonth,
	closingNotice,
	monthName,
	nextNotifyAt,
	outcomeSentence,
	zonedParts
} from '../closing.ts';
import { getClosing, hasMonthData, monthContent, openItems } from './closing.ts';
import type { DB } from './db/index.ts';
import { jobs } from './db/schema.ts';
import { enqueue, ensureScheduled, registerJob } from './jobs.ts';
import { alreadySent, notify } from './push/notify.ts';
import type { Send } from './recurring-notify.ts';

// Pushmelding "de maand is voorbij en de afsluiting staat klaar" (spec: Analyses →
// Maandafsluiting, Meldingen). Elke dag om 9:00 in Nederland kijkt een taak of de vorige maand
// klaar is: zodra er niets meer openstaat, of uiterlijk op de 5e met het aantal open punten.
// Eén melding per maand (ontdubbeld op de maand); een afgesloten maand krijgt er geen meer.

export const CLOSING_JOB = 'maandafsluiting_melding';

const plural = (n: number) => (n === 1 ? '1 open punt' : `${n} open punten`);

/** Stuurt de melding als het zover is; geeft terug of hij verstuurd is. */
export async function notifyMonthClosing(db: DB, now: Date, send: Send = notify): Promise<boolean> {
	const month = closingMonth(now);
	const key = `maand:${month}`;
	if (alreadySent(db, 'maand', key) || getClosing(db, month) || !hasMonthData(db, month))
		return false;
	const today = zonedParts(now).date;
	const open = openItems(db, month, today).length;
	const notice = closingNotice(now, open);
	if (!notice) return false;
	const name = monthName(month);
	const ready =
		notice.kind === 'klaar'
			? `De afsluiting van ${name.toLowerCase()} staat klaar`
			: `De afsluiting van ${name.toLowerCase()} staat klaar, met nog ${plural(open)}`;
	const outcome = outcomeSentence(monthContent(db, month, today).outcome);
	const result = await send(
		'maand',
		{
			key,
			text: `${ready}.`,
			// Bedragen alleen als je die op het vergrendelscherm wilt zien
			detail: `${ready}. ${outcome}`,
			url: `/afsluiting/${month}`
		},
		db
	);
	return result.status === 'verstuurd';
}

/** Elke dag om 9:00 (Europe/Amsterdam); een gemiste ochtend draait bij het starten alsnog. */
export function scheduleClosingNotifications(db: DB, now = new Date(), send: Send = notify): void {
	registerJob(CLOSING_JOB, async (conn, _payload, at) => {
		const planned = conn
			.select({ id: jobs.id })
			.from(jobs)
			.where(
				and(
					eq(jobs.kind, CLOSING_JOB),
					eq(jobs.status, 'wachtend'),
					gt(jobs.runAt, at.toISOString())
				)
			)
			.get();
		if (!planned) enqueue(conn, CLOSING_JOB, nextNotifyAt(at));
		await notifyMonthClosing(conn, at, send);
	});
	ensureScheduled(db, CLOSING_JOB, nextNotifyAt(now));
}
