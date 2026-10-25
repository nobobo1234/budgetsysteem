/** Duur van een Svelte-transitie, of 0 bij `prefers-reduced-motion` (spec: Beweging). */
export function motion(ms: number): number {
	if (typeof matchMedia === 'undefined') return ms;
	return matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
}
