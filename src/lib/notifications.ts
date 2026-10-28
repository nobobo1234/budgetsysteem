// Soorten pushmeldingen (spec: Dagelijks gebruik → Meldingen, Telemetrie en monitoring,
// OWASP A09). Gedeeld door server en instellingenpagina. Een soort mag al bestaan voordat de
// bron er is; de schakelaar staat dan klaar.

export type NotificationGroup = 'geld' | 'server' | 'beveiliging';

export interface NotificationKindInfo {
	group: NotificationGroup;
	/** Titel van de melding zelf; nooit bedragen of namen. */
	title: string;
	/** Label bij de schakelaar. */
	label: string;
	/** Uitleg onder het label. */
	hint: string;
	/** Beveiligingsmeldingen staan altijd aan: wie je sessie heeft, mag ze niet uitzetten. */
	switchable: boolean;
}

export const NOTIFICATION_KINDS = {
	vaste_last: {
		group: 'geld',
		title: 'Vaste lasten',
		label: 'Vaste last klaar',
		hint: 'Een verwachte vaste last wacht op bevestiging',
		switchable: true
	},
	bon: {
		group: 'geld',
		title: 'Bonnetjes',
		label: 'Bon gelezen',
		hint: 'Een bon is gelezen of heeft je controle nodig',
		switchable: true
	},
	budget_90: {
		group: 'geld',
		title: 'Budget',
		label: 'Categorie op 90%',
		hint: 'Gemeten op het deel buiten vaste lasten en reserveringen',
		switchable: true
	},
	tikkie: {
		group: 'geld',
		title: 'Te krijgen',
		label: 'Tikkie 14 dagen open',
		hint: 'Iemand heeft je na twee weken nog niet terugbetaald',
		switchable: true
	},
	terugbetaling: {
		group: 'geld',
		title: 'Terugbetalingen',
		label: 'Terugbetaling te laat',
		hint: 'Een aandeel in een gedeelde vaste last is een week na de ontvangstdag niet binnen',
		switchable: true
	},
	maand: {
		group: 'geld',
		title: 'Maandafsluiting',
		label: 'Maand voorbij',
		hint: 'De afsluiting van de vorige maand staat klaar',
		switchable: true
	},
	garantie: {
		group: 'geld',
		title: 'Garantie',
		label: 'Garantie loopt af',
		hint: 'Dertig dagen voor het einde van het eerste jaar en van de fabrieksgarantie',
		switchable: true
	},
	fout: {
		group: 'server',
		title: 'Server',
		label: 'Nieuw soort fout',
		hint: 'Eén melding per soort fout',
		switchable: true
	},
	backup: {
		group: 'server',
		title: 'Backup',
		label: 'Backup te oud',
		hint: 'Restic ouder dan 26 uur of Litestream loopt een uur achter',
		switchable: true
	},
	schijf: {
		group: 'server',
		title: 'Server',
		label: 'Schijf bijna vol',
		hint: 'Meer dan 80% van de schijf is gebruikt',
		switchable: true
	},
	beveiliging: {
		group: 'beveiliging',
		title: 'Beveiliging',
		label: 'Nieuwe passkey, herstelcode of upload-token',
		hint: 'Staat altijd aan, zodat je het merkt als iemand anders binnenkomt',
		switchable: false
	}
} as const satisfies Record<string, NotificationKindInfo>;

export type NotificationKind = keyof typeof NOTIFICATION_KINDS;

export const NOTIFICATION_KIND_KEYS = Object.keys(NOTIFICATION_KINDS) as NotificationKind[];

/** Instelling naast de soorten: bedragen en namen tonen in de melding (en dus op het vergrendelscherm). */
export const LOCKSCREEN_SETTING = 'vergrendelscherm';

export type NotificationSettingKey = NotificationKind | typeof LOCKSCREEN_SETTING;

export type NotificationSettings = Record<NotificationSettingKey, boolean>;

/** Standaard staan alle soorten aan en staan er geen bedragen of namen op het vergrendelscherm. */
export const DEFAULT_SETTINGS: NotificationSettings = {
	...(Object.fromEntries(NOTIFICATION_KIND_KEYS.map((k) => [k, true])) as Record<
		NotificationKind,
		boolean
	>),
	[LOCKSCREEN_SETTING]: false
};

export function isSwitchableSetting(key: string): key is NotificationSettingKey {
	if (key === LOCKSCREEN_SETTING) return true;
	return (
		Object.hasOwn(NOTIFICATION_KINDS, key) && NOTIFICATION_KINDS[key as NotificationKind].switchable
	);
}

/** Of een melding van deze soort uit mag; beveiliging altijd. */
export function kindEnabled(settings: NotificationSettings, kind: NotificationKind): boolean {
	return !NOTIFICATION_KINDS[kind].switchable || settings[kind];
}

export interface NotificationText {
	/** Tekst zonder bedragen of namen, altijd veilig voor het vergrendelscherm. */
	text: string;
	/** Tekst met bedragen of namen; alleen gebruikt als dat aanstaat. */
	detail?: string;
}

/** Welke tekst in de melding komt, volgens de vergrendelscherm-instelling. */
export function notificationBody(
	settings: NotificationSettings,
	message: NotificationText
): string {
	return settings[LOCKSCREEN_SETTING] && message.detail ? message.detail : message.text;
}
