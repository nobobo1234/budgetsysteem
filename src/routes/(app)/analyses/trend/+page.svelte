<script lang="ts">
	import * as icons from '#lib/icons.ts';
	import AnalysesTabs from '#lib/components/AnalysesTabs.svelte';
	import Bars from '#lib/components/Bars.svelte';
	import Chart from '#lib/components/Chart.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import { percent } from '#lib/analyses.ts';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatMonth, formatShortMonth } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';

	let { data } = $props();
	const t = $derived(data.trend);
	const whole = (cents: number) => formatCents(cents, { whole: true });
	const ticks = $derived(t.months.map(formatShortMonth));
	const names = $derived(t.months.map(formatMonth));
	const empty = $derived(t.totals.every((m) => m.spentCents === 0));

	// De categorie in de grote grafiek; standaard die met de meeste uitgaven
	const keyOf = (id: string | null) => id ?? 'geen';
	let picked = $state<string | null>(null);
	const selected = $derived(
		t.categories.find((c) => keyOf(c.categoryId) === picked) ?? t.categories[0] ?? null
	);
	const options = $derived<SelectOption[]>(
		t.categories.map((c) => ({
			value: keyOf(c.categoryId),
			label: c.name,
			group: c.group ?? 'Zonder categorie',
			dot: groupColor(c.group)
		}))
	);
	const color = (group: string | null) => groupColor(group) ?? 'var(--muted)';
</script>

<svelte:head>
	<title>Trend · Analyses · Budget</title>
</svelte:head>

<div class="page">
	<div class="head">
		<h1>Analyses</h1>
		<AnalysesTabs current="trend" />
	</div>

	{#if empty}
		<EmptyState
			icon={icons.analyses}
			text="Nog geen uitgaven in de laatste twaalf maanden. Met je historie erin zie je hier hoe je uitgaven lopen."
		>
			<a class="button" href="/import">Historie importeren</a>
		</EmptyState>
	{:else}
		<section class="card" aria-labelledby="total-title">
			<h2 id="total-title">Uitgaven per maand</h2>
			<p class="tell">
				Gemiddeld {whole(t.averageCents)} per maand, waarvan {percent(t.fixedShare)} vaste lasten.
			</p>
			<Chart
				label="Uitgaven per maand over twaalf maanden, met het deel vaste lasten"
				{ticks}
				{names}
				series={[
					{
						label: 'Totaal',
						values: t.totals.map((m) => m.spentCents),
						color: 'color-mix(in oklch, var(--accent) 40%, var(--surface-2))'
					},
					{
						label: 'Vaste lasten',
						values: t.totals.map((m) => m.fixedCents),
						color: groupColor(data.fixedGroup) ?? 'var(--accent)'
					}
				]}
			/>
		</section>

		{#if selected}
			<section class="card" aria-labelledby="category-title">
				<div class="section-head">
					<h2 id="category-title">Per categorie</h2>
					<Select
						label="Categorie"
						variant="chip"
						{options}
						value={keyOf(selected.categoryId)}
						onchange={(v) => (picked = v)}
					/>
				</div>
				<p class="tell">
					{selected.name}: gemiddeld {whole(selected.averageCents)} per maand, deze maand tot nu
					{whole(selected.values.at(-1) ?? 0)}.
				</p>
				<Chart
					label="{selected.name} per maand over twaalf maanden"
					{ticks}
					{names}
					series={[
						{ label: selected.name, values: selected.values, color: color(selected.group) },
						{
							label: 'Gemiddeld',
							values: selected.values.map(() => selected.averageCents),
							color: 'var(--muted)',
							kind: 'line',
							dashed: true
						}
					]}
				/>
			</section>

			<section class="card" aria-labelledby="all-title">
				<h2 id="all-title">Alle categorieën</h2>
				<ul class="rows">
					{#each t.categories as c (keyOf(c.categoryId))}
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
								>{whole(c.averageCents)} <span class="muted">per maand</span></span
							>
							<div class="spark">
								<Bars
									label="{c.name} per maand: {c.values
										.map((v, i) => `${names[i]} ${whole(v)}`)
										.join(', ')}"
									height={32}
									color={color(c.group)}
									bars={c.values.map((v, i) => ({
										key: t.months[i]!,
										cents: v,
										title: `${names[i]}: ${whole(v)}`
									}))}
								/>
							</div>
						</li>
					{/each}
				</ul>
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
	}

	.head {
		display: grid;
		gap: 12px;
	}

	section.card {
		display: grid;
		gap: 14px;
		min-width: 0;
	}

	section h2 {
		font-size: 1.3rem;
	}

	.section-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px 12px;
	}

	.rows {
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

	.spark {
		grid-column: 1 / -1;
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
</style>
