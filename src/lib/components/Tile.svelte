<script lang="ts">
	import type { IconDef } from '#lib/icons.ts';

	// Tegel naar een pagina (spec: Componenten, Tegel): icoon met tint, titel en een actuele
	// waarde. Vraagt hij aandacht, dan krijgt hij een stip en een waarschuwende waarde. De titel
	// schuift bij de overgang mee naar de kop van de pagina (morph.ts).
	let {
		href,
		title,
		value,
		icon,
		warn = false
	}: { href: string; title: string; value: string; icon: IconDef; warn?: boolean } = $props();
</script>

<a class={['tile', warn && 'warn']} {href}>
	<span class="icon-badge hue" style:--h={icon.hue} aria-hidden="true">
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
	<span class="title" data-morph-to={href} data-morph-part="titel">{title}</span>
	<span class="value num">
		{#if warn}<span class="visually-hidden">Vraagt aandacht: </span>{/if}{value}
	</span>
	{#if warn}<span class="dot" aria-hidden="true"></span>{/if}
</a>

<style>
	.tile {
		position: relative;
		display: grid;
		grid-template-rows: auto 1fr auto;
		gap: 4px;
		height: 100%;
		min-height: 124px;
		padding: 14px;
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: var(--shadow);
		color: var(--text);
		text-decoration: none;
		transition:
			transform 220ms var(--ease-spring),
			box-shadow 220ms var(--ease-out);
	}

	.tile :global(.icon-badge) {
		margin-bottom: 10px;
	}

	.tile:active {
		transform: scale(0.97);
	}

	@media (hover: hover) {
		.tile:hover {
			transform: translateY(-2px);
			box-shadow:
				var(--shadow),
				0 10px 28px oklch(0.2 0.01 85 / 0.08);
		}

		.tile:hover :global(.icon-badge) {
			transform: rotate(-6deg) scale(1.06);
		}
	}

	.title {
		align-self: end;
		font-weight: 600;
		line-height: 1.25;
	}

	.value {
		color: var(--muted);
		font-size: 0.9rem;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.warn .value {
		color: color-mix(in oklch, var(--warn) 70%, var(--text));
		font-weight: 550;
	}

	.dot {
		position: absolute;
		top: 14px;
		right: 14px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--warn);
		box-shadow: 0 0 0 4px color-mix(in oklch, var(--warn) 22%, transparent);
	}

	@media (prefers-reduced-motion: reduce) {
		.tile:hover,
		.tile:hover :global(.icon-badge) {
			transform: none;
		}
	}
</style>
