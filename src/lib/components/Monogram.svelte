<script lang="ts">
	import { groupHue } from '#lib/categoryColor.ts';
	import { initials } from '#lib/text.ts';

	// Monogram (spec: Componenten): ronde initialen in de kleur van de categoriegroep, of voor
	// een persoon een vaste tint op basis van de naam. Geen logo's van buiten (privacy, CSP).
	// Decoratief: de naam staat er altijd naast.
	let {
		name,
		group,
		size = 40
	}: {
		name: string;
		/** Categoriegroep: dan de tint van die groep; `null` is zonder categorie (grijs) */
		group?: string | null;
		size?: 32 | 40 | 48;
	} = $props();

	const hue = $derived(group === null ? null : groupHue(group ?? name));
</script>

<span
	class={['monogram', hue !== null && 'hue']}
	style:--h={hue}
	style:--size="{size}px"
	aria-hidden="true">{initials(name)}</span
>

<style>
	.monogram {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--size);
		height: var(--size);
		border-radius: 50%;
		background: var(--wash, var(--surface-2));
		color: var(--ink, var(--muted));
		font-size: calc(var(--size) * 0.38);
		font-weight: 650;
		letter-spacing: 0.02em;
		line-height: 1;
		user-select: none;
	}
</style>
