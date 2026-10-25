<script lang="ts">
	import { enhance } from '$app/forms';
	import BudgetBar from '#lib/components/BudgetBar.svelte';
	import { suggestedLimit } from '#lib/budget.ts';
	import { formatDayMonth, formatMonth } from '#lib/dates.ts';
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
			<a class="step" href="?maand={data.previous}">
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5" /></svg>
				Vorige
			</a>
			{#if !data.isCurrent}<a class="step" href="/budget">Deze maand</a>{/if}
			<a class="step" href="?maand={data.next}">
				Volgende
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5L13 10l-5.5 5.5" /></svg>
			</a>
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

	<a class="fixed card" href="/vaste-lasten">
		<span>
			<strong>Vaste lasten</strong>
			<span class="muted">
				{#if data.fixed.count > 0}
					{data.fixed.count} lopend{#if data.fixed.proposals > 0}, {data.fixed.proposals}
						{data.fixed.proposals === 1 ? 'voorstel' : 'voorstellen'}{/if}
				{:else if data.fixed.proposals > 0}
					{data.fixed.proposals}
					{data.fixed.proposals === 1 ? 'voorstel' : 'voorstellen'} om te bevestigen
				{:else}
					Huur, energie en abonnementen als verwachte posten
				{/if}
			</span>
		</span>
		<span class="num">
			{#if data.fixed.count > 0}{formatCents(data.fixed.perMonthCents, { whole: true })}
				<span class="muted">per maand</span>{/if}
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5L13 10l-5.5 5.5" /></svg>
		</span>
	</a>

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
						{:else if line.plannedCents > 0}
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
							<label class="money">
								<span class="visually-hidden">Limiet {line.name}</span>
								<span class="prefix" aria-hidden="true">€</span>
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
						{#each line.reserves as r (r.recurringId)}
							<p class="reserve muted">
								{r.counterparty}: <span class="num">{formatCents(r.reservedCents)}</span> van
								<span class="num">{formatCents(r.expectedCents)}</span> opzij{#if r.nextDate},
									afschrijving rond {formatDayMonth(r.nextDate)}{/if}
							</p>
						{/each}
						{#if line.plannedCents > line.limitCents}
							<form
								method="POST"
								action="?/limit"
								class="too-low"
								use:enhance={() =>
									async ({ update }) =>
										update({ reset: false })}
							>
								<p>
									Gepland is <span class="num">{formatCents(line.plannedCents)}</span>, meer dan de
									limiet. Daardoor is er geen ruimte voor andere uitgaven.
								</p>
								<input type="hidden" name="month" value={o.month} />
								<input type="hidden" name="categoryId" value={line.categoryId} />
								<input
									type="hidden"
									name="limit"
									value={centsToInput(suggestedLimit(line.plannedCents))}
								/>
								<button class="text-button"
									>Limiet op {formatCents(suggestedLimit(line.plannedCents), {
										whole: true
									})}</button
								>
							</form>
						{/if}
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
	}

	.months {
		gap: 8px;
		flex-wrap: wrap;
	}

	.step {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 40px;
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

	.step:first-child {
		padding-left: 8px;
	}

	.step:last-child {
		padding-right: 8px;
	}

	.money {
		position: relative;
	}

	.prefix {
		position: absolute;
		left: 12px;
		top: 50%;
		translate: 0 -50%;
		color: var(--muted);
		pointer-events: none;
	}

	form input[name='limit'] {
		padding-left: 28px;
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

	.fixed {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		color: inherit;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	.fixed:active {
		transform: scale(0.99);
	}

	.fixed > span:first-child {
		display: grid;
		min-width: 0;
	}

	.fixed .num {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
		font-weight: 600;
	}

	.fixed svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.reserve {
		font-size: 0.88rem;
	}

	.too-low {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		padding: 10px 12px;
		border-radius: var(--radius-sm);
		background: color-mix(in oklch, var(--warn) 18%, transparent);
		font-size: 0.92rem;
	}

	.text-button {
		min-height: var(--tap);
		padding: 0 4px;
		border: 0;
		background: none;
		color: var(--accent-strong);
		font-weight: 600;
		cursor: pointer;
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
