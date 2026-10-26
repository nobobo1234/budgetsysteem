<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import StackedBar from '#lib/components/StackedBar.svelte';
	import TagFields from '#lib/components/TagFields.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { groupColor, groupHue } from '#lib/categoryColor.ts';
	import { formatDayHeading, formatShortDate } from '#lib/dates.ts';
	import * as icons from '#lib/icons-extra.ts';
	import { formatCents } from '#lib/money.ts';
	import { formatPeriod, HUE_NAMES, tagSegments, tagSentence } from '#lib/tags.ts';
	import { displayName, initials } from '#lib/text.ts';

	let { data, form } = $props();

	const tag = $derived(data.tag);
	// Eerst lezen, dan bewerken: het formulier opent via "Bewerken"
	let editing = $state(false);
	let busy = $state(false);
	let confirmDelete = $state(false);

	const keep: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			busy = false;
			if (result.type === 'success') editing = false;
		};
	};

	const NONE = 'color-mix(in oklch, var(--text) 28%, transparent)';
	const segments = $derived(
		tagSegments(data.byCategory, 8).map((s) => ({
			key: s.key,
			label: s.label,
			cents: s.cents,
			color: s.group ? (groupColor(s.group) ?? NONE) : NONE
		}))
	);
	// Retouren die per saldo meer terugkregen dan er uitging staan niet in de balk, wel in tekst
	const refunded = $derived(data.byCategory.filter((c) => c.cents < 0));

	type Item = (typeof data.items)[number];
	type Row = Item['corrections'][number];
	const days = $derived.by(() => {
		const out: { date: string; items: Item[] }[] = [];
		for (const item of data.items) {
			const last = out.at(-1);
			if (last?.date === item.date) last.items.push(item);
			else out.push({ date: item.date, items: [item] });
		}
		return out;
	});

	const why = (item: Item) =>
		item.status === 'verwacht' ? 'Nog verwacht' : `${item.categoryName ?? ''}, buiten budget`;

	const feedback = $derived(
		form && 'message' in form && form.message
			? { text: form.message, error: true }
			: form && 'saved' in form
				? { text: 'Opgeslagen', error: false }
				: form && 'toggled' in form
					? { text: 'Weer aan', error: false }
					: null
	);
</script>

<svelte:head>
	<title>{tag.name} · Tags · Budget</title>
</svelte:head>

