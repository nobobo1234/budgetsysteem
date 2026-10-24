import type { RequestHandler } from './$types';

// Publiek alleen "ok"; de uitgebreide status staat achter de login.
export const GET: RequestHandler = () =>
	new Response('ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
