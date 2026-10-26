import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// De meting in de PWA (usage.ts) met de wachtrij (usage-queue.ts): localStorage en fetch
// nagebootst, de tijd met nep-timers
let store: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;
let usage: typeof import('./usage.ts');
let queue: typeof import('./usage-queue.ts');

/** Invoer vastleggen en wachten tot de wachtrij geladen en verstuurd is. */
async function record(kind: 'snelinvoer' | 'verwacht' | 'bon') {
	usage.recordEntry(kind);
	await vi.dynamicImportSettled();
	await queue.flushUsage();
}

const queued = () => JSON.parse(store.get('gebruik') ?? '[]') as Record<string, unknown>[];
const sentBodies = () =>
	fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date', 'performance'] });
	vi.setSystemTime(new Date(2026, 9, 28, 9, 0));
	store = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k)
	});
	fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('addEventListener', vi.fn());
	vi.stubGlobal('document', { visibilityState: 'visible' });
	vi.resetModules();
	usage = await import('./usage.ts');
	queue = await import('./usage-queue.ts');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('recordEntry', () => {
	it('stuurt alleen dag, soort, ID en tijd sinds openen', async () => {
		vi.advanceTimersByTime(8400);
		await record('snelinvoer');
		const [body] = sentBodies();
		expect(body.entries).toHaveLength(1);
		const entry = body.entries[0];
		expect(Object.keys(entry).sort()).toEqual(['day', 'durationMs', 'id', 'kind']);
		expect(entry).toMatchObject({ day: '2026-10-28', kind: 'snelinvoer' });
		expect(entry.durationMs).toBeGreaterThanOrEqual(8400);
		expect(fetchMock.mock.calls[0]![0]).toBe('/api/usage');
		expect(queued()).toEqual([]);
	});

	it('alleen de eerste invoer na het openen krijgt een tijd', async () => {
		await record('snelinvoer');
		await record('verwacht');
		const durations = sentBodies().flatMap((b) =>
			(b.entries as { durationMs: number | null }[]).map((e) => e.durationMs)
		);
		expect(durations[0]).not.toBeNull();
		expect(durations.at(-1)).toBeNull();
	});

	it('na een half uur open telt de dag wel, de tijd niet', async () => {
		vi.advanceTimersByTime(31 * 60_000);
		await record('bon');
		expect(sentBodies()[0].entries[0]).toMatchObject({ kind: 'bon', durationMs: null });
	});

	it('offline blijft de meting staan met de dag van invoeren, en gaat later alsnog', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		await record('snelinvoer');
		expect(queued()).toHaveLength(1);
		expect(queued()[0]!.day).toBe('2026-10-28');

		// De volgende dag weer verbinding
		vi.setSystemTime(new Date(2026, 9, 29, 8, 0));
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
		await queue.flushUsage();
		expect(sentBodies().at(-1).entries[0].day).toBe('2026-10-28');
		expect(queued()).toEqual([]);
	});

	it('zonder sessie of bij een serverfout later opnieuw; een geweigerde batch gaat weg', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
		await record('snelinvoer');
		expect(queued()).toHaveLength(1);

		fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
		await queue.flushUsage();
		expect(queued()).toHaveLength(1);

		fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
		await queue.flushUsage();
		expect(queued()).toEqual([]);
	});

	it('verstuurt in batches van hooguit 20', async () => {
		fetchMock.mockRejectedValue(new TypeError('offline'));
		for (let i = 0; i < 45; i++) await record('verwacht');
		fetchMock.mockReset();
		fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
		await queue.flushUsage();
		expect(sentBodies().map((b) => b.entries.length)).toEqual([20, 20, 5]);
		expect(queued()).toEqual([]);
	});

	it('zonder localStorage (privévenster) gaat de app gewoon door', async () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {
				throw new Error('QuotaExceededError');
			},
			removeItem: () => {}
		});
		expect(() => usage.recordEntry('snelinvoer')).not.toThrow();
		await expect(record('snelinvoer')).resolves.toBeUndefined();
	});
});

describe('startUsage', () => {
	let target: EventTarget;
	const durations = () =>
		sentBodies().flatMap((b) =>
			(b.entries as { durationMs: number | null }[]).map((e) => e.durationMs)
		);
	const settle = async () => {
		await vi.dynamicImportSettled();
		await queue.flushUsage();
	};

	beforeEach(() => {
		target = new EventTarget();
		vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
	});

	it('een invoer-event telt, en terug op de voorgrond begint de tijd opnieuw', async () => {
		usage.startUsage();
		vi.advanceTimersByTime(60_000);
		target.dispatchEvent(new CustomEvent('invoer', { detail: 'bon' }));
		await settle();

		vi.advanceTimersByTime(10_000);
		target.dispatchEvent(new Event('visibilitychange'));
		vi.advanceTimersByTime(2500);
		target.dispatchEvent(new CustomEvent('invoer', { detail: 'snelinvoer' }));
		await settle();
		expect(durations()).toEqual([60_000, 2500]);
	});

	it('geopend op de achtergrond: geen tijd tot de app op de voorgrond komt', async () => {
		vi.stubGlobal('document', { visibilityState: 'hidden' });
		usage.startUsage();
		target.dispatchEvent(new CustomEvent('invoer', { detail: 'verwacht' }));
		await settle();
		expect(durations()).toEqual([null]);
	});

	it('wacht er nog iets van een vorige keer, dan gaat het meteen; anders laadt er niets', async () => {
		usage.startUsage();
		await vi.dynamicImportSettled();
		expect(fetchMock).not.toHaveBeenCalled();

		vi.resetModules();
		usage = await import('./usage.ts');
		queue = await import('./usage-queue.ts');
		const id = '0b7f3c52-6a2e-4c8e-9a43-1f2d3e4c5b6a';
		store.set(
			'gebruik',
			JSON.stringify([{ id, day: '2026-10-27', kind: 'bon', durationMs: null }])
		);
		usage.startUsage();
		await settle();
		expect(sentBodies()[0].entries).toEqual([
			{ id, day: '2026-10-27', kind: 'bon', durationMs: null }
		]);
		expect(queued()).toEqual([]);
	});
});
