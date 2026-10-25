<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { fly } from 'svelte/transition';
	import BudgetBar from '#lib/components/BudgetBar.svelte';
	import HeroAmount from '#lib/components/HeroAmount.svelte';
	import QuickEntry from '#lib/components/QuickEntry.svelte';
	import TransactionItem from '#lib/components/TransactionItem.svelte';
	import { formatMonth } from '#lib/dates.ts';
	import { flush, type QueuedTransaction } from '#lib/offline/queue.ts';
	import { sync } from '#lib/offline/sync.svelte.ts';

	let { data } = $props();

	const lines = $derived(data.overview.lines.filter((l) => l.limitCents > 0 || l.spentCents > 0));
	const hasBudget = $derived(data.overview.totalLimitCents > 0);
	const category = (id: string | null) => data.context.categories.find((c) => c.id === id);
	const accountAlias = (id: string) => data.context.accounts.find((a) => a.id === id)?.alias ?? '';

	// Optimistisch: wat in de wachtrij staat verschijnt meteen bovenaan
	const recentIds = $derived(new Set(data.recent.map((t) => t.id)));
	const queued = $derived(sync.pending.filter((p) => !recentIds.has(p.payload.id)));

	async function saved(_item: QueuedTransaction) {
		await sync.refreshPending();
		const result = await flush();
		sync.offline = result.offline;
		sync.loggedOut = result.loggedOut;
		await sync.refreshPending();
		if (result.sent > 0) await refreshAll();
	}
</script>

<svelte:head>
	<title>Budget</title>
</svelte:head>

<div class="home">
	<div class="top">
		{#if hasBudget}
			<HeroAmount
				cents={data.overview.freeCents}
				label="Nog vrij in {formatMonth(data.overview.month)}"
			/>
		{:else}
			<section class="empty">
				<h1>Nog geen budget</h1>
				<p class="muted">Stel limieten per categorie in, dan zie je hier wat je nog vrij hebt.</p>
				<a class="button secondary" href="/budget">Budget instellen</a>
			</section>
		{/if}

		<QuickEntry context={data.context} onsaved={saved} />
	</div>

	{#if data.balanceCheckDue.length > 0}
		<p class="card reminder">
			<span>
				Saldocheck voor {formatMonth(data.overview.month)}: nog te doen voor {data.balanceCheckDue
					.map((a) => a.name)
					.join(' en ')}.
			</span>
			<a href="/saldocheck">Saldo invullen</a>
		</p>
	{/if}

	<section class="recent" aria-labelledby="recent-title">
		<div class="head">
			<h2 id="recent-title">Recent</h2>
			{#if data.reviewCount > 0}
				<a href="/transacties?status=te_controleren">{data.reviewCount} te controleren</a>
			{/if}
		</div>
		<ul>
			{#each queued as item (item.payload.id)}
				<li in:fly={{ y: -12, duration: 220 }}>
					<TransactionItem
						tx={{
							amountCents: item.payload.amountCents,
							date: item.payload.date,
							counterparty: item.payload.counterparty,
							categoryName: category(item.payload.categoryId)?.name ?? null,
							categoryGroup: category(item.payload.categoryId)?.group ?? null,
							accountAlias: accountAlias(item.payload.accountId),
							status: item.payload.amountCents === 0 ? 'te_controleren' : 'bevestigd',
							origAmountCents: item.payload.origAmountCents,
							origCurrency: item.payload.origCurrency
						}}
						pending={!item.error}
						error={item.error}
					/>
				</li>
			{/each}
			{#each data.recent as tx (tx.id)}
				<li>
					<TransactionItem {tx} />
				</li>
			{:else}
				{#if queued.length === 0}
					<li class="muted none">
						Nog niets ingevoerd. Typ hierboven bijvoorbeeld <strong>12,50 ah</strong>, of
						<a href="/import">importeer je SNS-historie</a>.
					</li>
				{/if}
			{/each}
		</ul>
		<a href="/transacties">Alle transacties</a>
	</section>

	{#if lines.length > 0}
		<section class="budget" aria-labelledby="budget-title">
			<h2 id="budget-title">Per categorie</h2>
			<div class="bars">
				{#each lines as line (line.categoryId)}
					<BudgetBar {...line} />
				{/each}
			</div>
		</section>
	{/if}
</div>

<style>
	.home {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 40px;
	}

	.top {
		display: grid;
		gap: 24px;
	}

	.reminder {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 4px 16px;
		border-left: 4px solid var(--accent);
	}

	.reminder a {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		font-weight: 600;
	}

	.empty {
		display: grid;
		gap: 12px;
		justify-items: start;
	}

	.head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}

	.recent,
	.budget {
		display: grid;
		gap: 12px;
		align-content: start;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}

	li + li {
		border-top: 1px solid var(--line);
	}

	.none {
		padding: 12px 0;
	}

	.bars {
		display: grid;
		gap: 18px;
	}

	@container (min-width: 900px) {
		.home {
			grid-template-columns: 1.1fr 1fr;
			column-gap: 56px;
		}

		.top {
			grid-column: 1 / -1;
		}
	}
</style>
