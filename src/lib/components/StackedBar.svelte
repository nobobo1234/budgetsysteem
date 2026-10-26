<script lang="ts" module>
	export interface Segment {
		key: string;
		label: string;
		cents: number;
		/** CSS-kleur; standaard het accent */
		color?: string;
		/** Gearceerd: gepland of nog niet zeker */
		hatched?: boolean;
	}
</script>

<script lang="ts">
	import { formatCents } from '#lib/money.ts';

	// Gestapelde balk (spec: Componenten): delen van één geheel naast elkaar, met een legenda
	// die hetzelfde in woorden en bedragen zegt. De balk zelf is daarom decoratief.
	let {
		segments,
		total,
		label,
		legend = true
	}: {
		segments: Segment[];
		/** Het geheel; standaard de som. Is het meer, dan blijft de rest leeg. */
		total?: number;
		/** Toegankelijke naam van de legenda */
		label: string;
		/** Zonder legenda zegt een lijst ernaast hetzelfde in woorden (zoals op Boodschappen) */
		legend?: boolean;
	} = $props();

	const sum = $derived(segments.reduce((s, x) => s + Math.max(0, x.cents), 0));
	const whole = $derived(Math.max(total ?? sum, sum, 1));
	const placed = $derived.by(() => {
		let start = 0;
		return segments.map((s) => {
			const len = Math.max(0, s.cents) / whole;
			const out = { ...s, start, len };
			start += len;
			return out;
		});
	});
</script>

<div class="stacked">
	<div class="track" aria-hidden="true">
		{#each placed as s (s.key)}
			<span
				class={['seg', s.hatched && 'hatched']}
				style:--start={s.start}
				style:--len={s.len}
				style:--c={s.color ?? 'var(--accent)'}
			></span>
		{/each}
	</div>
	{#if legend}<ul class="legend num" aria-label={label}>
			{#each segments as s (s.key)}
				<li>
					<span
						class={['swatch', s.hatched && 'hatched']}
						style:--c={s.color ?? 'var(--accent)'}
						aria-hidden="true"
					></span>
					<span class="what">{s.label}</span>
					<span class="amount">{formatCents(s.cents, { whole: Math.abs(s.cents) >= 10_000 })}</span>
				</li>
			{/each}
		</ul>{/if}
</div>

<style>
	.stacked {
		display: grid;
		gap: 10px;
	}

	.track {
		position: relative;
		height: 14px;
		border-radius: 999px;
		background: var(--surface-2);
		overflow: hidden;
	}

	/* Alleen transform: elk segment is de hele balk, verschoven en geschaald (zoals BudgetBar) */
	.seg {
		position: absolute;
		inset: 0;
		background: var(--c);
		transform-origin: left center;
		transform: translateX(calc(var(--start) * 100%)) scaleX(var(--len));
		transition: transform 700ms var(--ease-spring);
		/* Een haarlijn tussen de delen, in de kleur van de achtergrond */
		box-shadow: inset -2px 0 0 var(--surface);
	}

	@starting-style {
		.seg {
			transform: translateX(0) scaleX(0);
		}
	}

	.hatched {
		background: repeating-linear-gradient(
			-45deg,
			var(--c) 0 3px,
			color-mix(in oklch, var(--c) 35%, transparent) 3px 6px
		);
	}

	.legend {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 6px 18px;
		font-size: 0.9rem;
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		background: var(--c);
	}

	.what {
		color: var(--muted);
	}

	.amount {
		font-weight: 600;
	}
</style>
