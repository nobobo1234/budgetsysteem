<script lang="ts">
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import WarrantyStrip from '#lib/components/WarrantyStrip.svelte';
	import * as icons from '#lib/icons.ts';
	import { formatCents } from '#lib/money.ts';
	import { displayName } from '#lib/text.ts';
	import { formatLeft, warrantySentence } from '#lib/warranty.ts';

	// Garantie (spec: Schermen): per actief product een strook van aankoop tot het einde van de
	// geschatte levensduur. Eerst wat binnenkort afloopt, dan de rest; afgedankt ingeklapt.
	// Voorstellen staan in Te controleren, niet hier.

	let { data } = $props();
	type Row = (typeof data.rest)[number];

	const store = (r: Pick<Row, 'counterparty'>) => displayName(r.counterparty) || 'de winkel';
	const soonText = (s: NonNullable<(typeof data.soon)[number]['soon']>) =>
		`${s.moment === 'jaar' ? 'Eerste jaar' : 'Fabrieksgarantie'} nog ${formatLeft(data.today, s.endDate)}`;
	const empty = $derived(
		data.soon.length === 0 && data.rest.length === 0 && data.discarded.length === 0
	);
</script>

<svelte:head>
	<title>Garantie · Budget</title>
</svelte:head>

{#snippet product(r: Row, soon: string | null)}
	<li>
		<article class="card product" aria-labelledby="w-{r.id}">
			<div class="head">
				<h2 id="w-{r.id}"><a class="stretch" href="/garantie/{r.id}">{r.product}</a></h2>
				<p class="num price">{formatCents(-r.amountCents)}</p>
			</div>
			<p class="meta muted">
				{store(r)}{#if soon}<span class="soon">{` · ${soon}`}</span>{/if}
			</p>
			<WarrantyStrip w={r} today={data.today} />
			<p class="tell small">{warrantySentence(r, store(r), data.today)}</p>
		</article>
	</li>
{/snippet}

<div class="page">
	<div class="intro">
		<BackLink parents={['/instellingen']} />
		<h1 data-morph-head="titel">Garantie</h1>
	</div>

	{#if data.soon.length > 0}
		<section class="group" aria-labelledby="soon-title">
			<h2 id="soon-title" class="group-title">Binnenkort</h2>
			<ul class="list">
				{#each data.soon as r (r.id)}
					{@render product(r, r.soon ? soonText(r.soon) : null)}
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.rest.length > 0}
		<section class="group" aria-labelledby="rest-title">
			<h2 id="rest-title" class={['group-title', data.soon.length === 0 && 'visually-hidden']}>
				Verder
			</h2>
			<ul class="list">
				{#each data.rest as r (r.id)}
					{@render product(r, null)}
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.discarded.length > 0}
		<details class="fold">
			<summary
				><svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5l5 5-5 5" /></svg
				>Afgedankt <span class="muted num">({data.discarded.length})</span></summary
			>
			<ul class="card discarded">
				{#each data.discarded as r (r.id)}
					<li>
						<a class="row" href="/garantie/{r.id}">
							<span class="name">{r.product}</span>
							<span class="muted small">{store(r)}</span>
						</a>
					</li>
				{/each}
			</ul>
		</details>
	{/if}

	{#if empty}
		<div class="card">
			<EmptyState
				icon={icons.garantie}
				text="Nog geen producten met garantie. Een aankoop vanaf € 50 bij Elektronica komt vanzelf als voorstel bij Te controleren; op een transactie kies je zelf Garantie bijhouden."
			>
				<a class="more-link" href="/transacties">Transacties</a>
			</EmptyState>
		</div>
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		max-width: 44rem;
	}

	.intro,
	.group {
		display: grid;
		gap: 12px;
	}

	.group-title {
		font-size: 1.15rem;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 12px;
	}

	.product {
		position: relative;
		display: grid;
		gap: 10px;
		transition: transform 160ms var(--ease-spring);
	}

	.product:active {
		transform: scale(0.99);
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.head h2 {
		font-size: 1.2rem;
		overflow-wrap: anywhere;
	}

	/* De hele kaart is de link naar het product */
	.stretch {
		color: inherit;
		text-decoration: none;
	}

	.stretch::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
	}

	.price {
		font-weight: 600;
		white-space: nowrap;
	}

	.meta {
		font-size: 0.9rem;
	}

	.soon {
		color: color-mix(in oklch, var(--warn) 60%, var(--text));
		font-weight: 600;
	}

	.small {
		font-size: 0.95rem;
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

	.discarded {
		list-style: none;
		margin: 0;
		padding: 0 16px;
	}

	.discarded li + li {
		border-top: 1px solid var(--line);
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: var(--tap);
		padding: 8px 0;
		color: inherit;
		text-decoration: none;
	}

	.name {
		font-weight: 560;
		overflow-wrap: anywhere;
	}
</style>
