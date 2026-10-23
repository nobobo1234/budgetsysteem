import pino from 'pino';
import { config } from './config.ts';

// Gestructureerde JSON-logs. Nooit IBANs, bedragen, omschrijvingen, tokens of sessie-ID's:
// log alleen ID's, aantallen en soorten gebeurtenissen. De redact-lijst is een vangnet.
export const log = pino({
	level: config().NODE_ENV === 'test' ? 'silent' : config().LOG_LEVEL,
	base: undefined,
	redact: {
		paths: [
			'iban',
			'*.iban',
			'counterIban',
			'*.counterIban',
			'amountCents',
			'*.amountCents',
			'description',
			'*.description',
			'token',
			'*.token',
			'cookie',
			'*.cookie',
			'authorization',
			'*.authorization',
			'sessionId',
			'*.sessionId'
		],
		censor: '[weg]'
	}
});
