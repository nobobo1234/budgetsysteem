// Weergave van de pagina Gebruik: tijden en de zin over je reeks in gewone taal.

const oneDecimal = new Intl.NumberFormat('nl-NL', {
	minimumFractionDigits: 1,
	maximumFractionDigits: 1
});

/** Openen tot opslaan: `8,4 s` onder de minuut, daarboven `1 min 20 s`. */
export function formatEntryTime(ms: number): string {
	if (ms < 59_950) return `${oneDecimal.format(Math.max(0, ms) / 1000)} s`;
	const s = Math.round(ms / 1000);
	const min = Math.floor(s / 60);
	return s % 60 === 0 ? `${min} min` : `${min} min ${s % 60} s`;
}

const days = (n: number) => (n === 1 ? '1 dag' : `${n} dagen`);

/** Eén zin over vandaag en je reeks, zoals "Vandaag al ingevoerd, 5 dagen op rij." */
export function streakSentence(u: { streak: number; longestStreak: number; today: boolean }) {
	const now = u.today
		? u.streak > 1
			? `Vandaag al ingevoerd, ${u.streak} dagen op rij.`
			: 'Vandaag al ingevoerd.'
		: u.streak > 0
			? `Vandaag nog niets. Voer iets in en je reeks wordt ${days(u.streak + 1)}.`
			: 'Vandaag nog niets ingevoerd.';
	return u.longestStreak > u.streak && u.longestStreak > 1
		? `${now} Je langste reeks was ${days(u.longestStreak)}.`
		: now;
}
