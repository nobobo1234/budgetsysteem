import { describe, expect, it, vi } from 'vitest';
import { ping } from './ping.ts';

const URL = 'https://ping.example/0b6c1c1e-test';

describe('externe ping', () => {
	it('pingt de URL als de app gezond is', async () => {
		const fetcher = vi.fn(async () => new Response('OK'));
		expect(await ping(URL, () => true, fetcher)).toBe(true);
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(URL);
		expect(init.credentials).toBe('omit');
		expect(init.redirect).toBe('error');
		expect(init.signal).toBeInstanceOf(AbortSignal);
		expect(init.body).toBeUndefined();
	});

	it('pingt niet als de database niet bereikbaar is', async () => {
		const fetcher = vi.fn(async () => new Response('OK'));
		expect(await ping(URL, () => false, fetcher)).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('gooit niet bij een netwerkfout of een foutstatus', async () => {
		const down = vi.fn(async () => {
			throw new TypeError('fetch failed');
		});
		expect(await ping(URL, () => true, down)).toBe(false);
		const refused = vi.fn(async () => new Response('nee', { status: 404 }));
		expect(await ping(URL, () => true, refused)).toBe(false);
	});
});
