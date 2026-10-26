import { describe, expect, it } from 'vitest';
import { formatEntryTime, streakSentence } from './usage-view.ts';

describe('formatEntryTime', () => {
	it('onder de minuut in seconden met één decimaal', () => {
		expect(formatEntryTime(0)).toBe('0,0 s');
		expect(formatEntryTime(8400)).toBe('8,4 s');
		expect(formatEntryTime(59_900)).toBe('59,9 s');
	});

	it('daarboven in minuten en seconden', () => {
		expect(formatEntryTime(59_960)).toBe('1 min');
		expect(formatEntryTime(80_000)).toBe('1 min 20 s');
		expect(formatEntryTime(30 * 60_000)).toBe('30 min');
	});
});

describe('streakSentence', () => {
	it('vandaag al ingevoerd, met de reeks', () => {
		expect(streakSentence({ streak: 5, longestStreak: 5, today: true })).toBe(
			'Vandaag al ingevoerd, 5 dagen op rij.'
		);
		expect(streakSentence({ streak: 1, longestStreak: 1, today: true })).toBe(
			'Vandaag al ingevoerd.'
		);
	});

	it('vandaag nog niets: wat de reeks wordt als je iets invoert', () => {
		expect(streakSentence({ streak: 3, longestStreak: 3, today: false })).toBe(
			'Vandaag nog niets. Voer iets in en je reeks wordt 4 dagen.'
		);
		expect(streakSentence({ streak: 0, longestStreak: 0, today: false })).toBe(
			'Vandaag nog niets ingevoerd.'
		);
	});

	it('noemt de langste reeks als die langer was', () => {
		expect(streakSentence({ streak: 2, longestStreak: 9, today: true })).toBe(
			'Vandaag al ingevoerd, 2 dagen op rij. Je langste reeks was 9 dagen.'
		);
	});
});
