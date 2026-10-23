<script lang="ts">
	import { formatShortDate } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';

	interface Item {
		amountCents: number;
		date: string;
		counterparty: string;
		categoryName: string | null;
		accountAlias: string;
		status: 'bevestigd' | 'verwacht' | 'te_controleren';
		origAmountCents: number | null;
		origCurrency: string | null;
	}

	let {
		tx,
		pending = false,
		error,
		href
	}: { tx: Item; pending?: boolean; error?: string; href?: string } = $props();
</script>

<svelte:element this={href ? 'a' : 'div'} {href} class="item" class:link={!!href}>
	<div class="main">
		<span class="who">{tx.counterparty || 'Zonder naam'}</span>
		<span class="meta muted">
			{formatShortDate(tx.date)}
			· {tx.categoryName ?? 'Geen categorie'}
			{#if tx.accountAlias}· {tx.accountAlias}{/if}
		</span>
		{#if pending}
			<span class="badge">Wordt opgeslagen</span>
		{:else if error}
			<span class="badge error-text">{error}</span>
		{:else if tx.status === 'te_controleren'}
			<span class="badge">Te controleren</span>
		{/if}
	</div>
	<div class="amount num" class:in={tx.amountCents > 0}>
		{#if tx.amountCents === 0 && tx.origCurrency}
			{tx.origCurrency === 'USD' ? '$' : ''}{centsToInput(tx.origAmountCents ?? 0)}
		{:else}
			{formatCents(tx.amountCents, { sign: true })}
			{#if tx.origCurrency && tx.origAmountCents !== null}
				<span class="orig muted"
					>{tx.origCurrency === 'USD' ? '$' : ''}{centsToInput(tx.origAmountCents)}</span
				>
			{/if}
		{/if}
	</div>
</svelte:element>

<style>
	.item {
		display: flex;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 0;
		color: inherit;
		text-decoration: none;
		min-height: var(--tap);
	}

	.link:hover .who {
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}

	.main {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.who {
		font-weight: 550;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		font-size: 0.9rem;
	}

	.badge {
		font-size: 0.85rem;
		font-weight: 550;
	}

	.amount {
		display: grid;
		justify-items: end;
		align-content: start;
		white-space: nowrap;
		font-weight: 550;
	}

	.in {
		color: var(--accent-strong);
	}

	.orig {
		font-size: 0.85rem;
		font-weight: 400;
	}
</style>
