<script lang="ts">
	import { groupColor, groupHue } from '#lib/categoryColor.ts';
	import { formatShortDate } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';
	import { describeRefund, type RefundInfo } from '#lib/refund.ts';
	import { displayName, initials } from '#lib/text.ts';

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
		/** Een interne overboeking: deze afschrijving en de bijschrijving samen als één rij */
		transfer?: { from: string; to: string; date: string } | null;
	}

	let {
		tx,
		pending = false,
		error,
		href,
		showDate = true,
		showStatus = true
	}: {
		tx: Item;
		pending?: boolean;
		error?: string;
		href?: string;
		showDate?: boolean;
		/** Zonder label "te controleren", zoals in de review-inbox waar de groep het al zegt */
		showStatus?: boolean;
	} = $props();

	const color = $derived(tx.categoryName ? groupColor(tx.categoryGroup ?? tx.categoryName) : null);
	// Monogram in de tint van de groep; zonder categorie grijs
	const monoHue = $derived(tx.categoryName ? groupHue(tx.categoryGroup ?? tx.categoryName) : null);
	const refund = $derived(tx.refund ? describeRefund(tx.refund, tx.counterparty) : null);
	const orig = $derived(
		tx.origCurrency && tx.origAmountCents !== null
			? `${tx.origCurrency === 'USD' ? '$' : `${tx.origCurrency} `}${centsToInput(tx.origAmountCents)}`
			: null
	);
</script>

<svelte:element this={href ? 'a' : 'div'} {href} class={['item', href && 'link']}>
	{#if tx.transfer}
		<!-- Twee rekeningen over elkaar: het geld gaat van de ene naar de andere -->
		<span class="pair" aria-hidden="true">
			<span class="monogram">{initials(tx.transfer.from)}</span>
			<span class="monogram">{initials(tx.transfer.to)}</span>
		</span>
	{:else}
		<span class={['monogram', monoHue !== null && 'hue']} style:--h={monoHue} aria-hidden="true"
			>{initials(tx.counterparty || '?')}</span
		>
	{/if}
	<div class="main">
		{#if tx.transfer}
			<span class="who route" data-tx-name={href ? tx.id : undefined}
				>{tx.transfer.from}<svg viewBox="0 0 16 16" aria-hidden="true"
					><path
						d="M2.5 8h10M9 4.5 12.5 8 9 11.5"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
						stroke-linejoin="round"
					/></svg
				><span class="visually-hidden">naar</span>{tx.transfer.to}</span
			>
		{:else}
			<span class="who" data-tx-name={href ? tx.id : undefined}
				>{displayName(tx.counterparty) || 'Zonder naam'}</span
			>
		{/if}
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
			{:else if tx.transfer}
				<!-- Herkend aan de eigen IBAN heeft hij soms geen categorie; het is altijd een overboeking -->
				<span class="cat"
					>{tx.transfer.date === tx.date
						? (tx.categoryName ?? 'Interne overboeking')
						: 'Intern'}</span
				>
			{:else}
				<span class={['dot', !color && 'none']} style:--dot={color} aria-hidden="true"></span>
				<span class={['cat', !tx.categoryName && 'uncat']}
					>{tx.categoryName ?? 'Geen categorie'}</span
				>
			{/if}
			{#if showDate}<span class="sep" aria-hidden="true">·</span>{formatShortDate(tx.date)}{/if}
			{#if tx.transfer}
				{#if tx.transfer.date !== tx.date}<span class="sep" aria-hidden="true">·</span><span
						>binnen {formatShortDate(tx.transfer.date)}</span
					>{/if}
			{:else if tx.accountAlias}<span class="sep" aria-hidden="true">·</span><span
					>{tx.accountAlias}</span
				>{/if}
		</span>
		{#if pending}
			<span class="badge pending">Wordt opgeslagen</span>
		{:else if error}
			<span class="badge error">{error}</span>
		{:else if tx.status === 'te_controleren' && showStatus}
			<span class="badge review">Te controleren</span>
		{:else if tx.status === 'verwacht'}
			<span class="badge expected">Verwacht</span>
		{/if}
	</div>
	<div
		class={[
			'amount',
			'num',
			tx.transfer ? 'moved' : tx.amountCents > 0 && 'in',
			tx.status === 'verwacht' && 'planned'
		]}
		data-tx-amount={href ? tx.id : undefined}
	>
		{#if tx.transfer}
			<!-- Geen uitgave en geen inkomen: het bedrag zonder teken -->
			<span>{formatCents(Math.abs(tx.amountCents))}</span>
			<span class="orig">overgeboekt</span>
		{:else if tx.amountCents === 0 && orig}
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

	.route svg {
		width: 14px;
		height: 14px;
		margin-inline: 5px;
		vertical-align: -2px;
		color: var(--muted);
	}

	/* Twee kleinere monogrammen schuin over elkaar, samen even groot als één */
	.pair {
		position: relative;
		flex: none;
		width: 40px;
		height: 40px;
	}

	.pair .monogram {
		--size: 24px;
		position: absolute;
		top: 0;
		left: 0;
	}

	/* De rekening waar het geld binnenkomt in de accentkleur, met een rand in de achtergrond */
	.pair .monogram + .monogram {
		--wash: color-mix(in srgb, var(--accent) 24%, var(--bg));
		--ink: var(--accent-strong);
		top: auto;
		left: auto;
		right: 0;
		bottom: 0;
		box-shadow: 0 0 0 2px var(--bg);
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

	.moved {
		color: var(--muted);
	}

	.orig {
		color: var(--muted);
		font-size: 0.82rem;
		font-weight: 400;
	}
</style>
