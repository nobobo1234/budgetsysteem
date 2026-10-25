// Datums als `YYYY-MM-DD` in lokale tijd; maanden als `YYYY-MM`.

export function toIsoDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

export function fromIsoDate(iso: string): Date {
	const [y, m, d] = iso.split('-').map(Number);
	return new Date(y!, m! - 1, d!);
}

export function addDays(iso: string, days: number): string {
	const d = fromIsoDate(iso);
	d.setDate(d.getDate() + days);
	return toIsoDate(d);
}

export function monthOf(iso: string): string {
	return iso.slice(0, 7);
}

export function daysInMonth(month: string): number {
	const [y, m] = month.split('-').map(Number);
	return new Date(y!, m!, 0).getDate();
}

export function shiftMonth(month: string, delta: number): string {
	const [y, m] = month.split('-').map(Number);
	const d = new Date(y!, m! - 1 + delta, 1);
	return toIsoDate(d).slice(0, 7);
}

/** Bestaat deze kalenderdatum echt (geen 31 februari)? */
export function isValidDate(y: number, m: number, d: number): boolean {
	if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
	if (m < 1 || m > 12 || d < 1) return false;
	return d <= new Date(y, m, 0).getDate();
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
	const m = ISO.exec(s);
	return m !== null && isValidDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

const monthNames = new Intl.DateTimeFormat('nl-NL', { month: 'long', year: 'numeric' });
const shortDate = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' });

export function formatMonth(month: string): string {
	return monthNames.format(fromIsoDate(`${month}-01`));
}

export function formatShortDate(iso: string): string {
	return shortDate.format(fromIsoDate(iso));
}

const dayMonth = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long' });

/** `1 februari` */
export function formatDayMonth(iso: string): string {
	return dayMonth.format(fromIsoDate(iso));
}

const weekdayDate = new Intl.DateTimeFormat('nl-NL', {
	weekday: 'long',
	day: 'numeric',
	month: 'long'
});
const weekdayDateYear = new Intl.DateTimeFormat('nl-NL', {
	weekday: 'long',
	day: 'numeric',
	month: 'long',
	year: 'numeric'
});

/** Kop boven een dag in een lijst: `Vandaag`, `Gisteren`, `vrijdag 23 oktober`. */
export function formatDayHeading(iso: string, today: string): string {
	if (iso === today) return 'Vandaag';
	if (iso === addDays(today, -1)) return 'Gisteren';
	const d = fromIsoDate(iso);
	const text = (iso.slice(0, 4) === today.slice(0, 4) ? weekdayDate : weekdayDateYear).format(d);
	return text.charAt(0).toUpperCase() + text.slice(1);
}
