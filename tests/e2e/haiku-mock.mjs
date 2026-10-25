// Nagebootste Haiku voor de e2e-tests: de app wijst met ANTHROPIC_BASE_URL hierheen, zodat er
// nooit een echte API-aanroep gaat. Elke bon wordt "gelezen" als een verzonnen winkel met een
// onleesbaar totaal (onzeker), zodat hij in de review-inbox komt. Na een korte pauze, zodat de
// laadstaat te zien is.
import { createServer } from 'node:http';

const PORT = Number(process.env.HAIKU_MOCK_PORT ?? 4199);
const DELAY_MS = 1500;
let count = 0;

/** @param {string} waarde */
const sure = (waarde) => ({ waarde, zekerheid: 'zeker', notitie: '' });

function output() {
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	count++;
	return {
		winkel: sure(`Proefwinkel ${count}`),
		datum: sure(yesterday),
		totaal: { waarde: '', zekerheid: 'onleesbaar', notitie: 'Totaal is weggevouwen' },
		valuta: sure('EUR'),
		betaalwijze: sure('pin'),
		regels: []
	};
}

createServer((req, res) => {
	if (req.method === 'GET' && req.url === '/healthz') {
		res.end('ok');
		return;
	}
	if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
		res.writeHead(404).end();
		return;
	}
	req.resume();
	req.on('end', () => {
		setTimeout(() => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(
				JSON.stringify({
					id: `msg_e2e_${count}`,
					type: 'message',
					role: 'assistant',
					model: 'claude-haiku-5-5',
					content: [{ type: 'text', text: JSON.stringify(output()) }],
					stop_reason: 'end_turn',
					stop_sequence: null,
					usage: { input_tokens: 2100, output_tokens: 180 }
				})
			);
		}, DELAY_MS);
	});
}).listen(PORT, '127.0.0.1');
