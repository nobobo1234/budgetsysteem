import { db } from '#lib/server/db/index.ts';
import { meerNeedsAttention } from '#lib/server/meer.ts';
import type { LayoutServerLoad } from './$types';

// Stip op de tab Meer als daar iets aandacht vraagt (spec: Navigatie). Draait alleen bij een
// volledige load en na invalidate, niet bij elke navigatie.
export const load: LayoutServerLoad = () => ({ meerAttention: meerNeedsAttention(db()) });
