import { z } from 'zod';
import { isIsoDate } from '#lib/dates.ts';
import { MAX_LIFETIME_YEARS } from '#lib/warranty.ts';
import type { WarrantyFields } from '#lib/server/warranty.ts';

// Formulieren voor garantie, gedeeld door Te controleren, de transactie, de bon en het product.

const isoDate = z
	.string()
	.refine(isIsoDate, 'Ongeldige datum')
	.refine((d) => d >= '2000-01-01' && d <= '2100-12-31');

export const productName = z.string().trim().min(1).max(60);

/** Garantie bijhouden: alleen de naam; de rest pas je aan op de pagina van het product. */
export const startSchema = z.object({ transactionId: z.uuid(), product: productName });

export const fieldsSchema = z.object({
	product: productName,
	deliveryDate: isoDate,
	factoryUntil: z.union([z.literal(''), isoDate]),
	lifetimeYears: z.coerce.number().int().min(1).max(MAX_LIFETIME_YEARS)
});

export function toFields(data: z.infer<typeof fieldsSchema>): WarrantyFields {
	return { ...data, factoryUntil: data.factoryUntil || null };
}

export function fromForm(form: FormData) {
	return Object.fromEntries([...form].map(([k, v]) => [k, typeof v === 'string' ? v : '']));
}
