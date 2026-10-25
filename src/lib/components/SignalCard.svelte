<script lang="ts">
	import type { MorphPart } from '#lib/morph.ts';
	import type { IconDef } from '#lib/icons.ts';

	// Signaalkaartje (spec: Componenten): iets dat op je wacht, met een groot getal of woord
	// en een korte regel eronder. Alleen tonen als er iets is. Het grote deel kan bij de
	// overgang meeschuiven naar de kop van de pagina (morph.ts).
	let {
		href,
		icon,
		big,
		small,
		morph,
		warn = false
	}: {
		href: string;
		icon: IconDef;
		big: string;
		small: string;
		morph?: MorphPart;
		warn?: boolean;
	} = $props();
</script>

<a class={['signal', warn && 'warn']} {href}>
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
	<span class="text">
		<span class="big num" data-morph-to={morph ? href : undefined} data-morph-part={morph}
			>{big}</span
		>
		<span class="small"
			>{#if warn}<span class="visually-hidden">Vraagt aandacht: </span>{/if}{small}</span
		>
	</span>
</a>

<style>
	.signal {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 10px;
		height: 100%;
		min-height: 72px;
		padding: 12px 14px;
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: var(--shadow);
		color: var(--text);
		text-decoration: none;
		transition:
			transform 220ms var(--ease-spring),
			box-shadow 220ms var(--ease-out);
	}

	/* Breed genoeg: icoon naast de tekst */
	@container (min-width: 600px) {
		.signal {
			flex-direction: row;
			align-items: center;
			gap: 12px;
		}
	}

	.signal:active {
		transform: scale(0.97);
	}

	@media (hover: hover) {
		.signal:hover {
			transform: translateY(-2px);
		}

		.signal:hover :global(.icon-badge) {
			transform: rotate(-6deg) scale(1.06);
		}
	}

	.warn::after {
		content: '';
		position: absolute;
		top: 10px;
		right: 10px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--warn);
	}

	.text {
		display: grid;
		min-width: 0;
	}

	.big {
		font-size: 1.15rem;
		font-weight: 650;
		letter-spacing: -0.01em;
		line-height: 1.2;
	}

	.small {
		color: var(--muted);
		font-size: 0.86rem;
		line-height: 1.3;
	}

	@media (prefers-reduced-motion: reduce) {
		.signal:hover,
		.signal:hover :global(.icon-badge) {
			transform: none;
		}
	}
</style>
