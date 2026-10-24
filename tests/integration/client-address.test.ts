// De health check van het deploy-script praat direct met de container, zonder nginx en dus
// zonder X-Real-IP. adapter-node gooit dan in getClientAddress(); dat mag geen 500 geven.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handle } from '../../src/hooks.server.ts';
import { clientAddress } from '../../src/lib/server/guard.ts';
import { fakeEvent, tempDatabase } from './helpers.ts';

let cleanup: () => void;
beforeAll(() => {
	cleanup = tempDatabase().cleanup;
});
afterAll(() => cleanup());

const noHeader = () => {
	throw new Error('Address header was specified with ADDRESS_HEADER=x-real-ip but is absent');
};

describe('verzoek zonder X-Real-IP', () => {
	it('valt terug op een vaste sleutel', () => {
		expect(clientAddress({ getClientAddress: noHeader })).toBe('direct');
		expect(clientAddress({ getClientAddress: () => '1.2.3.4' })).toBe('1.2.3.4');
	});

	it('/healthz geeft dan gewoon ok', async () => {
		const event = {
			...fakeEvent({ path: '/healthz', routeId: '/(public)/healthz' }),
			getClientAddress: noHeader
		};
		const response = await handle({ event, resolve: async () => new Response('ok') });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok');
	});

	it('een afgeschermde route blijft 401 geven', async () => {
		const event = {
			...fakeEvent({ path: '/', routeId: '/(app)', headers: { accept: 'text/html' } }),
			getClientAddress: noHeader
		};
		const response = await handle({
			event,
			resolve: async () => {
				throw new Error('mag niet worden aangeroepen');
			}
		});
		expect(response.status).toBe(401);
	});
});
