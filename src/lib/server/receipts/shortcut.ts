import { createHash } from 'node:crypto';

// De iOS-opdracht "Bon naar Budget" voor het deelmenu van Foto's (spec: Uploaden via het
// deelmenu, stap 2). Dit is de leesbare bron; `scripts/sign-shortcut.ts` maakt er op een Mac
// een ondertekend .shortcut-bestand van (shortcut-signed.ts), dat de app als download aanbiedt.
//
// Het token zit nooit in het bestand. De opdracht vraagt het bij installeren (importvraag op
// de tekstactie) en bewaart het alleen in de opdracht op je eigen telefoon. Deelt iemand die
// opdracht toch, dan maakt iOS het veld van een importvraag leeg; deel hem toch nooit.
//
// Per afbeelding: hooguit 2576 px aan de lange kant (nooit vergroten), JPEG met kwaliteit 0,9
// zonder metadata, en als ruwe body naar POST /api/ingest met `Authorization: Bearer <token>`.

export const SHORTCUT_NAME = 'Bon naar Budget';
export const INGEST_URL = 'https://finance.mijndomein.nl/api/ingest';
export const MAX_EDGE = 2576;
export const JPEG_QUALITY = 0.9;

type Plist = string | number | boolean | Plist[] | { [key: string]: Plist };

type Ref =
	| { Type: 'ActionOutput'; OutputUUID: string; OutputName: string }
	| { Type: 'ExtensionInput' }
	| { Type: 'Variable'; VariableName: string };

// Vaste UUID's: dezelfde definitie geeft altijd hetzelfde bestand (en dezelfde hash)
const ID = {
	// De tekstactie waarin je bij installeren plakt (geen geheim: een vaste actie-ID)
	pasted: '4979F60A-BFF6-4735-96BE-04801FDBB60D',
	repeat: '5F38DC2B-C3E4-473D-812D-CD479E5EB8B4',
	width: '4FDCF33F-B3CF-47DF-B6C6-BA3D9D408D80',
	height: 'A16E39FE-433A-4FDA-8CF6-6593FFCC4A60',
	ifWidth: '2AFCD82F-E1C0-43FE-B100-4FB7DB598F7E',
	ifHeight: '219E3C95-EF72-4B12-9BD6-A54C3F1AE1BD',
	resizeWide: '37EC98D1-8EE8-4B94-A1B3-E44994D1CFFC',
	resizeTall: '9AAD6D6F-8BD6-425D-B608-0F3BD7FCE766',
	jpeg: 'FB4C4FB2-280E-49A2-9233-36726B220ED3',
	upload: 'C2397C7D-FF84-48E6-A532-C4916804F161',
	ifFailed: 'C56322A8-570B-4BEF-8542-9CEDB8CB2756',
	receiptId: '0B7E5E7C-3D52-4F7B-9C55-2F8C1A4D6E01',
	message: '6C1D9A3E-8B24-4E5F-A7D0-93B2C4E1F802'
} as const;

/** Waar in de opdracht een tekst een variabele invoegt (NSRange-teken U+FFFC). */
const OBJECT = String.fromCharCode(0xfffc);

const BON = 'Bon';
const REPEAT_ITEM: Ref = { Type: 'Variable', VariableName: 'Repeat Item' };
const output = (uuid: string, name: string): Ref => ({
	Type: 'ActionOutput',
	OutputUUID: uuid,
	OutputName: name
});

function attachment(ref: Ref): Plist {
	return { Value: ref, WFSerializationType: 'WFTextTokenAttachment' };
}

function text(...parts: (string | Ref)[]): Plist {
	let string = '';
	const ranges: Record<string, Plist> = {};
	for (const part of parts) {
		if (typeof part === 'string') {
			string += part;
		} else {
			ranges[`{${string.length}, 1}`] = part;
			string += OBJECT;
		}
	}
	return {
		Value: { string, attachmentsByRange: ranges },
		WFSerializationType: 'WFTextTokenString'
	};
}

function action(id: string, parameters: Record<string, Plist> = {}): Plist {
	return {
		WFWorkflowActionIdentifier: `is.workflow.actions.${id}`,
		WFWorkflowActionParameters: parameters
	};
}

/** Een als-blok; `mode` 0 is het begin, 1 is "anders", 2 is het einde. */
function conditional(group: string, mode: 0 | 1 | 2, extra: Record<string, Plist> = {}): Plist {
	return action('conditional', { GroupingIdentifier: group, WFControlFlowMode: mode, ...extra });
}

const ifInput = (ref: Ref): Plist => ({ Type: 'Variable', Variable: attachment(ref) });

