<script lang="ts">
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import { monthName, outcomeSentence } from '#lib/closing.ts';
	import { formatDayMonth } from '#lib/dates.ts';
	import { afsluiting } from '#lib/icons-extra.ts';

	// Afgesloten maanden (spec: Analyses → Maandafsluiting, Terugkijken): per maand de uitkomst,
	// elke afsluiting blijft te openen. Bovenaan de maand die nog klaarstaat, als die er is.

	let { data } = $props();
	const label = (month: string) => `${monthName(month)} ${month.slice(0, 4)}`;
</script>

<svelte:head>
	<title>Afgesloten maanden · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<BackLink parents={['/analyses', '/']} labels={{ '/analyses': 'Analyses' }} />
		<h1>Afgesloten maanden</h1>
	</div>

	{#if data.pending}
		<a class="card pending hue" style:--h={afsluiting.hue} href="/afsluiting/{data.pending}">
			<span class="icon-badge" aria-hidden="true">
				<svg viewBox="0 0 24 24"
					><path
						d={afsluiting.path}
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				>
			</span>
			<span class="text">
				<strong data-morph-to="/afsluiting/{data.pending}" data-morph-part="titel"
					>{label(data.pending)}</strong
				>
				<span class="muted">Klaar om af te sluiten</span>
			</span>
		</a>
	{/if}

	{#if data.months.length > 0}
		<ul class="months card" aria-label="Afgesloten maanden">
			{#each data.months as m (m.month)}
				<li>
					<a class="row" href="/afsluiting/{m.month}">
						<span class="what">
							<strong data-morph-to="/afsluiting/{m.month}" data-morph-part="titel"
								>{label(m.month)}</strong
							>
							<span class="tell">{outcomeSentence(m.outcome)}</span>
							<span class="muted">
								Afgesloten op {formatDayMonth(m.closedAt.slice(0, 10))}{#if m.open > 0}, met {m.open}
									open {m.open === 1 ? 'punt' : 'punten'}{/if}
							</span>
						</span>
						<span
							class={['meter', m.outcome.kind === 'tekort' && 'short']}
							aria-hidden="true"
							style:--len={m.totalLimitCents > 0
								? Math.min(1, m.totalSpentCents / m.totalLimitCents)
								: 0}
						></span>
						<svg class="chevron" viewBox="0 0 20 20" aria-hidden="true"
							><path d="M7.5 4.5L13 10l-5.5 5.5" /></svg
						>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<div class="card">
			<EmptyState
				icon={afsluiting}
				text="Nog geen maand afgesloten. Vanaf de eerste van de maand staat de vorige klaar op het overzicht."
			>
				<a class="button secondary" href="/">Naar het overzicht</a>
			</EmptyState>
		</div>
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 44rem;
	}

	.intro {
		display: grid;
		gap: 8px;
	}

	.pending {
		display: flex;
		align-items: center;
		gap: 14px;
		color: var(--text);
		text-decoration: none;
		transition: transform 220ms var(--ease-spring);
	}

	.pending:active {
		transform: scale(0.98);
	}

	.text {
		display: grid;
	}

	.months {
		display: grid;
		margin: 0;
		padding: 4px 20px;
		list-style: none;
	}

	.months li + li {
		border-top: 1px solid var(--line);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 14px;
		min-height: var(--tap);
		padding: 14px 0;
		color: var(--text);
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	.row:active {
		transform: scale(0.98);
	}

	.what {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
	}

	.what .tell {
		font-size: 1rem;
	}

	.what .muted {
		font-size: 0.88rem;
	}

	/* Uitgegeven als deel van de limieten, als klein lijntje; de zin ernaast zegt het in woorden */
	.meter {
		position: relative;
		flex: none;
		width: 56px;
		height: 6px;
		border-radius: 999px;
		background: var(--surface-2);
		overflow: hidden;
	}

	.meter::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: var(--accent);
		transform: scaleX(var(--len));
		transform-origin: left center;
	}

	.meter.short::after {
		background: var(--danger);
	}

	.chevron {
		flex: none;
		width: 18px;
		height: 18px;
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
