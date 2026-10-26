<script lang="ts">
	import type { IconDef } from '#lib/icons.ts';

	// Een lijn-icoon uit icons.ts in een vlak in de tint van het onderwerp, of in `hue` als iets
	// een eigen tint heeft, zoals een tag (spec: Componenten, Icoon met tint). Altijd decoratief:
	// de tekst ernaast zegt het.
	let { icon, hue }: { icon: IconDef; hue?: number } = $props();
</script>

<span class="icon-badge hue" style:--h={hue ?? icon.hue} aria-hidden="true">
	<svg viewBox="0 0 24 24"
		><path
			d={icon.path}
			fill="none"
			stroke="currentColor"
			stroke-width="1.7"
			stroke-linecap="round"
			stroke-linejoin="round"
		/></svg
	>
</span>
