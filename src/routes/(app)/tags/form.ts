import { z } from 'zod';
import { isIsoDate } from '#lib/dates.ts';
import { TAG_HUES } from '#lib/tags.ts';
import type { TagInput } from '#lib/server/tags.ts';

// Het formulier voor een nieuwe of gewijzigde tag, gedeeld door Tags en de tagpagina.

const isoDate = z.string().refine(isIsoDate, 'Ongeldige datum');

export const tagFormSchema = z.object({
	name: z.string().trim().min(1).max(40),
	startDate: isoDate.refine((d) => d >= '2000-01-01' && d <= '2100-12-31'),
	// Leeg of met "loopt door" aan: geen einde
	endDate: z.union([z.literal(''), isoDate]).optional(),
	open: z.literal('on').optional(),
	hue: z.coerce
		.number()
		.int()
		.refine((h) => (TAG_HUES as readonly number[]).includes(h))
});

export function toTagInput(data: z.infer<typeof tagFormSchema>): TagInput {
	return {
		name: data.name,
		startDate: data.startDate,
		endDate: data.open === 'on' || !data.endDate ? null : data.endDate,
		hue: data.hue
	};
}

export function fromForm(form: FormData) {
	return Object.fromEntries([...form].map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}
