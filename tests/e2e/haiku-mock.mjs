// Nagebootste Haiku voor de e2e-tests: de app wijst met ANTHROPIC_BASE_URL hierheen, zodat er
// nooit een echte API-aanroep gaat. Elke bon wordt "gelezen" als een verzonnen winkel met een
// onleesbaar totaal (onzeker), zodat hij in de review-inbox komt. Na een korte pauze, zodat de
// laadstaat te zien is. Een test die een screenshot met transacties wil, zet dat vooraf met
// `POST /volgende` (body `lijst`); alleen het eerstvolgende antwoord is dan een lijst.
import { createServer } from 'node:http';

const PORT = Number(process.env.HAIKU_MOCK_PORT ?? 4199);
const DELAY_MS = 1500;
let count = 0;
/** @type {'bon' | 'lijst'} */
let next = 'bon';

/** @param {string} waarde */
const sure = (waarde) => ({ waarde, zekerheid: 'zeker', notitie: '' });

const empty = { waarde: '', zekerheid: 'onleesbaar', notitie: '' };

/** @param {number} days */
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

// Namen en bedragen verschillen per keer zoveel dat de koppellijst een eerdere run (zelfde
// database, ook uit het andere browserproject) niet als kandidaat ziet
const SHOPS = ['Kaasboer', 'Visman', 'Slager', 'Bloemist', 'Drogist', 'Tuincentrum', 'Kapper'];
const CAFES = ['Espressobar', 'Theehuis', 'Lunchroom', 'Bistro', 'Patisserie', 'Snackbar'];

/** Drie transacties zoals op een screenshot van de bankapp. */
function list() {
	return {
		beeld: 'lijst',
		winkel: empty,
		datum: empty,
		totaal: empty,
		valuta: empty,
		betaalwijze: empty,
		regels: [],
		transacties: [
			{
				datum: sure(daysAgo(1)),
				tegenpartij: sure(`${SHOPS[count % SHOPS.length]} ${count}`),
				bedrag: sure(`-${count * 3}.10`),
				valuta: sure('EUR')
			},
			{
				datum: sure(daysAgo(1)),
				tegenpartij: sure(`Proefwerkgever ${count}`),
				bedrag: sure(`${1000 + count * 37}.00`),
				valuta: sure('EUR')
			},
			{
				datum: sure(daysAgo(2)),
				tegenpartij: sure(`${CAFES[count % CAFES.length]} ${count}`),
				bedrag: sure(`-${count * 3}.50`),
				valuta: sure('USD')
			}
		]
	};
}

function output() {
	const yesterday = daysAgo(1);
	count++;
	if (next === 'lijst') {
		next = 'bon';
		return list();
	}
	return {
		beeld: 'bon',
		winkel: sure(`Proefwinkel ${count}`),
		datum: sure(yesterday),
		totaal: { waarde: '', zekerheid: 'onleesbaar', notitie: 'Totaal is weggevouwen' },
		valuta: sure('EUR'),
		betaalwijze: sure('pin'),
		regels: [],
		transacties: []
	};
}

createServer((req, res) => {
	if (req.method === 'GET' && req.url === '/healthz') {
		res.end('ok');
		return;
	}
	if (req.method === 'POST' && req.url === '/volgende') {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			next = body.trim() === 'lijst' ? 'lijst' : 'bon';
			res.end(next);
		});
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
