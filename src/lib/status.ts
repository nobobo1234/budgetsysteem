// Weergave van de statuspagina: tijden, schijfruimte en web-vitals in gewone taal.

const number = (digits: number) =>
	new Intl.NumberFormat('nl-NL', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const whole = number(0);
const oneDecimal = number(1);
const twoDecimals = number(2);

/** Duur in seconden als `45 s`, `12 min`, `3 u 5 min` of `2 d 4 u`. */
export function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s} s`;
	const min = Math.floor(s / 60);
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	if (h < 24) return min % 60 === 0 ? `${h} u` : `${h} u ${min % 60} min`;
	const d = Math.floor(h / 24);
	return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} u`;
}

export function formatAge(seconds: number | null): string {
	return seconds === null ? 'Niet gevonden' : `${formatDuration(seconds)} geleden`;
}

export function formatBytes(bytes: number): string {
	const units = ['B', 'kB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit++;
	}
	return `${(unit === 0 ? whole : oneDecimal).format(value)} ${units[unit]}`;
}

export function formatPercent(value: number): string {
	return `${oneDecimal.format(value)}%`;
}

/** Web-vital: LCP en FCP in seconden, INP en TTFB in milliseconden, CLS als score. */
export function formatVital(name: string, value: number): string {
	if (name === 'CLS') return twoDecimals.format(value);
	if (name === 'LCP' || name === 'FCP') return `${oneDecimal.format(value / 1000)} s`;
	return `${whole.format(value)} ms`;
}
