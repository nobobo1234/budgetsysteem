<script lang="ts">
	import { enhance } from '$app/forms';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatDayMonth, formatShortDate } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';
	import { PER_INTERVAL, rhythmText } from '#lib/recurring.ts';

	let { data, form } = $props();
	const o = $derived(data.overview);
	const active = $derived([...o.active].sort((a, b) => b.perMonthCents - a.perMonthCents));
	const monthStart = $derived(`${data.today.slice(0, 7)}-01`);
	// Het voorstel dat net is bevestigd of weggehaald staat niet meer in de lijst
	let lastName = $state('');

	const categoryOptions = $derived<SelectOption[]>([
		{ value: '', label: 'Geen categorie', dot: null },
		...data.categories.map((c) => ({
			value: c.id,
			label: c.name,
			group: c.group,
			dot: groupColor(c.group)
		}))
	]);

	let busy = $state<string | null>(null);
</script>

<svelte:head>
	<title>Vaste lasten · Budget</title>
</svelte:head>

<div class="page">
	<div class="head">
		<h1>Vaste lasten</h1>
		<div class="totals card">
			<div>
				<span class="muted">Per maand</span>
				<strong class="num">{formatCents(o.totalPerMonthCents, { whole: true })}</strong>
			</div>
			<div>
				<span class="muted">Per jaar</span>
				<strong class="num">{formatCents(o.totalPerYearCents, { whole: true })}</strong>
			</div>
			<div>
				<span class="muted">Aantal</span>
				<strong class="num">{o.active.length}</strong>
			</div>
		</div>
	</div>

	{#if o.proposals.length > 0}
		<section class="proposals" aria-labelledby="proposals-title">
			<div class="section-head">
				<h2 id="proposals-title">Voorstellen</h2>
				<p class="muted">Gevonden in je historie. Er komt niets bij zonder dat je het bevestigt.</p>
			</div>
			{#each o.proposals as p (p.id)}
				<article class="card proposal" aria-labelledby="p-{p.id}">
					<h3 id="p-{p.id}">Is {p.counterparty} een vaste last?</h3>
					<p class="muted">
						{rhythmText(p.interval, p.expectedDay)} ·
						<span class="num">{formatCents(p.medianCents)}</span>
						{#if p.kind === 'wisselend'}
							(<span class="num">{formatCents(p.minCents)}</span> tot
							<span class="num">{formatCents(p.maxCents)}</span>, wisselend)
						{/if}
						{#if p.lastDate}· laatst {formatShortDate(p.lastDate)} {p.lastDate.slice(0, 4)}{/if}
					</p>
					<form
						method="POST"
						action="?/confirm"
						use:enhance={() => {
							busy = p.id;
							lastName = p.counterparty;
							return async ({ update }) => {
								await update();
								busy = null;
							};
						}}
					>
						<input type="hidden" name="id" value={p.id} />
						<div class="row">
							<label class="field">
								<span>Volgende afschrijving</span>
								<input type="date" name="nextDate" value={p.nextDate} min={monthStart} required />
							</label>
							<div class="field">
								<label for="cat-{p.id}">Categorie</label>
								<Select
									id="cat-{p.id}"
									name="categoryId"
									label="Categorie voor {p.counterparty}"
									value={p.categoryId ?? ''}
									options={categoryOptions}
								/>
							</div>
						</div>
						{#if p.interval !== 'maand'}
							<Switch
								name="spread"
								checked={p.spread}
								hint="Elke maand een deel opzij, zodat de afschrijfmaand geen piek geeft"
								>Uitsmeren</Switch
							>
						{/if}
						{#if form && 'message' in form && form.message && form.id === p.id}
							<p class="error-text" role="alert">{form.message}</p>
						{/if}
						<div class="actions">
							<button class="button" disabled={busy === p.id}>Ja, vaste last</button>
							<button
								class="button secondary"
								formaction="?/reject"
								formnovalidate
								disabled={busy === p.id}>Nee</button
							>
						</div>
					</form>
				</article>
			{/each}
		</section>
	{/if}

	<section class="list" aria-labelledby="active-title">
		<h2 id="active-title">Lopend</h2>
		{#if active.length === 0}
			<div class="empty card">
				{#if o.proposals.length > 0}
					<p>Nog geen vaste lasten. Bevestig hierboven welke voorstellen het zijn.</p>
				{:else}
					<p>
						Nog geen vaste lasten. Na een import van je bankhistorie stelt de app ze hier voor,
						zoals huur, energie en abonnementen.
					</p>
					<a class="button secondary" href="/import">Historie importeren</a>
				{/if}
			</div>
		{:else}
			<ul class="card items">
				{#each active as i (i.id)}
					<li>
						<a class="item" href="/vaste-lasten/{i.id}">
							<span class="main">
								<span class="who">{i.counterparty}</span>
								<span class="meta">
									<span
										class={['dot', !i.categoryName && 'none']}
										style:--dot={i.categoryGroup ? groupColor(i.categoryGroup) : null}
										aria-hidden="true"
									></span>
									<span class="cat">{i.categoryName ?? 'Geen categorie'}</span>
								</span>
								<span class="sub">{rhythmText(i.interval, i.expectedDay)}</span>
								{#if i.spread && i.nextDate}
									<span class="reserve">
										<span class="num">{formatCents(i.reservedCents)}</span> van
										<span class="num">{formatCents(i.medianCents)}</span> opzij, afschrijving rond
										{formatDayMonth(i.nextDate)}
									</span>
								{/if}
							</span>
							<span class="amount num">
								<span>{formatCents(i.perMonthCents)}</span>
								<span class="per">
									{#if i.interval === 'maand'}per maand{:else}{formatCents(i.medianCents)}
										{PER_INTERVAL[i.interval]}{/if}
								</span>
							</span>
						</a>
						{#if i.signal && i.signalToCents !== null}
							<form method="POST" action="?/dismissSignal" use:enhance class="signal">
								<input type="hidden" name="id" value={i.id} />
								<p>
									{#if i.signal === 'prijsverhoging'}
										<strong>Prijsverhoging:</strong>
										<span class="num">{formatCents(i.signalFromCents ?? 0)}</span> →
										<span class="num">{formatCents(i.signalToCents)}</span>. Het verwachte bedrag is
										aangepast.
									{:else}
										<strong>Uitschieter:</strong>
										<span class="num">{formatCents(i.signalToCents)}</span>, meer dan 120% van het
										hoogste bedrag tot nu toe (<span class="num"
											>{formatCents(i.signalFromCents ?? 0)}</span
										>).
									{/if}
								</p>
								<button class="text-button">Gezien</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
			<p class="muted">
				Een vaste last die niet elke maand komt, telt per maand voor een deel: een halfjaarlijkse
				voor een zesde.
			</p>
		{/if}
	</section>

	{#if o.stopped.length > 0}
		<details class="stopped">
			<summary>Gestopt <span class="num muted">{o.stopped.length}</span></summary>
			<ul>
				{#each o.stopped as s (s.id)}
					<li>
						<a href="/vaste-lasten/{s.id}">{s.counterparty}</a>
						<span class="muted">
							{#if s.stoppedAt}gestopt {formatShortDate(s.stoppedAt)} {s.stoppedAt.slice(0, 4)}{/if}
						</span>
					</li>
				{/each}
			</ul>
		</details>
	{/if}

	{#if form && 'confirmed' in form}
		{#key form}<Toast text="{lastName} staat bij je vaste lasten." />{/key}
	{:else if form && 'rejected' in form}
		{#key form}<Toast text="Voorstel voor {lastName} weggehaald." />{/key}
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 32px;
		max-width: 44rem;
	}

	.head,
	section,
	.section-head {
		display: grid;
		gap: 12px;
	}

	.section-head {
		gap: 4px;
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

	.proposal {
		display: grid;
		gap: 12px;
		padding: 20px;
	}

	form {
		display: grid;
		gap: 14px;
	}

	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 14px;
	}

	@container (min-width: 520px) {
		.row {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
		}
	}

	.field {
		display: grid;
		gap: 6px;
		align-content: start;
		min-width: 0;
	}

	.field > span,
	.field > label {
		font-weight: 550;
		font-size: 0.95rem;
	}

	.field input {
		width: 100%;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.empty {
		display: grid;
		gap: 12px;
		justify-items: start;
	}

	.items {
		list-style: none;
		margin: 0;
		padding: 0 16px;
		display: grid;
	}

	.items li + li {
		border-top: 1px solid var(--line);
	}

	.item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
		min-height: 64px;
		margin-inline: -10px;
		padding: 10px;
		border-radius: var(--radius-sm);
		color: inherit;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	@media (hover: hover) {
		.item:hover {
			background: var(--surface-2);
		}
	}

	.item:active {
		transform: scale(0.99);
	}

	.main {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.who {
		font-weight: 560;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		color: var(--muted);
		font-size: 0.9rem;
		white-space: nowrap;
	}

	.cat {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--dot);
	}

	.dot.none {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--muted);
	}

	.sub,
	.reserve {
		font-size: 0.88rem;
		color: var(--muted);
	}

	.amount {
		display: grid;
		justify-items: end;
		white-space: nowrap;
		font-weight: 600;
		font-size: 1.02rem;
	}

	.per {
		color: var(--muted);
		font-size: 0.82rem;
		font-weight: 400;
	}

	.signal {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin: 0 0 12px;
		padding: 10px 12px;
		border-radius: var(--radius-sm);
		background: color-mix(in oklch, var(--warn) 18%, transparent);
		font-size: 0.92rem;
	}

	.text-button {
		flex: none;
		min-height: var(--tap);
		padding: 0 8px;
		border: 0;
		background: none;
		color: var(--accent-strong);
		font-weight: 600;
		cursor: pointer;
	}

	.stopped summary {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: var(--tap);
		font-weight: 550;
		cursor: pointer;
	}

	.stopped ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 4px;
	}

	.stopped li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		min-height: var(--tap);
		align-items: center;
	}
</style>
