import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

// Snelheid in de praktijk (spec: Telemetrie en monitoring): web-vitals meet in de PWA en stuurt
// alleen naam en waarde naar ons eigen endpoint, zonder trackers of derden. Deze module wordt
// pas na de eerste weergave geladen (zie (app)/+layout.svelte), zodat hij niet in de eerste
// JS-bundel zit. Metingen worden verzameld en verstuurd als de pagina naar de achtergrond gaat.

const MAX_PER_REQUEST = 10;
const queue: { name: Metric['name']; value: number }[] = [];

function add(metric: Metric) {
	// CLS is een kleine score; de rest is in milliseconden
	const digits = metric.name === 'CLS' ? 4 : 1;
	queue.push({ name: metric.name, value: Number(metric.value.toFixed(digits)) });
}

function flush() {
	while (queue.length > 0) {
		const metrics = queue.splice(0, MAX_PER_REQUEST);
		// keepalive: het verzoek mag de pagina overleven. Mislukt het (offline), dan is de
		// meting weg; telemetrie mag de app nooit hinderen.
		fetch('/api/vitals', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ metrics }),
			credentials: 'same-origin',
			keepalive: true
		}).catch(() => {});
	}
}

let started = false;

export function startVitals(): void {
	if (started) return;
	started = true;
	for (const on of [onLCP, onINP, onCLS, onFCP, onTTFB]) on(add);
	// Na de listeners van web-vitals zelf, zodat LCP, CLS en INP al in de wachtrij staan
	addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') flush();
	});
	addEventListener('pagehide', flush);
}
