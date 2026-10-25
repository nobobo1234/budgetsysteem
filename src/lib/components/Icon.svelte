<script lang="ts">
	import { ICONS, type IconName } from '#lib/icons.ts';

	// Een lijn-icoon uit icons.ts. Met `badge` staat het in een vlak in de tint van het
	// onderwerp (spec: Componenten, Icoon met tint). Altijd decoratief: de tekst ernaast zegt het.
	let { name, badge = false }: { name: IconName; badge?: boolean } = $props();
</script>

{#snippet svg()}
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path
			d={ICONS[name].path}
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
{/snippet}

{#if badge}
	<span class="icon-badge hue" style:--h={ICONS[name].hue} aria-hidden="true">{@render svg()}</span>
{:else}
	{@render svg()}
{/if}