// Voorwaarden in een als-blok
const GREATER_THAN = 2;
// Een tekstvergelijking ("is niet") weigert Opdrachten op macOS 26 bij een woordenboekwaarde
const HAS_NO_VALUE = 101;

function resize(uuid: string): Plist[] {
	return [
		action('image.resize', {
			UUID: uuid,
			WFImage: attachment({ Type: 'Variable', VariableName: BON }),
			WFImageResizeKey: 'Longest Edge',
			WFImageResizeLength: String(MAX_EDGE)
		}),
		action('setvariable', {
			WFVariableName: BON,
			WFInput: attachment(output(uuid, 'Resized Image'))
		})
	];
}

export function shortcutActions(ingestUrl = INGEST_URL): Plist[] {
	return [
		action('comment', {
			WFCommentActionText:
				'Stuurt bonnetjes uit Foto’s naar je review-inbox in Budget. Bij installeren plak je hieronder je upload-token uit Instellingen › Apparaten. Deel deze opdracht nooit met het token erin; maak voor een nieuw apparaat een nieuw token aan.'
		}),
		// Index 1: het token, ingevuld via de importvraag
		action('gettext', { UUID: ID.pasted, WFTextActionText: '' }),
		action('repeat.each', {
			GroupingIdentifier: ID.repeat,
			WFControlFlowMode: 0,
			WFInput: attachment({ Type: 'ExtensionInput' })
		}),
		action('setvariable', { WFVariableName: BON, WFInput: attachment(REPEAT_ITEM) }),
		action('properties.images', {
			UUID: ID.width,
			WFInput: attachment(REPEAT_ITEM),
			WFContentItemPropertyName: 'Width'
		}),
		action('properties.images', {
			UUID: ID.height,
			WFInput: attachment(REPEAT_ITEM),
			WFContentItemPropertyName: 'Height'
		}),
		// Alleen verkleinen, nooit vergroten
		conditional(ID.ifWidth, 0, {
			WFInput: ifInput(output(ID.width, 'Width')),
			WFCondition: GREATER_THAN,
			WFNumberValue: String(MAX_EDGE)
		}),
		...resize(ID.resizeWide),
		conditional(ID.ifWidth, 1),
		conditional(ID.ifHeight, 0, {
			WFInput: ifInput(output(ID.height, 'Height')),
			WFCondition: GREATER_THAN,
			WFNumberValue: String(MAX_EDGE)
		}),
		...resize(ID.resizeTall),
		conditional(ID.ifHeight, 2),
		conditional(ID.ifWidth, 2),
		// Eén keer comprimeren, zonder EXIF (locatie)
		action('image.convert', {
			UUID: ID.jpeg,
			WFInput: attachment({ Type: 'Variable', VariableName: BON }),
			WFImageFormat: 'JPEG',
			WFImageCompressionQuality: JPEG_QUALITY,
			WFImagePreserveMetadata: false
		}),
		// Ruwe body, geen formulier (spec: Wat het token mag)
		action('downloadurl', {
			UUID: ID.upload,
			WFURL: ingestUrl,
			WFHTTPMethod: 'POST',
			WFHTTPBodyType: 'File',
			WFRequestVariable: attachment(output(ID.jpeg, 'Converted Image')),
			ShowHeaders: true,
			WFHTTPHeaders: {
				Value: {
					WFDictionaryFieldValueItems: [
						{
							WFItemType: 0,
							WFKey: text('Authorization'),
							WFValue: text('Bearer ', output(ID.pasted, 'Text'))
						},
						{ WFItemType: 0, WFKey: text('Content-Type'), WFValue: text('image/jpeg') }
					]
				},
				WFSerializationType: 'WFDictionaryFieldValue'
			}
		}),
		// Het antwoord is { status: 'ontvangen', id } of { message } bij een fout
		action('getvalueforkey', {
			UUID: ID.receiptId,
			WFInput: attachment(output(ID.upload, 'Contents of URL')),
			WFGetDictionaryValueType: 'Value',
			WFDictionaryKey: 'id'
		}),
		conditional(ID.ifFailed, 0, {
			WFInput: ifInput(output(ID.receiptId, 'Dictionary Value')),
			WFCondition: HAS_NO_VALUE
		}),
		action('getvalueforkey', {
			UUID: ID.message,
			WFInput: attachment(output(ID.upload, 'Contents of URL')),
			WFGetDictionaryValueType: 'Value',
			WFDictionaryKey: 'message'
		}),
		action('alert', {
			WFAlertActionTitle: 'Bon niet verstuurd',
			// Nooit leeg: een lege melding is voor Opdrachten een ontbrekende parameter
			WFAlertActionMessage: text('De bon kwam niet aan. ', output(ID.message, 'Dictionary Value')),
			WFAlertActionCancelButtonShown: false
		}),
		action('exit'),
		conditional(ID.ifFailed, 2),
		action('repeat.each', { GroupingIdentifier: ID.repeat, WFControlFlowMode: 2 }),
		action('notification', {
			WFNotificationActionTitle: 'Budget',
			WFNotificationActionBody: 'Ontvangen. De bon wordt nu gelezen.'
		})
	];
}

