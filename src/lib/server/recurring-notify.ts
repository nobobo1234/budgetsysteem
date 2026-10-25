import { and, eq, gt } from 'drizzle-orm';
import { toIsoDate } from '../dates.ts';
import { formatCents } from '../money.ts';
import type { DB } from './db/index.ts';
import { jobs } from './db/schema.ts';
import { enqueue, ensureScheduled, registerJob } from './jobs.ts';
import { log } from './log.ts';
import { notify, type NotifyMessage, type NotifyResult } from './push/notify.ts';
import { awaitingConfirmation, onRecurringEvent } from './recurring.ts';

// Pushmelding "een verwachte vaste last staat klaar om te bevestigen" (spec: Meldingen). Een
// post krijgt één melding, zodra zijn verwachte dag gekomen is: niet al op de eerste van de
// maand, als de post wordt aangemaakt. 's Nachts gaat er niets uit; dan wacht hij tot 9 uur.

export const NOTIFY_JOB = 'vaste_lasten_meldingen';
const MORNING = 9;
const EVENING = 21;

export type Send = (kind: 'vaste_last', message: NotifyMessage, db: DB) => Promise<NotifyResult>;

/** Overdag (9 tot 21 uur, lokale tijd) mag een melding meteen; anders wacht hij op de ochtend. */
export function isDaytime(now: Date): boolean {
	const hour = now.getHours();
	return hour >= MORNING && hour < EVENING;
}

/** De eerstvolgende ochtend om 9 uur: vandaag als het nog geen 9 uur is, anders morgen. */
export function nextMorning(now: Date): Date {
	const day = now.getHours() < MORNING ? now.getDate() : now.getDate() + 1;
	return new Date(now.getFullYear(), now.getMonth(), day, MORNING, 0);
}

/**
 * Eén melding per verwachte post waarvan de dag gekomen is, ontdubbeld op de post. Een post die
 * al gemist is (7 dagen over tijd) krijgt geen melding meer: die staat als "gemist of
 * opgezegd?" op het startscherm. Zonder bedragen of namen, tenzij je dat hebt aangezet.
 */
export async function notifyDueExpected(
	db: DB,
	today: string,
	send: Send = notify
): Promise<number> {
	const due = awaitingConfirmation(db, today).filter((item) => !item.missed);
	const results = await Promise.all(
		due.map((item) =>
			send(
				'vaste_last',
				{
					key: `verwacht:${item.id}`,
					text: 'Een vaste last wacht op bevestiging',
					detail: `${item.counterparty}: ${formatCents(-item.amountCents)} wacht op bevestiging`,
					url: '/'
				},
				db
			)
		)
	);
	return results.filter((r) => r.status === 'verstuurd').length;
}

/** Op de achtergrond; een fout (bijvoorbeeld een database die net dicht is) komt alleen in de log. */
function inBackground(db: DB, today: string): void {
	notifyDueExpected(db, today).catch((e: unknown) => {
		log.warn(
			{ err: { name: e instanceof Error ? e.name : 'Onbekend' } },
			'meldingen vaste lasten mislukt'
		);
	});
}

/** Elke ochtend om 9 uur; bij het starten overdag meteen een keer. */
export function scheduleRecurringNotifications(db: DB, now = new Date()): void {
	registerJob(NOTIFY_JOB, (conn, _payload, at) => {
		const planned = conn
			.select({ id: jobs.id })
			.from(jobs)
			.where(
				and(
					eq(jobs.kind, NOTIFY_JOB),
					eq(jobs.status, 'wachtend'),
					gt(jobs.runAt, at.toISOString())
				)
			)
			.get();
		if (!planned) enqueue(conn, NOTIFY_JOB, nextMorning(at));
		inBackground(conn, toIsoDate(at));
	});
	ensureScheduled(db, NOTIFY_JOB, isDaytime(now) ? now : nextMorning(now));
}

let listening = false;

/**
 * Koppelt vaste lasten aan pushmeldingen: de ochtendjob, en meteen een melding als er overdag
 * een verwachte post bijkomt waarvan de dag al gekomen is (bijvoorbeeld net na het bevestigen
 * van een voorstel). 's Nachts aangemaakte posten (de maandjob om 00:05) wachten op 9 uur.
 */
export function startRecurringNotifications(db: () => DB, now = new Date()): void {
	scheduleRecurringNotifications(db(), now);
	if (listening) return;
	listening = true;
	onRecurringEvent((event) => {
		const at = new Date();
		if (event.type === 'verwacht' && isDaytime(at)) inBackground(db(), toIsoDate(at));
	});
}
