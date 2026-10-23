// Eenvoudige rate limiting per sleutel (bijvoorbeeld IP) met een vast tijdvenster.
// nginx remt al op /login; dit is de tweede laag in de app zelf.

interface Window {
	count: number;
	resetAt: number;
}

export class RateLimiter {
	private readonly windows = new Map<string, Window>();

	constructor(
		private readonly max: number,
		private readonly windowMs: number,
		private readonly maxKeys = 10_000
	) {}

	/** `true` als dit verzoek nog mag. */
	hit(key: string, now = Date.now()): boolean {
		let w = this.windows.get(key);
		if (!w || w.resetAt <= now) {
			if (this.windows.size >= this.maxKeys) this.sweep(now);
			w = { count: 0, resetAt: now + this.windowMs };
			this.windows.set(key, w);
		}
		w.count++;
		return w.count <= this.max;
	}

	reset(key: string): void {
		this.windows.delete(key);
	}

	private sweep(now: number): void {
		for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
		// Nog steeds vol: begin opnieuw in plaats van onbeperkt te groeien
		if (this.windows.size >= this.maxKeys) this.windows.clear();
	}
}

/** Inloggen, herstelcode en setup: 10 pogingen per kwartier per IP. */
export const authLimiter = new RateLimiter(10, 15 * 60 * 1000);
/** Alle verzoeken: ruim genoeg voor normaal gebruik, krap voor misbruik. */
export const requestLimiter = new RateLimiter(600, 60 * 1000);