/** De volledige opdracht, zoals hij in het (nog niet ondertekende) bestand komt. */
export function shortcutDefinition(ingestUrl = INGEST_URL): Plist {
	return {
		WFWorkflowClientVersion: '4711',
		WFWorkflowMinimumClientVersion: 900,
		WFWorkflowMinimumClientVersionString: '900',
		WFWorkflowIcon: { WFWorkflowIconStartColor: 4292093695, WFWorkflowIconGlyphNumber: 59511 },
		WFWorkflowTypes: ['ActionExtension'],
		WFWorkflowInputContentItemClasses: ['WFImageContentItem'],
		WFWorkflowOutputContentItemClasses: [],
		WFWorkflowHasShortcutInputVariables: true,
		WFWorkflowImportQuestions: [
			{
				ActionIndex: 1,
				Category: 'Parameter',
				ParameterKey: 'WFTextActionText',
				DefaultValue: '',
				Text: 'Plak je upload-token uit Budget (Instellingen › Apparaten). Het begint met bon_.'
			}
		],
		WFWorkflowActions: shortcutActions(ingestUrl)
	};
}

const escapeXml = (s: string) =>
	s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function serialize(value: Plist, indent: string): string {
	const inner = indent + '\t';
	if (typeof value === 'string') return `${indent}<string>${escapeXml(value)}</string>`;
	if (typeof value === 'boolean') return `${indent}<${value}/>`;
	if (typeof value === 'number') {
		return Number.isInteger(value)
			? `${indent}<integer>${value}</integer>`
			: `${indent}<real>${value}</real>`;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return `${indent}<array/>`;
		return [`${indent}<array>`, ...value.map((v) => serialize(v, inner)), `${indent}</array>`].join(
			'\n'
		);
	}
	const keys = Object.keys(value).sort();
	if (keys.length === 0) return `${indent}<dict/>`;
	return [
		`${indent}<dict>`,
		...keys.flatMap((k) => [`${inner}<key>${escapeXml(k)}</key>`, serialize(value[k]!, inner)]),
		`${indent}</dict>`
	].join('\n');
}

/** XML-plist; `plutil` maakt er bij het ondertekenen een binaire plist van. */
export function shortcutPlist(ingestUrl = INGEST_URL): string {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		serialize(shortcutDefinition(ingestUrl), ''),
		'</plist>',
		''
	].join('\n');
}

/** Een maand voordat het certificaat verloopt, vraagt de app om opnieuw te ondertekenen. */
export const RENEW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ShortcutStatus =
	| { state: 'ok' | 'expiring' | 'expired'; validUntil: string }
	| { state: 'other-host'; validUntil: string; host: string };

/**
 * Of de app de ondertekende opdracht kan aanbieden. Hij stuurt naar de host waarvoor hij
 * ondertekend is; draait de app ergens anders (een eigen installatie, lokaal), dan zou de
 * download bonnen en tokens naar die andere host sturen, dus dan niet. Na `validUntil`
 * installeert iOS hem (waarschijnlijk) niet meer; een opdracht die al op een telefoon staat,
 * blijft werken.
 */
export function shortcutStatus(
	signed: { url: string; validUntil: string },
	origin: string,
	now = new Date()
): ShortcutStatus {
	const { validUntil } = signed;
	const target = new URL(signed.url);
	if (target.origin !== new URL(origin).origin) {
		return { state: 'other-host', validUntil, host: target.host };
	}
	// Vanaf het begin van de dag (UTC) als verlopen rekenen: liever een dag te vroeg
	const expires = Date.parse(`${validUntil}T00:00:00Z`);
	if (now.getTime() >= expires) return { state: 'expired', validUntil };
	if (now.getTime() >= expires - RENEW_DAYS * DAY_MS) return { state: 'expiring', validUntil };
	return { state: 'ok', validUntil };
}

/** Hash van de bron, zodat een test ziet dat het ondertekende bestand bij deze definitie hoort. */
export function shortcutSourceHash(ingestUrl = INGEST_URL): string {
	return createHash('sha256').update(shortcutPlist(ingestUrl)).digest('hex');
}
