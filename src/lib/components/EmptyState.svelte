<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconDef } from '#lib/icons.ts';

	// Lege staat (spec: Staten, Componenten): een kleine lijnillustratie in de stijl van de
	// tab-iconen, één vertellende zin en altijd een volgende stap. De illustratie is het icoon
	// van het onderwerp, groter, in een getint vlak met een paar losse streepjes eromheen.
	let {
		icon,
		text,
		children,
		compact = false
	}: {
		icon: IconDef;
		/** Wat er zou staan, als zin */
		text: string;
		/** De volgende stap: een knop of Meer-link */
		children?: Snippet;
		/** Binnen een kaart of lijst: kleiner en links uitgelijnd */
		compact?: boolean;
	} = $props();
</script>

<div class={['empty', 'hue', compact && 'compact']} style:--h={icon.hue}>
	<svg class="art" viewBox="0 0 96 72" aria-hidden="true">
		<circle cx="48" cy="38" r="26" class="wash" />
		<path class="ground" d="M14 66h68" />
		<g class="spark">
			<path d="M16 22l4 2 M14 32h5 M80 18l-4 3 M82 30h-5 M74 10l-2 4" />
			<circle cx="22" cy="12" r="1.6" />
			<circle cx="86" cy="44" r="1.6" />
		</g>
		<g class="icon" transform="translate(30 20) scale(1.5)">
			<path d={icon.path} />
		</g>
	</svg>
	<p class="tell">{text}</p>
	{#if children}<div class="next">{@render children()}</div>{/if}
</div>

<style>
	.empty {
		display: grid;
		justify-items: center;
		gap: 12px;
		padding: 24px 8px;
		text-align: center;
	}

	.compact {
		grid-template-columns: auto minmax(0, 1fr);
		justify-items: start;
		align-items: center;
		column-gap: 14px;
		padding: 8px 0;
		text-align: left;
	}

	.compact .next {
		grid-column: 2;
	}

	.art {
		width: 120px;
		height: 90px;
		overflow: visible;
	}

	.compact .art {
		grid-row: span 2;
		width: 72px;
		height: 54px;
	}

	.wash {
		fill: var(--wash);
		transform-origin: 48px 38px;
		animation: wash-in 400ms var(--ease-spring) both;
	}

	.ground {
		stroke: var(--line);
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-dasharray: 2 5;
	}

	.spark {
		stroke: var(--ink);
		fill: var(--ink);
		stroke-width: 1.5;
		stroke-linecap: round;
		opacity: 0.45;
		animation: spark-in 500ms var(--ease-out) 120ms both;
	}

	.spark path {
		fill: none;
	}

	.icon path {
		fill: none;
		stroke: var(--ink);
		stroke-width: 1.3;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.tell {
		max-width: 30ch;
		color: var(--text);
	}

	.next {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px;
	}

	.compact .next {
		justify-content: start;
	}

	@keyframes wash-in {
		from {
			opacity: 0;
			transform: scale(0.6);
		}
	}

	@keyframes spark-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}
</style>
