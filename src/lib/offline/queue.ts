// Offline wachtrij voor nieuwe transacties in IndexedDB. Opslaan gaat altijd eerst hierheen,
// en wordt zo snel mogelijk naar de server gestuurd (iOS kan PWA-opslag wissen).
// De server is idempotent op het ID, dus opnieuw versturen boekt nooit dubbel.

export interface QueuedTransaction {
	id: string;
	amountCents: number;
	date: string;
	counterparty: string;
	description: string;
	categoryId: string | null;
	accountId: string;
	origAmountCents: number | null;
	origCurrency: 'USD' | null;
	note: string;
	share: { people: number; with: string[] } | null;
}

export interface OutboxItem {
	payload: QueuedTransaction;
	queuedAt: number;
	/** Gezet als de server de post weigert; dan blijft hij staan tot je hem aanpast of weggooit */
	error?: string;
}

const DB_NAME = 'budget';
const STORE = 'outbox';

function open(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 1);
		req.onupgradeneeded = () => {
			req.result.createObjectStore(STORE, { keyPath: 'payload.id' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function withStore<T>(
	mode: IDBTransactionMode,
	fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
	const db = await open();
	try {
		return await new Promise<T>((resolve, reject) => {
			const tx = db.transaction(STORE, mode);
			const req = fn(tx.objectStore(STORE));
			tx.oncomplete = () => resolve(req.result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

export function enqueue(payload: QueuedTransaction): Promise<IDBValidKey> {
	return withStore('readwrite', (s) =>
		s.put({ payload, queuedAt: Date.now() } satisfies OutboxItem)
	);
}

export function pending(): Promise<OutboxItem[]> {
	return withStore('readonly', (s) => s.getAll() as IDBRequest<OutboxItem[]>);
}

export function remove(id: string): Promise<undefined> {
	return withStore('readwrite', (s) => s.delete(id));
}

function markFailed(item: OutboxItem, error: string): Promise<IDBValidKey> {
	return withStore('readwrite', (s) => s.put({ ...item, error } satisfies OutboxItem));
}

export type FlushResult = { sent: number; failed: number; offline: boolean; loggedOut: boolean };

let flushing: Promise<FlushResult> | null = null;

/** Verstuurt alles uit de wachtrij, op volgorde. Stopt bij geen verbinding of geen sessie. */
export function flush(): Promise<FlushResult> {
	flushing ??= (async () => {
		const result: FlushResult = { sent: 0, failed: 0, offline: false, loggedOut: false };
		const items = (await pending()).filter((i) => !i.error).sort((a, b) => a.queuedAt - b.queuedAt);
		for (const item of items) {
			let response: Response;
			try {
				response = await fetch('/api/transactions', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(item.payload),
					credentials: 'same-origin'
				});
			} catch {
				result.offline = true;
				break;
			}
			if (response.ok) {
				await remove(item.payload.id);
				result.sent++;
			} else if (response.status === 401) {
				result.loggedOut = true;
				break;
			} else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				await markFailed(item, body?.message ?? 'Geweigerd door de server');
				result.failed++;
			} else {
				// 429 of 5xx: later opnieuw
				break;
			}
		}
		return result;
	})().finally(() => {
		flushing = null;
	});
	return flushing;
}
