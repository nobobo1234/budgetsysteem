import { and, eq, gt } from 'drizzle-orm';
import { nextNotifyAt, zonedParts } from '../closing.ts';
import { displayName } from '../text.ts';
import { dueReminders, reminderKey, reminderText } from '../warranty.ts';
import type { DB } from './db/index.ts';
import { jobs } from './db/schema.ts';
import { enqueue, ensureScheduled, registerJob } from './jobs.ts';
import { alreadySent, notify } from './push/notify.ts';
import type { Send } from './recurring-notify.ts';
import { activeWarranties } from './warranty.ts';

// Herinneringen voor garantie (spec: Garantie → Herinneringen). Elke dag om 9:00 in Nederland
// kijkt een taak welke actieve garanties over 30 dagen het eerste jaar na aflevering of de
// fabrieksgarantie uit lopen. Elke melding gaat één keer uit (ontdubbeld op product, moment en
// einddatum); een afgedankt product krijgt er geen meer. Product en winkel alleen in `detail`,
// dat op het vergrendelscherm komt als je namen en bedragen daar aanzette.

export const WARRANTY_JOB = 'garantie_meldingen';

/** Stuurt de herinneringen die vandaag aan de beurt zijn; geeft het aantal verstuurde terug. */
export async function notifyWarranties(db: DB, now: Date, send: Send = notify): Promise<number> {
	const today = zonedParts(now).date;
	let sent = 0;
	for (const w of activeWarranties(db)) {
		for (const r of dueReminders(w, today)) {
			const key = reminderKey(w.id, r);
			if (alreadySent(db, 'garantie', key)) continue;
			const store = displayName(w.counterparty) || 'de winkel';
			const result = await send(
				'garantie',
				{ key, ...reminderText(r, w.product, store), url: `/garantie/${w.id}` },
				db
			);
			if (result.status === 'verstuurd') sent++;
		}
	}
	return sent;
}

/** Elke dag om 9:00 (Europe/Amsterdam); een gemiste ochtend komt de volgende ochtend alsnog. */
export function scheduleWarrantyNotifications(db: DB, now = new Date(), send: Send = notify): void {
	registerJob(WARRANTY_JOB, async (conn, _payload, at) => {
		const planned = conn
			.select({ id: jobs.id })
			.from(jobs)
			.where(
				and(
					eq(jobs.kind, WARRANTY_JOB),
					eq(jobs.status, 'wachtend'),
					gt(jobs.runAt, at.toISOString())
				)
			)
			.get();
		if (!planned) enqueue(conn, WARRANTY_JOB, nextNotifyAt(at));
		await notifyWarranties(conn, at, send);
	});
	ensureScheduled(db, WARRANTY_JOB, nextNotifyAt(now));
}
