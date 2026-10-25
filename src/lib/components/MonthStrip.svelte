<script lang="ts">
	import { formatCents } from '#lib/money.ts';

	// Maandstrook (spec: Componenten): de dagen 1 tot het eind van de maand, met een stip per
	// afschrijving in de kleur van haar groep en een streep voor vandaag. Gevuld is al
	// afgeschreven, open komt nog. De zin erboven zegt hetzelfde in woorden; de strook zelf is
	// decoratief, de stippen hebben alleen een tooltip.
	interface Dot {
		key: string;
		day: number;
		cents: number;
		done: boolean;
		color: string | null;
		label: string;
	}

	let { dots, days, today }: { dots: Dot[]; days: number; today: number | null } = $props();

	// Meer afschrijvingen op één dag staan boven elkaar
	const placed = $derived.by(() => {
		const seen: Record<number, number> = {};
		return dots.map((d) => {
			const stack = seen[d.day] ?? 0;
			seen[d.day] = stack + 1;
			return { ...d, stack };
		});
	});
	const rows = $derived(Math.max(1, ...placed.map((d) => d.stack + 1)));
	const ticks = $derived([1, 8, 15, 22, days]);
	const at = (day: number) => (day - 0.5) / days;
</script>

<div class="strip" style:--rows={rows} aria-hidden="true">
	<div class="dots">
		{#each placed as d, i (d.key)}
			<span
				class={['dot', d.done ? 'done' : 'coming']}
				style:--x={at(d.day)}
				style:--y={d.stack}
				style:--c={d.color ?? 'var(--muted)'}
				style:--i={i}
				title="{d.label}, {formatCents(d.cents)}, {d.done ? 'afgeschreven' : 'komt nog'}"
			></span>
		{/each}
		{#if today !== null}
			<span class="today" style:--x={at(today)}></span>
		{/if}
	</div>
	<div class="axis">
		{#each ticks as t (t)}
			<span class="tick num" style:--x={at(t)}>{t}</span>
		{/each}
		{#if today !== null}<span class="now" style:--x={at(today)}>vandaag</span>{/if}
	</div>
</div>

<style>
	.strip {
		display: grid;
		gap: 6px;
		container-type: inline-size;
	}

	.dots {
		position: relative;
		height: calc(var(--rows) * 16px + 18px);
		border-radius: 999px;
		background: linear-gradient(var(--line), var(--line)) left bottom / 100% 2px no-repeat;
	}

	.dot {
		position: absolute;
		left: 0;
		bottom: 4px;
		width: 12px;
		height: 12px;
		margin-left: -6px;
		border-radius: 50%;
		transform: translate(calc(var(--x) * 100cqw), calc(var(--y) * -16px));
		animation: dot-in 360ms var(--ease-spring) both;
		animation-delay: calc(var(--i) * 30ms);
	}

	.done {
		background: var(--c);
	}

	.coming {
		background: var(--surface);
		box-shadow: inset 0 0 0 2px var(--c);
	}

	.today {
		position: absolute;
		left: 0;
		top: 0;
		bottom: -4px;
		width: 2px;
		margin-left: -1px;
		border-radius: 1px;
		background: var(--text);
		opacity: 0.5;
		transform: translateX(calc(var(--x) * 100cqw));
	}

	.axis {
		position: relative;
		height: 1.2em;
		color: var(--muted);
		font-size: 0.78rem;
	}

	.tick,
	.now {
		position: absolute;
		left: 0;
		top: 0;
		transform: translateX(calc(var(--x) * 100cqw - 50%));
		white-space: nowrap;
	}

	.now {
		top: 1.3em;
		color: var(--text);
		font-weight: 600;
	}

	.axis:has(.now) {
		height: 2.5em;
	}

	@keyframes dot-in {
		from {
			opacity: 0;
			transform: translate(calc(var(--x) * 100cqw), calc(var(--y) * -16px + 8px)) scale(0.4);
		}
	}
</style>
