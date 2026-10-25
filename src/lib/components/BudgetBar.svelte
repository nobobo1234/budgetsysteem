<script lang="ts">
	import type { Pace } from '#lib/budget.ts';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatCents } from '#lib/money.ts';

	let {
		name,
		spentCents,
		limitCents,
		monthRatio,
		pace,
		plannedCents = 0,
		plannedSpentCents = 0,
		otherCents = spentCents,
		group
	}: {
		name: string;
		/** Categoriegroep: de balk krijgt de tint van de groep (spec: Kleur met betekenis) */
		group?: string;
		spentCents: number;
		limitCents: number;
		monthRatio: number;
		pace: Pace;
		/** Gepland: reserveringen en verwachte of bevestigde vaste lasten */
		plannedCents?: number;
		/** Deel van gepland dat al bevestigd is (en als uitgave telt) */
		plannedSpentCents?: number;
		/** Overige uitgaven: daar meet het tempo */
		otherCents?: number;
	} = $props();

	const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 1));
	const ratio = (cents: number) => (limitCents > 0 ? cents / limitCents : cents > 0 ? 1 : 0);

	// Geplande posten staan als eigen segment vooraan, lichter tot ze bevestigd zijn; daarna het
	// vrije deel met tempo. Alles als deel van de limiet.
	const confirmed = $derived(clamp(ratio(plannedSpentCents)));
	const planned = $derived(Math.max(confirmed, clamp(ratio(plannedCents))));
	const other = $derived(Math.min(clamp(ratio(otherCents)), 1 - planned));
	const expectedCents = $derived(Math.max(0, plannedCents - plannedSpentCents));
	// Het tempo loopt over het vrije deel: de streep staat daar waar de maand is
	const marker = $derived(planned + monthRatio * (1 - planned));

	const paceText: Record<Pace, string> = {
		rustig: 'rustig',
		op_schema: 'op schema',
		snel: 'gaat snel',
		over: 'over de limiet',
		gepland: 'alles gepland'
	};
</script>

<div class="row" data-pace={pace} style:--bar={group ? groupColor(group) : undefined}>
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
	>
		{#if planned > 0}
			<div class="seg planned" style:--start={0} style:--len={confirmed}></div>
			<div class="seg expected" style:--start={confirmed} style:--len={planned - confirmed}></div>
		{/if}
		<div class="seg bar" style:--start={planned} style:--len={other} style:--fill={other}></div>
		{#if pace !== 'gepland'}
			<div class="marker" style:--at={marker} title="Deel van de maand dat voorbij is"></div>
		{/if}
	</div>
	{#if plannedCents > 0}
		<p class="planned-text muted">
			<span class="num">{formatCents(plannedCents, { whole: true })}</span>
			gepland{#if expectedCents > 0},
				<span class="num">{formatCents(expectedCents, { whole: true })}</span> nog te bevestigen{/if}
		</p>
	{/if}
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
		container-type: inline-size;
	}

	/* Alleen transform en opacity animeren: elk segment is de hele balk, verschoven en geschaald */
	.seg {
		position: absolute;
		inset: 0;
		transform-origin: left center;
		transform: translateX(calc(var(--start) * 100%)) scaleX(var(--len));
		transition: transform 700ms var(--ease-spring);
	}

	@starting-style {
		.seg {
			transform: translateX(0) scaleX(0);
		}
	}

	/* Waar het kan, vult de balk pas als hij in beeld komt (scroll-driven, spec: Beweging) */
	@supports (animation-timeline: view()) {
		.seg {
			animation: fill-in linear both;
			animation-timeline: view();
			animation-range: entry 10% cover 30%;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.seg {
			animation: none !important;
		}
	}

	@keyframes fill-in {
		from {
			transform: translateX(0) scaleX(0);
		}
	}

	.row {
		--bar: var(--accent);
	}

	.planned {
		background: color-mix(in oklch, var(--bar) 45%, var(--surface-2));
	}

	/* Nog niet bevestigd: lichter, met een arcering zodat het ook zonder kleur te zien is */
	.expected {
		background: repeating-linear-gradient(
			-45deg,
			color-mix(in oklch, var(--bar) 30%, var(--surface-2)) 0 3px,
			color-mix(in oklch, var(--bar) 12%, var(--surface-2)) 3px 6px
		);
	}

	.bar {
		background: var(--bar);
	}

	/* Nadert de limiet: de kleur verloopt geleidelijk naar oranje */
	/* Mengen in oklab (rechte lijn) en pas vanaf 80%: in oklch loopt blauw naar oranje via
	   paars, en dat leest als een eigen kleur in plaats van als "bijna vol" */
	[data-pace='op_schema'] .bar {
		background: color-mix(
			in oklab,
			var(--bar),
			var(--warn) clamp(0%, calc((var(--fill) - 0.8) * 350%), 70%)
		);
	}

	[data-pace='snel'] .bar {
		background: var(--warn);
	}

	[data-pace='over'] .bar {
		background: var(--danger);
	}

	[data-pace='over'] .planned {
		background: color-mix(in oklch, var(--danger) 50%, var(--surface-2));
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

	.planned-text {
		font-size: 0.85rem;
	}
</style>
