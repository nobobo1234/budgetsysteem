import { self } from '$app/service-worker';
import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';

// Offline: de app-schil en build-bestanden uit de cache, pagina's netwerk-eerst met de laatste
// versie als terugval. API-verzoeken nooit cachen; invoer loopt via de IndexedDB-wachtrij.

const CACHE = `budget-${version}`;
const PAGES = `budget-pages-${version}`;

// De app draait op de root (geen `paths.base`), dus een pad is `/` plus het manifestpad
const ASSETS: string[] = [...immutable, ...assets].map((a) => `/${a.path}`);

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key !== CACHE && key !== PAGES) await caches.delete(key);
			}
			await self.clients.claim();
		})()
	);
});

function cacheable(response: Response): boolean {
	const control = response.headers.get('cache-control') ?? '';
	return response.status === 200 && response.type === 'basic' && !control.includes('no-store');
}

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith('/api/')) return;

	if (ASSETS.includes(url.pathname)) {
		event.respondWith(
			caches.match(url.pathname, { cacheName: CACHE }).then((hit) => hit ?? fetch(request))
		);
		return;
	}

	event.respondWith(
		(async () => {
			try {
				const response = await fetch(request);
				if (cacheable(response)) {
					const copy = response.clone();
					void caches.open(PAGES).then((cache) => cache.put(request, copy));
				}
				return response;
			} catch (err) {
				const hit = await caches.match(request, { cacheName: PAGES });
				if (hit) return hit;
				// Offline en deze pagina nooit gezien: dan het startscherm, als dat in de cache staat
				if (request.mode === 'navigate') {
					const home = await caches.match('/', { cacheName: PAGES });
					if (home) return home;
				}
				throw err;
			}
		})()
	);
});
