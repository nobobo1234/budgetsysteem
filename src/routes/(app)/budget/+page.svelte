<script lang="ts">
	import { enhance } from '$app/forms';
	import BudgetBar from '#lib/components/BudgetBar.svelte';
	import { formatMonth } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';

	let { data, form } = $props();
	const o = $derived(data.overview);
	const groups = $derived(Map.groupBy(o.lines, (l) => l.group));
</script>

<svelte:head>
	<title>Budget · Budget</title>
</svelte:head>

<div class="page">
	<div class="head">
		<h1>Budget {formatMonth(o.month)}</h1>
		<nav class="months" aria-label="Maand">
			<a href="?maand={data.previous}">Vorige</a>
			{#if !data.isCurrent}<a href="/budget">Deze maand</a>{/if}
			<a href="?maand={data.next}">Volgende</a>
		</nav>
	</div>

	<div class="totals card">
		<div>
			<span class="muted">Limieten</span>
			<strong class="num">{formatCents(o.totalLimitCents, { whole: true })}</strong>
		</div>
		<div>
			<span class="muted">Uitgegeven</span>
			<strong class="num">{formatCents(o.totalSpentCents, { whole: true })}</strong>
		</div>
		<div>
			<span class="muted">Nog vrij</span>
			<strong class="num" class:negative={o.freeCents < 0}
				>{formatCents(o.freeCents, { whole: true })}</strong
			>
		</div>
	</div>

	{#if o.uncategorizedCents > 0}
		<p class="muted">
			<a href="/transacties?maand={o.month}&categorie=geen"
				>{formatCents(o.uncategorizedCents)} zonder categorie</a
			>
			telt mee als uitgave.
		</p>
	{/if}

	<p class="muted">
		Een nieuwe maand neemt de limieten van de vorige over. Leeg laten is geen limiet.
	</p>

	{#each groups as [group, lines] (group)}
		<section>
			<h2>{group}</h2>
			<ul>
				{#each lines as line (line.categoryId)}
					<li>
						{#if line.limitCents > 0}
							<BudgetBar {...line} />
						{:else}
							<div class="nolimit">
								<span>{line.name}</span>
								<span class="num muted"
									>{formatCents(line.spentCents, { whole: true })} uitgegeven</span
								>
							</div>
						{/if}
						<form
							method="POST"
							action="?/limit"
							use:enhance={() =>
								async ({ update }) =>
									update({ reset: false })}
						>
							<input type="hidden" name="month" value={o.month} />
							<input type="hidden" name="categoryId" value={line.categoryId} />
							<label>
								<span class="visually-hidden">Limiet {line.name}</span>
								<input
									name="limit"
									inputmode="decimal"
									class="num"
									placeholder="Limiet"
									value={line.limitCents ? centsToInput(line.limitCents) : ''}
								/>
							</label>
							<button class="button secondary">Opslaan</button>
						</form>
						{#if form?.categoryId === line.categoryId && form?.message}
							<p class="error-text" role="alert">{form.message}</p>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/each}

	<a href="/categorieen">Categorieën en regels beheren</a>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 44rem;
	}

	.head {
		display: grid;
		gap: 8px;
	}

	.months {
		display: flex;
		gap: 16px;
	}

	.months a {
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
	}

	.totals {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}

	.totals div {
		display: grid;
	}

	.totals strong {
		font-size: 1.25rem;
	}

	.negative {
		color: var(--danger);
	}

	section {
		display: grid;
		gap: 12px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 20px;
	}

	li {
		display: grid;
		gap: 8px;
	}

	.nolimit {
		display: flex;
		justify-content: space-between;
		gap: 12px;
	}

	form {
		display: flex;
		gap: 8px;
	}

	form label {
		flex: 1;
	}

	form input[name='limit'] {
		width: 100%;
	}
</style>
