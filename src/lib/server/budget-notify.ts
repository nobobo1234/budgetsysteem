import { toIsoDate } from '../dates.ts';
import { formatCents } from '../money.ts';
import { monthOverview, type CategoryLine } from './budgets.ts';
import type { DB } from './db/index.ts';
import { log } from './log.ts';
import { notify, releaseNotification } from './push/notify.ts';
import type { Send } from './recurring-notify.ts';

// Pushmelding "een categorie zit op 90% van de limiet" (spec: Meldingen). Gemeten op het deel
// buiten geplande vaste lasten en reserveringen: de overige uitgaven tegenover limiet − gepland,
// net als het tempo. Eén melding per categorie per maand; zakt een categorie weer onder de 90%
// (een terugboeking, een hogere limiet), dan mag hij later opnieuw.

export const BUDGET_THRESHOLD = 0.9;

/** Deel van het vrije deel dat op is, of `null` als er geen vrij deel is om tegen te meten. */
export function freeShareUsed(
	line: Pick<CategoryLine, 'limitCents' | 'otherCents' | 'freeLimitCents'>
) {
	if (line.limitCents <= 0 || line.freeLimitCents <= 0) return null;
	return line.otherCents / line.freeLimitCents;
}

const keyOf = (month: string, categoryId: string) => `${month}:${categoryId}`;

/** Controleert de categorieën van de maand van `today`; geeft het aantal verstuurde meldingen. */
export async function notifyBudgetThreshold(
	db: DB,
	today: string,
	send: Send = notify
): Promise<number> {
	const month = today.slice(0, 7);
	const results = await Promise.all(
		monthOverview(db, month, today).lines.map((line) => {
			const used = freeShareUsed(line);
			const key = keyOf(month, line.categoryId);
			if (used === null || used < BUDGET_THRESHOLD) {
				releaseNotification('budget_90', key, db);
				return null;
			}
			const over = used >= 1;
			return send(
				'budget_90',
				{
					key,
					text: over
						? 'Een categorie zit over de limiet'
						: 'Een categorie zit op 90% van de limiet',
					detail: `${line.name} zit op ${Math.floor((line.otherCents * 100) / line.freeLimitCents)}% van de limiet: ${formatCents(line.otherCents)} van ${formatCents(line.freeLimitCents)}`,
					url: '/budget'
				},
				db
			);
		})
	);
	return results.filter((r) => r?.status === 'verstuurd').length;
}

let started: (() => DB) | undefined;
let soon: ReturnType<typeof setTimeout> | undefined;

/** Na het starten mag `budgetCheckSoon` controleren; daarvoor (zoals in tests) doet hij niets. */
export function startBudgetNotifications(db: () => DB): void {
	started = db;
}

/**
 * Na een wijziging (een uitgave, een andere categorie, een import, een nieuwe limiet): over een
 * paar seconden controleren. Meerdere wijzigingen kort na elkaar geven één controle.
 */
export function budgetCheckSoon(): void {
	if (!started || soon) return;
	const db = started;
	soon = setTimeout(() => {
		soon = undefined;
		notifyBudgetThreshold(db(), toIsoDate(new Date())).catch((e: unknown) => {
			log.warn(
				{ err: { name: e instanceof Error ? e.name : 'Onbekend' } },
				'meldingen budget mislukt'
			);
		});
	}, 3_000);
	soon.unref();
}
