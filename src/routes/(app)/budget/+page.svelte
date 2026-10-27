<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import BudgetBar from '#lib/components/BudgetBar.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Sheet from '#lib/components/Sheet.svelte';
	import StackedBar from '#lib/components/StackedBar.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { FIXED_GROUP, suggestedLimit } from '#lib/budget.ts';
	import { budgetSplit } from '#lib/budgetSplit.ts';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatDayMonth, formatMonth } from '#lib/dates.ts';
	import { GROCERIES, groceriesHref } from '#lib/groceries.ts';
	import { budget } from '#lib/icons.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';
	import { displayName } from '#lib/text.ts';

	let { data } = $props();
	const o = $derived(data.overview);
	// Met een limiet (of iets gepland) als balk; de rest ingeklapt onderaan
	const shown = $derived(o.lines.filter((l) => l.limitCents > 0 || l.plannedCents > 0));
	const hidden = $derived(o.lines.filter((l) => l.limitCents === 0 && l.plannedCents === 0));
	const hiddenSpent = $derived(hidden.reduce((s, l) => s + Math.max(0, l.spentCents), 0));
	const groups = $derived(Map.groupBy(shown, (l) => l.group));
	const split = $derived(budgetSplit(o.lines, o.freeCents, o.uncategorizedCents));
	let showHidden = $state(false);
	// Nog geen enkele limiet deze maand: de lege staat met het voorstel uit historie
	const noLimits = $derived(data.isCurrent && o.totalLimitCents === 0);

	// Tik op een balk: een sheet om de limiet aan te passen (spec: Budget)
	let editing = $state(false);
	let editId = $state<string | null>(null);
	const line = $derived(o.lines.find((l) => l.categoryId === editId) ?? null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let limitInput = $state<HTMLInputElement>();

	function edit(id: string) {
		editId = id;
		error = null;
		editing = true;
	}

	let toast = $state<{ text: string; error: boolean; key: number } | null>(null);
	const notify = (text: string, isError = false) =>
		(toast = { text, error: isError, key: Date.now() });

	const save: SubmitFunction = ({ formData }) => {
		busy = true;
		const name = line?.name ?? 'Limiet';
		const text = String(formData.get('limit') ?? '').trim();
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'success') {
				editing = false;
				notify(text === '' ? `${name} heeft geen limiet meer.` : `Limiet ${name} opgeslagen.`);
				await update({ reset: false });
				return;
			}
			const message = result.type === 'failure' ? result.data?.message : undefined;
			error = typeof message === 'string' ? message : 'Dat lukte niet. Probeer het opnieuw.';
		};
	};

	const quick: SubmitFunction =
		() =>
		async ({ result, update }) => {
			if (result.type === 'success') notify('Limiet aangepast.');
			else notify('Dat lukte niet. Probeer het opnieuw.', true);
			await update({ reset: false });
		};
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

	<div class="top">
		{#if noLimits}
			<div class="card">
				<EmptyState
					icon={budget}
					text={data.startLimits
						? 'Nog geen limieten. Je historie weet wat je per categorie uitgeeft; daaruit komt een eerste voorstel.'
						: 'Nog geen limieten. Met drie volle maanden historie stelt de app ze voor; tot dan stel je ze per categorie zelf in.'}
				>
					{#if data.startLimits}
						<a class="button" href="/budget/startlimieten">Voorstel uit historie</a>
					{:else}
						<a class="button secondary" href="/import">Historie importeren</a>
					{/if}
				</EmptyState>
			</div>
		{:else}
			<section class="split card" aria-labelledby="split-title">
				<div class="split-head">
					<h2 id="split-title">Deze maand</h2>
					<p class="muted num">
						{formatCents(o.totalLimitCents, { whole: true })} aan limieten
					</p>
				</div>
				<StackedBar
					label="Verdeling van je limieten"
					total={o.totalLimitCents}
					segments={[
						{
							key: 'vast',
							label: 'Vaste lasten',
							cents: split.fixedCents - split.fixedLeftCents,
							color: groupColor(FIXED_GROUP) ?? undefined
						},
						...(split.fixedLeftCents > 0
							? [
									{
										key: 'komt',
										label: 'Komt nog',
										cents: split.fixedLeftCents,
										color: groupColor(FIXED_GROUP) ?? undefined,
										hatched: true
									}
								]
							: []),
						{
							key: 'dagelijks',
							label: 'Dagelijks',
							cents: split.dailyCents,
							color: groupColor('Dagelijks') ?? undefined
						},
						{
							key: 'vrij',
							label: 'Vrij',
							cents: split.freeCents,
							color: 'color-mix(in oklch, var(--accent) 28%, var(--surface-2))'
						}
					]}
				/>
				{#if o.freeCents < 0}
					<p class="over">
						Je zit <span class="num">{formatCents(-o.freeCents, { whole: true })}</span> boven je limieten.
					</p>
				{/if}
			</section>
		{/if}

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
	</div>

	{#if o.uncategorizedCents > 0}
		<p class="muted">
			<a href="/transacties?maand={o.month}&categorie=geen"
				>{formatCents(o.uncategorizedCents)} zonder categorie</a
			>
			telt mee als uitgave.
		</p>
	{/if}

	{#if o.lateCorrections.length > 0}
		<div class="late card" role="note">
			<p>
				<strong>Na afloop verrekend.</strong>
				{o.lateCorrections.length === 1 ? 'Deze terugboeking kwam' : 'Deze terugboekingen kwamen'}
				later binnen en {o.lateCorrections.length === 1 ? 'telt' : 'tellen'} in deze maand, bij de uitgave
				die {o.lateCorrections.length === 1 ? 'hij verrekent' : 'ze verrekenen'}.
			</p>
			<ul>
				{#each o.lateCorrections as c (c.id)}
					<li>
						<a class="late-row" href="/transacties/{c.id}">
							<span class="who">{displayName(c.counterparty) || 'Zonder naam'}</span>
							<span class="muted">op {formatDayMonth(c.date)}</span>
							<span class={['num', c.amountCents > 0 && 'in']}
								>{formatCents(c.amountCents, { sign: true })}</span
							>
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<div class="groups">
		{#each groups as [group, lines] (group)}
			<section class="group card" aria-labelledby="group-{group}">
				<h2 id="group-{group}">{group}</h2>
				<ul>
					{#each lines as l (l.categoryId)}
						<li>
							<div class="line">
								<BudgetBar {...l} />
								<button type="button" class="edit" onclick={() => edit(l.categoryId)}>
									<span class="visually-hidden">Limiet {l.name} aanpassen</span>
								</button>
							</div>
							{#each l.reserves as r (r.recurringId)}
								<p class="reserve muted">
									{displayName(r.counterparty)}:
									<span class="num">{formatCents(r.reservedCents)}</span>
									van <span class="num">{formatCents(r.expectedCents)}</span> opzij{#if r.nextDate},
										afschrijving rond {formatDayMonth(r.nextDate)}{/if}
								</p>
							{/each}
							{#if l.name === GROCERIES}
								<a class="more-link groceries" href={groceriesHref(o.month)}>Per productgroep</a>
							{/if}
							{#if l.plannedCents > l.limitCents}
								<form method="POST" action="?/limit" class="too-low" use:enhance={quick}>
									<p>
										Gepland is <span class="num">{formatCents(l.plannedCents)}</span>, meer dan de
										limiet. Daardoor is er geen ruimte voor andere uitgaven.
									</p>
									<input type="hidden" name="month" value={o.month} />
									<input type="hidden" name="categoryId" value={l.categoryId} />
									<input
										type="hidden"
										name="limit"
										value={centsToInput(suggestedLimit(l.plannedCents))}
									/>
									<button class="text-button"
										>Limiet op {formatCents(suggestedLimit(l.plannedCents), {
											whole: true
										})}</button
									>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/each}

		{#if hidden.length > 0}
			<section class="group card nolimits" aria-label="Zonder limiet">
				<button
					type="button"
					class="toggle"
					aria-expanded={showHidden}
					aria-controls="nolimit-list"
					onclick={() => (showHidden = !showHidden)}
				>
					<span class="count num">{hidden.length}</span>
					<span class="label"
						>zonder limiet{#if hiddenSpent > 0}<span class="muted num">
								· {formatCents(hiddenSpent, { whole: true })} uitgegeven</span
							>{/if}</span
					>
					<svg class={['chevron', showHidden && 'open']} viewBox="0 0 20 20" aria-hidden="true"
						><path d="M5.5 7.5 10 12l4.5-4.5" /></svg
					>
				</button>
				{#if data.startLimits && !noLimits}
					<a class="more-link from-history" href="/budget/startlimieten">Voorstel uit historie</a>
				{/if}
				{#if showHidden}
					<ul id="nolimit-list" class="plain">
						{#each hidden as l (l.categoryId)}
							<li>
								<button type="button" class="nolimit" onclick={() => edit(l.categoryId)}>
									<span class="dot" style:--dot={groupColor(l.group)} aria-hidden="true"></span>
									<span class="name">{l.name}</span>
									<span class="num muted"
										>{l.spentCents > 0
											? `${formatCents(l.spentCents, { whole: true })} uitgegeven`
											: 'Limiet instellen'}</span
									>
									<span class="visually-hidden">: limiet {l.name} aanpassen</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	</div>

	<a class="more-link manage" href="/categorieen">Categorieën en regels</a>

	<Sheet bind:open={editing} title={line ? `Limiet ${line.name}` : 'Limiet'}>
		{#if line}
			<form method="POST" action="?/limit" class="limit-form" use:enhance={save}>
				<input type="hidden" name="month" value={o.month} />
				<input type="hidden" name="categoryId" value={line.categoryId} />
				<label class="field">
					<span>Per maand</span>
					<span class="money">
						<span class="prefix" aria-hidden="true">€</span>
						<input
							bind:this={limitInput}
							name="limit"
							inputmode="decimal"
							class="num"
							placeholder="Geen limiet"
							aria-label="Limiet {line.name}"
							value={line.limitCents ? centsToInput(line.limitCents) : ''}
							aria-invalid={error ? 'true' : undefined}
							aria-describedby="limit-help"
						/>
					</span>
				</label>
				<p id="limit-help" class="help muted">
					{#if line.spentCents > 0}
						<span
							><span class="num">{formatCents(line.spentCents, { whole: true })}</span> uitgegeven
							in
							{formatMonth(o.month)}.</span
						>
					{/if}
					Een nieuwe maand neemt deze limiet over. Leeg is geen limiet.
				</p>
				{#if line.plannedCents > 0}
					<p class="help muted">
						Gepland: <span class="num">{formatCents(line.plannedCents, { whole: true })}</span> aan vaste
						lasten en reserveringen.
					</p>
				{/if}
				{#if line.name === GROCERIES}
					<a class="more-link groceries" href={groceriesHref(o.month)}>Per productgroep</a>
				{/if}
				{#if error}<p class="error-text" role="alert">{error}</p>{/if}
				<div class="actions">
					<button class="button" disabled={busy}>Opslaan</button>
					{#if line.limitCents > 0}
						<button
							class="button secondary"
							disabled={busy}
							onclick={() => limitInput && (limitInput.value = '')}>Geen limiet</button
						>
					{/if}
				</div>
			</form>
		{/if}
	</Sheet>

	{#if toast}
		{#key toast.key}<Toast text={toast.text} error={toast.error} />{/key}
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 64rem;
	}

	.head {
		display: grid;
		gap: 8px;
	}

	.months {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
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

	.step svg,
	.fixed svg,
	.chevron {
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

	.top {
		display: grid;
		gap: 12px;
	}

	.split {
		display: grid;
		gap: 14px;
	}

	.split-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 4px 12px;
	}

	.split-head h2 {
		font-size: 1.25rem;
	}

	.split-head p {
		font-size: 0.92rem;
	}

	.over {
		color: var(--danger);
		font-weight: 550;
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

	.late {
		display: grid;
		gap: 8px;
		padding: 16px 20px;
	}

	.late ul {
		gap: 0;
	}

	.late-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		column-gap: 8px;
		min-height: var(--tap);
		color: inherit;
		text-decoration: none;
	}

	.late-row .who {
		font-weight: 550;
	}

	.late-row > span {
		white-space: nowrap;
	}

	.late-row .num {
		margin-left: auto;
	}

	.late .in {
		color: var(--accent-strong);
	}

	.groups {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
		align-items: start;
	}

	/* Desktop: twee kolommen met groepen naast elkaar */
	@container (min-width: 760px) {
		.top {
			grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
			align-items: stretch;
		}

		.groups {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.group {
		display: grid;
		gap: 14px;
	}

	.group h2 {
		font-size: 1.3rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 18px;
	}

	li {
		display: grid;
		gap: 6px;
	}

	/* De hele balk is een knop: een tik opent de sheet met de limiet */
	.line {
		position: relative;
	}

	.edit {
		position: absolute;
		inset: -6px -8px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.edit:active {
		transform: scale(0.98);
	}

	@media (hover: hover) {
		.edit:hover {
			background: color-mix(in oklch, var(--text) 4%, transparent);
		}
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

	.nolimits {
		gap: 0;
		padding-block: 6px;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: var(--tap);
		padding: 0;
		border: 0;
		background: none;
		color: var(--text);
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}

	.toggle .label {
		flex: 1;
	}

	.toggle .muted {
		font-weight: 400;
	}

	.count {
		display: inline-grid;
		place-items: center;
		min-width: 28px;
		height: 28px;
		padding: 0 8px;
		border-radius: 999px;
		background: var(--surface-2);
		font-size: 0.9rem;
	}

	.chevron {
		color: var(--muted);
		transition: transform 220ms var(--ease-spring);
	}

	.chevron.open {
		transform: rotate(180deg);
	}

	.plain {
		gap: 0;
		border-top: 1px solid var(--line);
		margin-top: 6px;
	}

	.plain li + li {
		border-top: 1px solid var(--line);
	}

	.nolimit {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 48px;
		padding: 0;
		border: 0;
		background: none;
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}

	.nolimit .name {
		flex: 1;
		min-width: 0;
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--dot);
	}

	.from-history {
		justify-self: start;
		margin: 2px 0 6px -12px;
	}

	.manage,
	.groceries {
		justify-self: start;
		margin-left: -12px;
	}

	.limit-form {
		display: grid;
		gap: 12px;
	}

	.field {
		display: grid;
		gap: 6px;
		font-weight: 550;
	}

	.money {
		position: relative;
		display: grid;
	}

	.prefix {
		position: absolute;
		left: 14px;
		top: 50%;
		translate: 0 -50%;
		color: var(--muted);
		font-size: 1.3rem;
		pointer-events: none;
	}

	.money input {
		min-height: 56px;
		padding-left: 36px;
		font-size: 1.5rem;
		font-weight: 600;
	}

	.help {
		font-size: 0.92rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
