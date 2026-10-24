<script lang="ts">
	import type { Pace } from '#lib/budget.ts';
	import { formatCents } from '#lib/money.ts';

	let {
		name,
		spentCents,
		limitCents,
		spentRatio,
		monthRatio,
		pace
	}: {
		name: string;
		spentCents: number;
		limitCents: number;
		spentRatio: number;
		monthRatio: number;
		pace: Pace;
	} = $props();

	const fill = $derived(Math.max(0, Math.min(1, Number.isFinite(spentRatio) ? spentRatio : 1)));
	const paceText: Record<Pace, string> = {
		rustig: 'rustig',
		op_schema: 'op schema',
		snel: 'gaat snel',
		over: 'over de limiet'
	};
</script>

<div class="row" data-pace={pace}>
	<div class="top">
		<span class="name">{name}</span>
		<span class="num amounts">
			{formatCents(spentCents, { whole: true })}
			<span class="muted">van {formatCents(limitCents, { whole: true })}</span>
		</span>
	</div>
	<div
		class="track"
		role="meter"
		aria-label="{name}: {paceText[pace]}"
		aria-valuemin={0}
		aria-valuemax={limitCents}
		aria-valuenow={Math.max(0, spentCents)}
		style:--fill={fill}
	>
		<div class="bar"></div>
		<div class="marker" style:--at={monthRatio} title="Deel van de maand dat voorbij is"></div>
	</div>
</div>

<style>
	.row {
		display: grid;
		gap: 6px;
	}

	.top {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		align-items: baseline;
	}

	.name {
		font-weight: 550;
	}

	.amounts {
		white-space: nowrap;
	}

	.track {
		position: relative;
		height: 10px;
		border-radius: 999px;
		background: var(--surface-2);
		overflow: hidden;
	}

	/* Alleen transform en opacity animeren */
	.bar {
		position: absolute;
		inset: 0;
		transform-origin: left center;
		transform: scaleX(var(--fill));
		border-radius: inherit;
		background: var(--accent);
		transition: transform 700ms var(--ease-spring);
	}

	@starting-style {
		.bar {
			transform: scaleX(0);
		}
	}

	/* Nadert de limiet: de kleur verloopt geleidelijk naar oranje */
	[data-pace='op_schema'] .bar {
		background: color-mix(
			in oklch,
			var(--accent),
			var(--warn) clamp(0%, calc((var(--fill) - 0.6) * 150%), 100%)
		);
	}

	[data-pace='snel'] .bar {
		background: var(--warn);
	}

	[data-pace='over'] .bar {
		background: var(--danger);
	}

	.marker {
		position: absolute;
		top: -2px;
		bottom: -2px;
		left: 0;
		width: 2px;
		background: var(--text);
		opacity: 0.35;
		transform: translateX(calc(var(--at) * (100cqw - 2px)));
	}

	.track {
		container-type: inline-size;
	}
</style>
