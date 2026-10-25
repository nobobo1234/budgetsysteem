<script lang="ts">
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatShortDate } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';
	import { describeRefund, type RefundInfo } from '#lib/refund.ts';
	import { displayName } from '#lib/text.ts';
	import Monogram from './Monogram.svelte';

	interface Item {
		/** Alleen nodig voor de overgang naar de detailpagina */
		id?: string;
		amountCents: number;
		date: string;
		counterparty: string;
		categoryName: string | null;
		categoryGroup?: string | null;
		accountAlias: string;
		status: 'bevestigd' | 'verwacht' | 'te_controleren';
		origAmountCents: number | null;
		origCurrency: string | null;
		/** Een gekoppelde terugbetaling: dan staat hier waar hij voor was, niet de categorie */
		refund?: RefundInfo | null;
	}

	let {
		tx,
		pending = false,
		error,
		href,
		showDate = true
	}: { tx: Item; pending?: boolean; error?: string; href?: string; showDate?: boolean } = $props();

	const color = $derived(tx.categoryName ? groupColor(tx.categoryGroup ?? tx.categoryName) : null);
	const refund = $derived(tx.refund ? describeRefund(tx.refund, tx.counterparty) : null);
	const orig = $derived(
		tx.origCurrency && tx.origAmountCents !== null
			? `${tx.origCurrency === 'USD' ? '$' : `${tx.origCurrency} `}${centsToInput(tx.origAmountCents)}`
			: null
	);
</script>

<svelte:element this={href ? 'a' : 'div'} {href} class={['item', href && 'link']}>
	<Monogram
		name={tx.counterparty || '?'}
		group={tx.categoryName ? (tx.categoryGroup ?? tx.categoryName) : null}
	/>
	<div class="main">
		<span class="who" data-tx-name={href ? tx.id : undefined}
			>{displayName(tx.counterparty) || 'Zonder naam'}</span
		>
		<span class="meta">
			{#if refund}
				<svg class="hook" viewBox="0 0 12 12" aria-hidden="true">
					<path
						d="M4.5 1.75 1.75 4.5 4.5 7.25M2 4.5h5a3 3 0 0 1 0 6H5.5"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				<span class="cat refund" data-refund>{refund}</span>
			{:else}
				<span class={['dot', !color && 'none']} style:--dot={color} aria-hidden="true"></span>
				<span class={['cat', !tx.categoryName && 'uncat']}
					>{tx.categoryName ?? 'Geen categorie'}</span
				>
			{/if}
			{#if showDate}<span class="sep" aria-hidden="true">·</span>{formatShortDate(tx.date)}{/if}
			{#if tx.accountAlias}<span class="sep" aria-hidden="true">·</span><span
					>{tx.accountAlias}</span
				>{/if}
		</span>
		{#if pending}
			<span class="badge pending">Wordt opgeslagen</span>
		{:else if error}
			<span class="badge error">{error}</span>
		{:else if tx.status === 'te_controleren'}
			<span class="badge review">Te controleren</span>
		{:else if tx.status === 'verwacht'}
			<span class="badge expected">Verwacht</span>
		{/if}
	</div>
	<div
		class={['amount', 'num', tx.amountCents > 0 && 'in', tx.status === 'verwacht' && 'planned']}
		data-tx-amount={href ? tx.id : undefined}
	>
		{#if tx.amountCents === 0 && orig}
			<span>{orig}</span>
			<span class="orig">eurobedrag nog invullen</span>
		{:else}
			<span>{formatCents(tx.amountCents, { sign: true })}</span>
			{#if orig}<span class="orig">{orig}</span>{/if}
		{/if}
	</div>
</svelte:element>

<style>
	.item {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		padding: 10px 0;
		color: inherit;
		text-decoration: none;
	}

	.link {
		margin-inline: -10px;
		padding-inline: 10px;
		border-radius: var(--radius-sm);
		transition: transform 160ms var(--ease-spring);
	}

	@media (hover: hover) {
		.link:hover {
			background: var(--surface-2);
		}
	}

	.link:active {
		transform: scale(0.99);
	}

	.main {
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

	.uncat {
		font-style: italic;
	}

	.sep {
		opacity: 0.6;
	}

	.hook {
		flex: none;
		width: 12px;
		height: 12px;
		color: var(--accent-strong);
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

	.badge {
		justify-self: start;
		margin-top: 2px;
		padding: 1px 8px;
		border-radius: 999px;
		font-size: 0.8rem;
		font-weight: 600;
	}

	/* Een verwachte post is nog niet uitgegeven: gestippeld en rustiger */
	.expected {
		border: 1px dashed var(--muted);
		color: var(--muted);
	}

	.amount.planned {
		color: var(--muted);
	}

	.review {
		background: color-mix(in oklch, var(--warn) 22%, transparent);
	}

	.pending {
		background: var(--surface-2);
		color: var(--muted);
	}

	.error {
		background: color-mix(in oklch, var(--danger) 16%, transparent);
		color: var(--danger);
	}

	.amount {
		display: grid;
		justify-items: end;
		white-space: nowrap;
		font-weight: 600;
		font-size: 1.02rem;
	}

	.in {
		color: var(--accent-strong);
	}

	.orig {
		color: var(--muted);
		font-size: 0.82rem;
		font-weight: 400;
	}
</style>
