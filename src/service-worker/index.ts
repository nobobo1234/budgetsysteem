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

// Pushmeldingen. De server bepaalt titel en tekst (met of zonder bedragen, volgens de
// instelling); hier alleen tonen. Alles wat binnenkomt wordt als gewone tekst behandeld.

interface PushPayload {
	title: string;
	body: string;
	url: string;
	tag: string;
}

/** Alleen een pad binnen de app; anders het startscherm. */
function appPath(url: unknown): string {
	return typeof url === 'string' && /^\/(?!\/)[^\s\\]*$/.test(url) ? url : '/';
}

function readPayload(data: PushMessageData | null): PushPayload {
	let raw: Record<string, unknown> = {};
	try {
		const parsed: unknown = data?.json();
		if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
	} catch {
		// Geen geldige JSON: toon een algemene melding
	}
	const text = (value: unknown, fallback: string, max: number) =>
		typeof value === 'string' && value.trim() ? value.slice(0, max) : fallback;
	return {
		title: text(raw.title, 'Budget', 80),
		body: text(raw.body, 'Er is iets nieuws in je budget.', 300),
		url: appPath(raw.url),
		tag: text(raw.tag, 'budget', 64)
	};
}

self.addEventListener('push', (event) => {
	const payload = readPayload(event.data);
	event.waitUntil(
		self.registration.showNotification(payload.title, {
			body: payload.body,
			tag: payload.tag,
			icon: '/icon-192.png',
			badge: '/icon-192.png',
			lang: 'nl',
			data: { url: payload.url }
		})
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const data: unknown = event.notification.data;
	const path = appPath(
		data && typeof data === 'object' ? (data as { url?: unknown }).url : undefined
	);
	const target = new URL(path, self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			for (const client of windows) {
				if (new URL(client.url).origin !== self.location.origin) continue;
				await client.focus();
				if (client.url !== target) await client.navigate(target);
				return;
			}
			await self.clients.openWindow(target);
		})()
	);
});

// De push-dienst heeft het abonnement vervangen (niet elke browser stuurt dit event): het
// nieuwe abonnement doorgeven en het oude afmelden.
self.addEventListener('pushsubscriptionchange', (event) => {
	const change = event as Event & {
		oldSubscription?: PushSubscription | null;
		newSubscription?: PushSubscription | null;
		waitUntil(promise: Promise<unknown>): void;
	};
	change.waitUntil(
		(async () => {
			const next =
				change.newSubscription ??
				(change.oldSubscription
					? await self.registration.pushManager.subscribe(change.oldSubscription.options)
					: null);
			if (next) {
				await fetch('/api/push/subscription', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(next.toJSON()),
					credentials: 'same-origin'
				});
			}
			if (change.oldSubscription && change.oldSubscription.endpoint !== next?.endpoint) {
				await fetch('/api/push/subscription', {
					method: 'DELETE',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ endpoint: change.oldSubscription.endpoint }),
					credentials: 'same-origin'
				});
			}
		})()
	);
});
