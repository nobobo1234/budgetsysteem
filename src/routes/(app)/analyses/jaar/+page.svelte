<script lang="ts">
	import * as icons from '#lib/icons.ts';
	import { navigating } from '$app/state';
	import AnalysesTabs from '#lib/components/AnalysesTabs.svelte';
	import Chart from '#lib/components/Chart.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import HeroAmount from '#lib/components/HeroAmount.svelte';
	import { percent, ratio } from '#lib/analyses.ts';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatMonth, formatShortMonth } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';
	import { initials } from '#lib/text.ts';

	let { data } = $props();
	const y = $derived(data.year);
	const busy = $derived(navigating.to?.url.pathname === '/analyses/jaar');
	const whole = (cents: number) => formatCents(cents, { whole: true });
	const lastMonth = $derived(formatMonth(y.months.at(-1)!).split(' ')[0]);
	const topMax = $derived(Math.max(1, ...y.top.map((t) => t.cents)));
	const catMax = $derived(Math.max(1, ...y.categories.map((c) => c.cents)));

	// Tegenover dezelfde maanden een jaar eerder
	const compared = $derived.by(() => {
		if (y.previousCents === null) return null;
		const diff = y.spentCents - y.previousCents;
		const period =
			y.months.length === 12 ? String(y.year - 1) : `januari tot en met ${lastMonth} ${y.year - 1}`;
		if (diff === 0) return `Precies evenveel als in ${period}.`;
		return `${whole(Math.abs(diff))} ${diff < 0 ? 'minder' : 'meer'} dan in ${period}.`;
	});
</script>

<svelte:head>
	<title>Jaar · Analyses · Budget</title>
</svelte:head>

<div class={['page', busy && 'busy']}>
	<div class="head">
		<h1>Analyses</h1>
		<AnalysesTabs current="jaar" />
		<nav class="years" aria-label="Jaar">
			{#if y.hasEarlier}
				<a class="step" href="?jaar={y.year - 1}">
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5" /></svg>
					{y.year - 1}
				</a>
			{/if}
			<span class="current num">{y.year}</span>
			{#if y.hasLater}
				<a class="step" href="?jaar={y.year + 1}">
					{y.year + 1}
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5L13 10l-5.5 5.5" /></svg>
				</a>
			{/if}
		</nav>
	</div>

	{#if y.spentCents === 0}
		<EmptyState
			icon={icons.analyses}
			text="Nog geen uitgaven in {y.year}. Met je historie erin zie je hier wat het jaar kostte."
		>
			<a class="button" href="/import">Historie importeren</a>
		</EmptyState>
	{:else}
		<div class="hero card">
			<HeroAmount cents={y.spentCents} label="Uitgegeven in {y.year}" />
			<p class="tell">
				Gemiddeld {whole(y.averageCents)} per maand, waarvan {percent(
					ratio(y.fixedCents, y.spentCents)
				)}
				vaste lasten.{#if compared}
					{compared}{/if}
			</p>
			<Chart
				label="Uitgaven per maand in {y.year}, met het deel vaste lasten"
				ticks={y.months.map(formatShortMonth)}
				names={y.months.map(formatMonth)}
				series={[
					{
						label: 'Totaal',
						values: y.totals.map((m) => m.spentCents),
						color: 'color-mix(in oklch, var(--accent) 40%, var(--surface-2))'
					},
					{
						label: 'Vaste lasten',
						values: y.totals.map((m) => m.fixedCents),
						color: groupColor(data.fixedGroup) ?? 'var(--accent)'
					}
				]}
			/>
		</div>

		<section class="card" aria-labelledby="categories-title">
			<h2 id="categories-title">Per categorie</h2>
			<ul class="rows">
				{#each y.categories as c (c.categoryId ?? 'geen')}
					<li>
						<span class="name">
							<span
								class={['dot', !c.group && 'open']}
								style:--dot={groupColor(c.group)}
								aria-hidden="true"
							></span>
							{c.name}
						</span>
						<span class="num amount"
							>{whole(c.cents)} <span class="muted">{percent(c.share)}</span></span
						>
						<span class="meter" aria-hidden="true">
							<span
								class="fill"
								style:--c={groupColor(c.group) ?? 'var(--muted)'}
								style:--len={c.cents / catMax}
							></span>
						</span>
					</li>
				{/each}
			</ul>
		</section>

		{#if y.top.length > 0}
			<section class="card" aria-labelledby="top-title">
				<h2 id="top-title">Grootste uitgaven</h2>
				<ol class="top">
					{#each y.top as t (t.name)}
						<li>
							<a href="/transacties?q={encodeURIComponent(t.name)}">
								<span class="monogram sm" aria-hidden="true">{initials(t.name)}</span>
								<span class="who">
									<span class="name">{t.name}</span>
									<span class="muted"
										>{t.count === 1 ? '1 keer' : `${t.count} keer`} · {percent(t.share)}</span
									>
								</span>
								<span class="num amount">{formatCents(-t.cents)}</span>
								<span class="meter" aria-hidden="true">
									<span class="fill" style:--c="var(--accent)" style:--len={t.cents / topMax}
									></span>
								</span>
							</a>
						</li>
					{/each}
				</ol>
			</section>
		{/if}
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 56rem;
		transition: opacity 200ms var(--ease-out);
	}

	.busy {
		opacity: 0.55;
	}

	.head {
		display: grid;
		gap: 12px;
	}

	.years {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.current {
		font-weight: 600;
		padding: 0 6px;
	}

	.step {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: var(--tap);
		padding: 0 14px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text);
		font-weight: 550;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	.step:active {
		transform: scale(0.96);
	}

	.step svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	section.card,
	.hero {
		display: grid;
		gap: 14px;
		min-width: 0;
	}

	section h2 {
		font-size: 1.3rem;
	}

	.hero {
		gap: 16px;
	}

	.rows,
	.top {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 16px;
	}

	.rows li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 6px 12px;
	}

	.name {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-weight: 550;
	}

	.amount {
		font-weight: 600;
		white-space: nowrap;
	}

	.amount .muted {
		font-weight: 400;
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--dot, var(--muted));
	}

	.dot.open {
		background: none;
		box-shadow: inset 0 0 0 1.5px var(--muted);
	}

	.meter {
		grid-column: 1 / -1;
		position: relative;
		height: 8px;
		border-radius: 999px;
		overflow: hidden;
		background: var(--surface-2);
	}

	.fill {
		position: absolute;
		inset: 0;
		background: var(--c);
		transform-origin: left center;
		transform: scaleX(var(--len));
		transition: transform 700ms var(--ease-spring);
	}

	@starting-style {
		.fill {
			transform: scaleX(0);
		}
	}

	.top a {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 6px 12px;
		min-height: var(--tap);
		color: inherit;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	.top a:active {
		transform: scale(0.99);
	}

	.top .who {
		display: grid;
		min-width: 0;
	}

	.top .who .name {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.top .who .muted {
		font-size: 0.88rem;
	}

	.top .meter {
		grid-column: 2 / -1;
		height: 6px;
		background: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.fill {
			transition: none;
		}
	}
</style>
