import type { Answer } from './semantic/answer.ts';

// Het vraagveld (spec: Vragen en samenvattingen met AI → Vraagveld): wat de pagina en de server
// delen. Het model vertaalt alleen de vraag; het getal, de lijst en de zin komen uit code.

/** De soort van een gestelde vraag, zoals in `questions` en de telemetrie. */
export const QUESTION_OUTCOMES = ['beantwoord', 'verduidelijken', 'kan_niet'] as const;
export type QuestionOutcome = (typeof QUESTION_OUTCOMES)[number];

export const VERDICTS = ['goed', 'fout'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Zoveel vragen per uur (spec: Vraagveld, Grenzen). */
export const QUESTIONS_PER_HOUR = 30;
/** Zoveel vragen blijven bewaard; oudere gaan weg. */
export const KEEP_QUESTIONS = 100;
/** Zoveel eerdere vragen staan onder het veld. */
export const HISTORY_SHOWN = 10;

/** Een verduidelijking: één vraag terug, met hooguit vier keuzes als chips. */
export interface Clarification {
	text: string;
	choices: string[];
	/**
	 * `model`: een keuze stelt de vraag opnieuw met de keuze erbij. `code`: code vond meer
	 * tegenpartijen; een keuze rekent meteen uit, zonder model.
	 */
	source: 'model' | 'code';
}

/** Wat een gestelde of opnieuw uitgerekende vraag oplevert. */
export type QuestionResult =
	| { kind: 'beantwoord'; id: string; question: string; answer: Answer; wrong: boolean }
	| { kind: 'verduidelijken'; id: string; question: string; clarification: Clarification }
	| { kind: 'kan_niet'; id: string; question: string; reason: string; example: string };

/** Een eerdere vraag onder het veld: de vraag, de soort en de aannames, nooit het resultaat. */
export interface HistoryItem {
	id: string;
	question: string;
	kind: QuestionOutcome;
	assumptions: string[];
	createdAt: string;
}

export const OUTCOME_LABEL: Record<QuestionOutcome, string> = {
	beantwoord: 'Beantwoord',
	verduidelijken: 'Vroeg om verduidelijking',
	kan_niet: 'Kan niet'
};