<!-- Een eigen, kleine rij in plaats van TransactionItem: die deelt op het startscherm een chunk
     met LinkThreads, en een extra pagina met alleen TransactionItem splitst die chunk, wat de
     eerste bundel van het startscherm groter maakt (Lighthouse-budget). -->
{#snippet line(t: Row, showDate: boolean)}
	{@const hue = t.categoryName ? groupHue(t.categoryGroup ?? t.categoryName) : null}
	<a class="line" href="/transacties/{t.id}">
		<span class={['monogram', hue !== null && 'hue']} style:--h={hue} aria-hidden="true"
			>{initials(t.counterparty || '?')}</span
		>
		<span class="what">
			<span class="who">{displayName(t.counterparty) || 'Zonder naam'}</span>
			<span class="meta">
				<span
					class={['dot', !t.categoryName && 'none']}
					style:--dot={t.categoryName ? groupColor(t.categoryGroup ?? t.categoryName) : null}
					aria-hidden="true"
				></span>
				<span class="cat">{t.categoryName ?? 'Geen categorie'}</span>
				{#if showDate}<span aria-hidden="true">·</span>{formatShortDate(t.date)}{/if}
				{#if t.status === 'verwacht'}<span aria-hidden="true">·</span>verwacht{/if}
			</span>
		</span>
		<span class={['amount', 'num', t.amountCents > 0 && 'in']}
			>{formatCents(t.amountCents, { sign: true })}</span
		>
	</a>
{/snippet}

{#snippet row(item: Item)}
	{@render line(item, false)}
	{#if item.mineCents !== null && item.mineCents !== item.amountCents}
		<p class="mine muted num">Telt mee: jouw deel {formatCents(-item.mineCents)}</p>
	{/if}
	{#if item.corrections.length > 0}
		<ul class="corrections" aria-label="Retour op {item.counterparty}">
			{#each item.corrections as c (c.id)}
				<li>{@render line(c, true)}</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<div class="page">
	<BackLink parents={['/tags', '/instellingen']} />

	<header>
		<div class="title">
			<span class="icon-badge hue" style:--h={tag.hue} aria-hidden="true">
				<svg viewBox="0 0 24 24"
					><path
						d={icons.tags.path}
						fill="none"
						stroke="currentColor"
						stroke-width="1.7"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				>
			</span>
			<h1 data-morph-head="titel">{tag.name}</h1>
		</div>
		<p class="amount num">
			<span class="visually-hidden">Totaal </span>{formatCents(data.totalCents)}
		</p>
		<p class="muted">{formatPeriod(tag, data.today)}</p>
		<p class="tell">{tagSentence(tag, data.totalCents, data.today)}</p>
	</header>

	{#if feedback}
		{#key form}<Toast text={feedback.text} error={feedback.error} />{/key}
	{/if}

	{#if segments.length > 0}
		<section class="card" aria-labelledby="split-title">
			<h2 id="split-title">Per categorie</h2>
			<StackedBar label="Verdeling van {tag.name} per categorie" {segments} />
			{#if refunded.length > 0}
				<p class="muted small">
					Meer terug dan uitgegeven: {refunded
						.map((c) => `${c.name} ${formatCents(-c.cents)}`)
						.join(', ')}
				</p>
			{/if}
		</section>
	{/if}

	<section class="list" aria-labelledby="tx-title">
		<h2 id="tx-title">Transacties</h2>
		{#if days.length > 0}
			<p class="muted small">Hoort er iets niet bij? Zet de tag uit op de transactie.</p>
			{#each days as day (day.date)}
				<h3 class="day">{formatDayHeading(day.date, data.today)}</h3>
				<ul>
					{#each day.items as item (item.id)}
						<li>{@render row(item)}</li>
					{/each}
				</ul>
			{/each}
		{:else}
			<EmptyState
				compact
				icon={icons.tags}
				text={tag.state === 'komt'
					? 'Zodra de periode begint, komt hier alles wat je uitgeeft.'
					: 'Nog niets in deze periode. Wat je invoert of importeert komt hier vanzelf bij.'}
			/>
		{/if}
	</section>

	{#if data.notCounted.length > 0}
		<details class="fold">
			<summary
				><svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5l5 5-5 5" /></svg
				>Telt niet mee <span class="muted num">({data.notCounted.length})</span></summary
			>
			<p class="muted small">Inkomen, eigen overboekingen en verwachte posten tellen niet mee.</p>
			<ul>
				{#each data.notCounted as item (item.id)}
					<li>
						{@render line(item, true)}
						<p class="mine muted">{why(item)}</p>
					</li>
				{/each}
			</ul>
		</details>
	{/if}

	{#if data.off.length > 0}
		<details class="fold">
			<summary
				><svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5l5 5-5 5" /></svg
				>Uitgezet <span class="muted num">({data.off.length})</span></summary
			>
			<ul>
				{#each data.off as item (item.id)}
					<li class="off">
						{@render line(item, true)}
						<form method="POST" action="?/toggle" use:enhance={keep}>
							<input type="hidden" name="transactionId" value={item.id} />
							<input type="hidden" name="on" value="1" />
							<button class="button secondary small" disabled={busy}>Weer aan</button>
						</form>
					</li>
				{/each}
			</ul>
		</details>
	{/if}

	{#if editing}
		<form method="POST" action="?/save" class="card form" use:enhance={keep}>
			<TagFields name={tag.name} startDate={tag.startDate} endDate={tag.endDate} hue={tag.hue} />
			<p class="muted small">
				Een andere periode neemt de transacties in die dagen mee; wat je zelf aan- of uitzette
				blijft staan.
			</p>
			<div class="save">
				<button class="button" disabled={busy}>{busy ? 'Opslaan…' : 'Opslaan'}</button>
				<button type="button" class="button secondary" onclick={() => (editing = false)}
					>Annuleren</button
				>
			</div>
		</form>
	{:else}
		<section class="card details" aria-labelledby="details-title">
			<div class="section-head">
				<h2 id="details-title">Gegevens</h2>
				<button type="button" class="button secondary small" onclick={() => (editing = true)}
					>Bewerken</button
				>
			</div>
			<dl>
				<div>
					<dt>Periode</dt>
					<dd>{formatPeriod(tag, data.today)}</dd>
				</div>
				<div>
					<dt>Kleur</dt>
					<dd class="hue-value">
						<span class="swatch" style:--h={tag.hue} aria-hidden="true"></span>
						{HUE_NAMES[tag.hue as keyof typeof HUE_NAMES] ?? 'Eigen tint'}
					</dd>
				</div>
			</dl>
		</section>
	{/if}

	<section class="remove" aria-label="Tag verwijderen">
		{#if confirmDelete}
			<p>{tag.name} verwijderen? De transacties blijven staan, alleen de tag verdwijnt.</p>
			<div class="save">
				<form method="POST" action="?/delete" use:enhance={keep}>
					<button class="button danger" disabled={busy}>Ja, verwijderen</button>
				</form>
				<button type="button" class="button secondary" onclick={() => (confirmDelete = false)}
					>Annuleren</button
				>
			</div>
		{:else}
			<button type="button" class="button danger" onclick={() => (confirmDelete = true)}
				>Tag verwijderen</button
			>
		{/if}
	</section>
</div>

<style>
	.page {
		max-width: 40rem;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 22px;
	}

	header {
		display: grid;
		gap: 6px;
	}

	.title {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}

	h1 {
		overflow-wrap: anywhere;
	}

	.amount {
		font-size: clamp(2rem, 9vw, 2.75rem);
		font-weight: 650;
		letter-spacing: -0.03em;
		line-height: 1.1;
	}

	.card {
		display: grid;
		gap: 12px;
	}

	.small {
		font-size: 0.88rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list {
		display: grid;
		gap: 8px;
	}

	.day {
		position: sticky;
		top: var(--sticky-top, 0px);
		z-index: 2;
		padding: 10px 0 4px;
		background: var(--bg);
		font-family: var(--font-ui);
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--muted);
	}

	.list li + li,
	.fold li + li {
		border-top: 1px solid var(--line);
	}

	.line {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		margin-inline: -10px;
		padding: 10px;
		border-radius: var(--radius-sm);
		color: inherit;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	@media (hover: hover) {
		.line:hover {
			background: var(--surface-2);
		}
	}

	.line:active {
		transform: scale(0.99);
	}

	.what {
		display: grid;
		flex: 1;
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

	.amount {
		flex: none;
		font-weight: 600;
		text-align: right;
	}

	.amount.in {
		color: var(--accent-strong);
	}

	.mine {
		margin: -4px 0 8px 52px;
		font-size: 0.88rem;
	}

	.corrections {
		margin-left: 28px;
		padding-left: 12px;
		border-left: 2px solid var(--line);
	}

	.fold {
		display: grid;
		gap: 8px;
	}

	.fold summary {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: var(--tap);
		font-weight: 600;
		cursor: pointer;
	}

	.chev {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 200ms var(--ease-out);
	}

	.fold[open] .chev {
		transform: rotate(90deg);
	}

	.off {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
	}

	.form {
		display: grid;
		gap: 16px;
		padding: 20px;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px 12px;
	}

	.button.small {
		min-height: var(--tap);
		padding: 0 14px;
		font-size: 0.92rem;
	}

	dl {
		margin: 0;
		display: grid;
	}

	dl > div {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 16px;
		padding: 10px 0;
	}

	dl > div + div {
		border-top: 1px solid var(--line);
	}

	dt {
		color: var(--muted);
	}

	dd {
		margin: 0;
		text-align: right;
		font-weight: 550;
	}

	.hue-value {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.swatch {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: oklch(var(--dot-l) var(--dot-c) var(--h));
	}

	.save {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.remove {
		display: grid;
		gap: 8px;
		justify-items: start;
	}
</style>
