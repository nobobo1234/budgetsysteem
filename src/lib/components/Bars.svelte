<script lang="ts" module>
	export interface Bar {
		key: string;
		cents: number;
		/** Onder de staaf; leeg laat de plek open */
		label?: string;
		/** Toegankelijke naam en tooltip, zoals "12 oktober: € 34,50" */
		title: string;
		/** Een staaf als link, bijvoorbeeld om op die dag te filteren */
		href?: string;
		active?: boolean;
		/** Opvallen: een prijsverhoging of de grootste dag */
		tone?: 'up' | 'quiet';
		/** Klein boven de staaf, zoals "+€ 3" */
		note?: string;
	}
</script>

<script lang="ts">
	// Klein staafdiagram (spec: Componenten): afschrijvingen van een vaste last of uitgaven per
	// dag. Alleen transform: elke staaf schaalt vanaf de onderkant. Met links is elke staaf een
	// filter; zonder links is het diagram decoratief en zegt de tekst ernaast hetzelfde.
	let {
		bars,
		label,
		height = 96,
		zoom = false,
		color
	}: {
		bars: Bar[];
		label: string;
		height?: number;
		/** Inzoomen op het verschil (een kwart hoogte is het laagste bedrag): voor bedragen die
		 * dicht bij elkaar liggen, zoals een vaste last met een prijsverhoging */
		zoom?: boolean;
		/** Kleur van de staven, zoals de tint van de categoriegroep */
		color?: string | null;
	} = $props();

	const max = $derived(Math.max(1, ...bars.map((b) => Math.abs(b.cents))));
	const min = $derived(Math.min(...bars.map((b) => Math.abs(b.cents))));
	const scaleOf = (cents: number) =>
		zoom && max > min
			? 0.25 + (0.75 * (Math.abs(cents) - min)) / (max - min)
			: Math.abs(cents) / max;
	const linked = $derived(bars.some((b) => b.href));
	// Een rij voor notities boven de staven, alleen als er een is; elke staaf krijgt hem dan
	const noted = $derived(bars.some((b) => b.note));
</script>

<div
	class={['bars', linked && 'linked', noted && 'noted']}
	style:--h="{height}px"
	style:--n={bars.length}
	style:--bar={color ?? undefined}
	role={linked ? 'group' : 'img'}
	aria-label={label}
>
	{#each bars as b, i (b.key)}
		{@const scale = scaleOf(b.cents)}
		<svelte:element
			this={b.href ? 'a' : 'span'}
			href={b.href}
			class={['col', b.active && 'active', b.tone]}
			aria-current={b.active ? 'true' : undefined}
			aria-label={linked ? b.title : undefined}
			title={b.title}
			data-sveltekit-noscroll={b.href ? '' : undefined}
			data-sveltekit-replacestate={b.href ? '' : undefined}
		>
			{#if noted}<span class="note num" aria-hidden="true">{b.note ?? ''}</span>{/if}
			<span class="track" aria-hidden="true">
				<span class="bar" style:--s={Math.max(scale, b.cents ? 0.03 : 0)} style:--i={i}></span>
			</span>
			<span class="label num" aria-hidden="true">{b.label ?? ''}</span>
		</svelte:element>
	{/each}
</div>

<style>
	.bars {
		display: grid;
		grid-template-columns: repeat(var(--n), minmax(0, 1fr));
		align-items: end;
		gap: 3px;
	}

	.col {
		display: grid;
		grid-template-rows: var(--h) auto;
		align-items: end;
		justify-items: center;
		gap: 4px;
		min-width: 0;
		color: inherit;
		text-decoration: none;
	}

	.noted .col {
		grid-template-rows: auto var(--h) auto;
	}

	.linked .col {
		border-radius: 6px;
		transition: transform 160ms var(--ease-spring);
	}

	.linked .col:active {
		transform: scale(0.94);
	}

	.track {
		position: relative;
		width: 100%;
		height: 100%;
		max-width: 28px;
	}

	.bar {
		position: absolute;
		inset: 0;
		border-radius: 4px 4px 2px 2px;
		background: color-mix(in oklch, var(--bar, var(--accent)) 55%, var(--surface-2));
		transform-origin: bottom;
		transform: scaleY(var(--s));
		transition: transform 600ms var(--ease-spring);
	}

	@starting-style {
		.bar {
			transform: scaleY(0);
		}
	}

	.up .bar {
		background: var(--warn);
	}

	.quiet .bar {
		background: var(--surface-2);
	}

	.active .bar,
	.linked .col:hover .bar {
		background: var(--bar, var(--accent));
	}

	/* Er is een keuze: de andere staven treden terug */
	.linked:has(.active) .col:not(.active) .bar {
		opacity: 0.45;
	}

	.note {
		min-height: 1.1em;
		font-size: 0.72rem;
		font-weight: 650;
		color: color-mix(in oklch, var(--warn) 65%, var(--text));
		white-space: nowrap;
	}

	.label {
		min-height: 1.2em;
		color: var(--muted);
		font-size: 0.72rem;
		white-space: nowrap;
	}

	.active .label {
		color: var(--text);
		font-weight: 650;
	}
</style>
