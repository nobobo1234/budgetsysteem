<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import { fly } from 'svelte/transition';
	import BudgetBar from '#lib/components/BudgetBar.svelte';
	import ExpectedItem from '#lib/components/ExpectedItem.svelte';
	import HeroAmount from '#lib/components/HeroAmount.svelte';
	import LinkThreads, { threadGutter } from '#lib/components/LinkThreads.svelte';
	import QuickEntry from '#lib/components/QuickEntry.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import TransactionItem from '#lib/components/TransactionItem.svelte';
	import { formatMonth, formatShortDate } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';
	import { flush, type QueuedTransaction } from '#lib/offline/queue.ts';
	import { sync } from '#lib/offline/sync.svelte.ts';
	import { motion } from '#lib/motion.ts';
	import { threadLayout } from '#lib/refund.ts';

	let { data } = $props();

	const lines = $derived(data.overview.lines.filter((l) => l.limitCents > 0 || l.spentCents > 0));
	const hasBudget = $derived(data.overview.totalLimitCents > 0);
	const category = (id: string | null) => data.context.categories.find((c) => c.id === id);
	const accountAlias = (id: string) => data.context.accounts.find((a) => a.id === id)?.alias ?? '';

	// Optimistisch: wat in de wachtrij staat verschijnt meteen bovenaan
	const recentIds = $derived(new Set(data.recent.map((t) => t.id)));
	const queued = $derived(sync.pending.filter((p) => !recentIds.has(p.payload.id)));
	// Terugbetalingen met hun uitgave verbonden, als die ook bij Recent staat
	const threads = $derived(threadLayout(data.recent));

	let toast = $state<{ text: string; error: boolean; key: number } | null>(null);
	const notify = (text: string, error = false) => (toast = { text, error, key: Date.now() });
	const showFixed = $derived(
		data.expected.length > 0 || data.receipts.length > 0 || data.upcoming > 0 || data.proposals > 0
	);

	// Eén tik "ontvangen" voor een aandeel in een gedeelde vaste last
	let receiving = $state<string | null>(null);
	const receive: SubmitFunction = ({ formData }) => {
		receiving = String(formData.get('id'));
		const item = data.receipts.find((r) => r.id === receiving);
		return async ({ result, update }) => {
			receiving = null;
			if (result.type === 'success') {
				notify(`${item?.personName ?? 'Betaling'} ontvangen.`);
				await update();
				return;
			}
			const message = result.type === 'failure' ? result.data?.message : undefined;
			notify(typeof message === 'string' ? message : 'Dat lukte niet. Probeer het opnieuw.', true);
		};
	};

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

	{#if showFixed}
		<section class="fixed" aria-labelledby="fixed-title">
			<div class="head">
				<h2 id="fixed-title">
					{data.expected.length > 0 || data.receipts.length > 0 ? 'Te bevestigen' : 'Vaste lasten'}
				</h2>
				<a href="/vaste-lasten">Alle vaste lasten</a>
			</div>
			{#if data.expected.length > 0}
				<ul class="card expected">
					{#each data.expected as item (item.id)}
						<li out:fly={{ x: 32, duration: motion(220) }}>
							<ExpectedItem {item} ondone={notify} />
						</li>
					{/each}
				</ul>
			{/if}
			{#if data.receipts.length > 0}
				<ul class="card expected" aria-label="Terugbetalingen om te bevestigen">
					{#each data.receipts as item (item.id)}
						<li class="receipt" out:fly={{ x: 32, duration: motion(220) }}>
							<a class="who" href="/terugbetalingen">
								<span class="name">{item.personName}</span>
								<span class="muted small">
									{item.counterparty} · verwacht {formatShortDate(item.dueDate)}{item.late
										? ' · te laat'
										: ''}
								</span>
							</a>
							<span class="num in">+{formatCents(item.outstandingCents)}</span>
							<form method="POST" action="?/received" use:enhance={receive}>
								<input type="hidden" name="id" value={item.id} />
								<button
									class="button secondary small"
									disabled={receiving === item.id}
									aria-label="{formatCents(item.outstandingCents)} van {item.personName} ontvangen"
									>Ontvangen</button
								>
							</form>
						</li>
					{/each}
				</ul>
			{/if}
			{#if data.upcoming > 0 || data.proposals > 0}
				<p class="muted">
					{#if data.upcoming > 0}
						Nog {data.upcoming} verwacht deze maand.
					{/if}
					{#if data.proposals > 0}
						<a href="/vaste-lasten"
							>{data.proposals}
							{data.proposals === 1 ? 'voorstel' : 'voorstellen'} voor vaste lasten</a
						>
					{/if}
				</p>
			{/if}
		</section>
	{/if}

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
			<div class="links">
				{#if data.owed.toReceiveCents > 0}
					<a href="/te-krijgen">{`${formatCents(data.owed.toReceiveCents)} te krijgen`}</a>
				{/if}
				{#if data.reviewCount > 0}
					<a href="/transacties?status=te_controleren">{data.reviewCount} te controleren</a>
				{/if}
			</div>
		</div>
		<div
			class={['recent-list', threads.lanes > 0 && 'threaded']}
			style:--gutter="{threadGutter(threads.lanes)}px"
		>
			{#if threads.lanes > 0}<LinkThreads layout={threads} />{/if}
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
					<li data-tx-row={tx.id}>
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
		</div>
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

	{#if toast}
		{#key toast.key}<Toast text={toast.text} error={toast.error} />{/key}
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

	.links {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0 14px;
	}

	.links a {
		font-variant-numeric: tabular-nums;
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
	}

	.fixed,
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

	.recent-list {
		position: relative;
	}

	/* Links een strook voor de draden; die loopt een stukje de rand van de pagina in */
	.recent-list.threaded {
		margin-left: -8px;
		padding-left: var(--gutter);
	}

	.none {
		padding: 12px 0;
	}

	.expected {
		padding: 0 16px;
	}

	.receipt {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: var(--tap);
		padding: 10px 0;
	}

	.receipt .who {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
		color: inherit;
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	.receipt .name {
		font-weight: 550;
	}

	.receipt .in {
		color: var(--accent-strong);
		font-weight: 600;
		white-space: nowrap;
	}

	.small {
		font-size: 0.88rem;
	}

	.button.small {
		min-height: var(--tap);
		padding: 0 14px;
		font-size: 0.92rem;
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

		/* Meldingen over de volle breedte, boven de twee kolommen */
		.top,
		.fixed,
		.reminder {
			grid-column: 1 / -1;
		}
	}
</style>
