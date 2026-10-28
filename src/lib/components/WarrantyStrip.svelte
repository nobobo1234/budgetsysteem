<script lang="ts">
	import { formatShortDate } from '#lib/dates.ts';
	import { strip, type WarrantyDates } from '#lib/warranty.ts';

	// Garantiestrook (spec: Schermen, Garantie): van aankoop tot het einde van de geschatte
	// levensduur, met streepjes voor het einde van het eerste jaar en de fabrieksgarantie en een
	// streep voor vandaag. Wat al voorbij is, is gevuld. De strook is decoratief; dezelfde datums
	// staan eronder in tekst voor schermlezers, en de zin bij het product zegt het in woorden.

	let { w, today, large = false }: { w: WarrantyDates; today: string; large?: boolean } = $props();

	const s = $derived(strip(w, today));
	const now = $derived(s.marks.find((m) => m.key === 'vandaag')!);
	const ends = $derived(s.marks.filter((m) => m.key !== 'vandaag'));
	const fmt = (iso: string) => `${formatShortDate(iso)} ${iso.slice(0, 4)}`;
</script>

<div class={['strip', large && 'large']}>
	<div class="track" aria-hidden="true">
		<span class="fill" style:--x={now.at}></span>
		{#each ends as m, i (m.key)}
			<span
				class={['tick', m.key, m.date <= today && 'past']}
				style:--x={m.at}
				style:--i={i}
				title="{m.label}: {fmt(m.date)}"
			></span>
		{/each}
		<span class="today" style:--x={now.at}></span>
	</div>
	<div class="axis" aria-hidden="true">
		<span class="num">{w.purchaseDate.slice(0, 4)}</span>
		<span class="num">± {s.end.slice(0, 4)}</span>
	</div>
	{#if large}
		<ul class="legend" aria-hidden="true">
			{#each ends as m (m.key)}
				<li><span class={['key', m.key]}></span>{m.label}: {fmt(m.date)}</li>
			{/each}
		</ul>
	{/if}
	<p class="visually-hidden">
		Gekocht op {fmt(w.purchaseDate)}{w.deliveryDate !== w.purchaseDate
			? `, afgeleverd op ${fmt(w.deliveryDate)}`
			: ''}. {ends.map((m) => `${m.label}: ${fmt(m.date)}.`).join(' ')} Geschatte levensduur tot ongeveer
		{s.end.slice(0, 4)}.
	</p>
</div>

<style>
	.strip {
		display: grid;
		gap: 4px;
		container-type: inline-size;
	}

	.track {
		position: relative;
		height: 8px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--text) 10%, transparent);
		overflow: hidden;
	}

	.large .track {
		height: 14px;
	}

	/* Wat al voorbij is: vult van links tot vandaag */
	.fill {
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: color-mix(in oklch, oklch(0.6 0.14 45) 45%, transparent);
		transform-origin: left center;
		transform: scaleX(var(--x));
		animation: fill-in 600ms var(--ease-out) both;
	}

	.tick {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 3px;
		margin-left: -1.5px;
		border-radius: 2px;
		background: oklch(0.5 0.13 45);
		transform: translateX(calc(var(--x) * 100cqw));
		animation: tick-in 360ms var(--ease-spring) both;
		animation-delay: calc(200ms + var(--i) * 60ms);
	}

	.tick.fabriek {
		background: oklch(0.52 0.12 250);
	}

	.tick.past {
		opacity: 0.55;
	}

	.today {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 2px;
		margin-left: -1px;
		background: var(--text);
		transform: translateX(calc(var(--x) * 100cqw));
	}

	.axis {
		display: flex;
		justify-content: space-between;
		color: var(--muted);
		font-size: 0.78rem;
	}

	.legend {
		list-style: none;
		margin: 4px 0 0;
		padding: 0;
		display: grid;
		gap: 2px;
		font-size: 0.88rem;
		color: var(--muted);
	}

	.legend li {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.key {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		background: oklch(0.5 0.13 45);
	}

	.key.fabriek {
		background: oklch(0.52 0.12 250);
	}

	@media (prefers-color-scheme: dark) {
		.tick,
		.key {
			background: oklch(0.78 0.12 45);
		}

		.tick.fabriek,
		.key.fabriek {
			background: oklch(0.76 0.1 250);
		}
	}

	@keyframes fill-in {
		from {
			transform: scaleX(0);
		}
	}

	@keyframes tick-in {
		from {
			opacity: 0;
			transform: translateX(calc(var(--x) * 100cqw)) scaleY(0.2);
		}
	}
</style>
