import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// De meting in de PWA: localStorage en fetch nagebootst, de tijd met nep-timers
type Usage = typeof import('./usage.ts');

let store: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;
let usage: Usage;

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
	vi.resetModules();
	usage = await import('./usage.ts');
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('recordEntry', () => {
	it('stuurt alleen dag, soort, ID en tijd sinds openen', async () => {
		vi.advanceTimersByTime(8400);
		usage.recordEntry('snelinvoer');
		await usage.flushUsage();
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
		usage.recordEntry('snelinvoer');
		await usage.flushUsage();
		usage.recordEntry('verwacht');
		await usage.flushUsage();
		const durations = sentBodies().flatMap((b) =>
			(b.entries as { durationMs: number | null }[]).map((e) => e.durationMs)
		);
		expect(durations[0]).not.toBeNull();
		expect(durations.at(-1)).toBeNull();
	});

	it('na een half uur open telt de dag wel, de tijd niet', async () => {
		vi.advanceTimersByTime(31 * 60_000);
		usage.recordEntry('bon');
		await usage.flushUsage();
		expect(sentBodies()[0].entries[0]).toMatchObject({ kind: 'bon', durationMs: null });
	});

	it('offline blijft de meting staan met de dag van invoeren, en gaat later alsnog', async () => {
		fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
		usage.recordEntry('snelinvoer');
		await usage.flushUsage();
		expect(queued()).toHaveLength(1);
		expect(queued()[0]!.day).toBe('2026-10-28');

		// De volgende dag weer verbinding
		vi.setSystemTime(new Date(2026, 9, 29, 8, 0));
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
		await usage.flushUsage();
		expect(sentBodies().at(-1).entries[0].day).toBe('2026-10-28');
		expect(queued()).toEqual([]);
	});

	it('zonder sessie of bij een serverfout later opnieuw; een geweigerde batch gaat weg', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
		usage.recordEntry('snelinvoer');
		await usage.flushUsage();
		expect(queued()).toHaveLength(1);

		fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
		await usage.flushUsage();
		expect(queued()).toHaveLength(1);

		fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
		await usage.flushUsage();
		expect(queued()).toEqual([]);
	});

	it('verstuurt in batches van hooguit 20', async () => {
		fetchMock.mockRejectedValue(new TypeError('offline'));
		for (let i = 0; i < 45; i++) usage.recordEntry('verwacht');
		await usage.flushUsage();
		fetchMock.mockReset();
		fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
		await usage.flushUsage();
		expect(sentBodies().map((b) => b.entries.length)).toEqual([20, 20, 5]);
		expect(queued()).toEqual([]);
	});

	it('zonder localStorage (privévenster) gaat de app gewoon door', () => {
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
	});
});
