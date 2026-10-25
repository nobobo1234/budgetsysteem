<script lang="ts">
	import type { MonthStory } from '#lib/budget.ts';
	import { formatCents } from '#lib/money.ts';

	// De maand in één lijn onder "nog vrij" (spec: Startscherm): uitgegeven, de vaste lasten die
	// nog komen en wat vrij is, met een streepje voor vandaag. De zin eronder zegt hetzelfde in
	// woorden, dus de lijn zelf is decoratief voor schermlezers.
	let {
		story,
		spentCents,
		over = false
	}: { story: MonthStory; spentCents: number; over?: boolean } = $props();
</script>

<div class="month">
	<div class={['line', over && 'over']} aria-hidden="true">
		<span class="seg spent" style:--w={story.spentShare}></span>
		<span class="seg planned" style:--x={story.spentShare} style:--w={story.plannedShare}></span>
		<span class="today" style:--x={story.monthRatio}></span>
	</div>
	<ul class="legend num">
		<li><span class="swatch spent"></span>{formatCents(spentCents, { whole: true })} uitgegeven</li>
		{#if story.plannedLeftCents > 0}
			<li>
				<span class="swatch planned"></span>{formatCents(story.plannedLeftCents, { whole: true })} komt
				nog
			</li>
		{/if}
		<li><span class="tick"></span>vandaag</li>
	</ul>
</div>

<style>
	.month {
		display: grid;
		gap: 10px;
	}

	.line {
		position: relative;
		height: 10px;
		border-radius: 999px;
		background: var(--surface-2);
		overflow: hidden;
	}

	.seg {
		position: absolute;
		inset: 0 auto 0 calc(var(--x, 0) * 100%);
		width: 100%;
		transform-origin: left;
		transform: scaleX(var(--w));
		transition: transform 700ms var(--ease-spring);
	}

	@starting-style {
		.seg {
			transform: scaleX(0);
		}
	}

	.spent {
		background: var(--accent);
		border-radius: 999px;
	}

	.over .spent {
		background: var(--danger);
	}

	.planned {
		background: repeating-linear-gradient(
			-45deg,
			color-mix(in oklch, var(--warn) 55%, transparent) 0 3px,
			transparent 3px 6px
		);
	}

	.today {
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(var(--x) * 100%);
		width: 2px;
		margin-left: -1px;
		background: var(--text);
		opacity: 0.55;
	}

	.legend {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
		color: var(--muted);
		font-size: 0.86rem;
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
	}

	.swatch.spent {
		background: var(--accent);
	}

	.swatch.planned {
		background: color-mix(in oklch, var(--warn) 55%, transparent);
	}

	.tick {
		width: 2px;
		height: 12px;
		border-radius: 1px;
		background: var(--text);
		opacity: 0.55;
	}
</style>
