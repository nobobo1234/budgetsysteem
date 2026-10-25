import { describe, expect, it } from 'vitest';
import { displayName, initials } from './text.ts';

// E25: tegenpartijen in hoofdletters tonen als nette naam, alleen in de weergave
describe('nette naam van een tegenpartij', () => {
	it.each([
		['ALBERT HEIJN 1403 UTRECHT', 'Albert Heijn'],
		['KRUIDVAT 7012 UTRECHT', 'Kruidvat'],
		['JUMBO UTRECHT LEIDSCHE RIJN', 'Jumbo'],
		['ZIGGO SERVICES BV', 'Ziggo Services'],
		['ZILVEREN KRUIS ACHMEA', 'Zilveren Kruis Achmea'],
		['CAFE DE BASTAARD', 'Cafe de Bastaard'],
		['NS GROEP IZ NS REIZIGERS', 'NS Groep IZ NS Reizigers'],
		['THUISBEZORGD.NL', 'Thuisbezorgd.nl'],
		['AH TO GO 5521 AMSTERDAM', 'AH To Go'],
		['KPN B.V.', 'KPN'],
		['ING BANK N.V.', 'ING Bank'],
		["BAKKER BART'S", "Bakker Bart's"],
		['CCV*BAKKER BART 12', 'Bakker Bart'],
		['SumUp *Koffiebar Utrecht', 'Koffiebar Utrecht'],
		['ANWB', 'ANWB']
	])('%s wordt %s', (raw, nice) => {
		expect(displayName(raw)).toBe(nice);
	});

	it('laat namen met kleine letters staan', () => {
		expect(displayName('Spotify AB')).toBe('Spotify AB');
		expect(displayName('Woonstichting De Linde')).toBe('Woonstichting De Linde');
		expect(displayName('etentje')).toBe('etentje');
		expect(displayName('S. de Vries')).toBe('S. de Vries');
	});

	it('haalt alleen een rechtsvorm weg als er een naam overblijft', () => {
		expect(displayName('Werkgever B.V.')).toBe('Werkgever');
		expect(displayName('BV')).toBe('BV');
	});

	it('kapt nooit de hele naam af', () => {
		expect(displayName('1403 UTRECHT')).toBe('1403 Utrecht');
		expect(displayName('UTRECHT')).toBe('Utrecht');
		expect(displayName('')).toBe('');
		expect(displayName('   ')).toBe('');
	});

	it('verandert cijfers en tekens niet in iets anders', () => {
		expect(displayName('123')).toBe('123');
		expect(displayName('€ 5 ACTIE')).toBe('€ 5 Actie');
	});
});

describe('initialen voor een monogram', () => {
	it.each([
		['ALBERT HEIJN 1403 UTRECHT', 'AH'],
		['sanne', 'S'],
		['Sanne de Vries', 'SV'],
		['S. de Vries', 'SV'],
		['Woonstichting De Linde', 'WL'],
		['ZILVEREN KRUIS ACHMEA', 'ZA'],
		['etentje', 'E'],
		['', '?'],
		['€', '?'],
		['éva', 'É']
	])('%s geeft %s', (name, letters) => {
		expect(initials(name)).toBe(letters);
	});
});
