<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { recordEntry } from '#lib/usage.ts';
	import { refreshAll } from '$app/navigation';
	import { fly } from 'svelte/transition';
	import { FIXED_GROUP, homeBars, monthStory, storySentence } from '#lib/budget.ts';
	import { groupColor, groupHue } from '#lib/categoryColor.ts';
	import BudgetBar from '#lib/components/BudgetBar.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import ExpectedItem from '#lib/components/ExpectedItem.svelte';
	import HeroAmount from '#lib/components/HeroAmount.svelte';
	import LinkThreads, { threadGutter } from '#lib/components/LinkThreads.svelte';
	import MonthLine from '#lib/components/MonthLine.svelte';
	import QuickEntry from '#lib/components/QuickEntry.svelte';
	import SignalCard from '#lib/components/SignalCard.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import TransactionItem from '#lib/components/TransactionItem.svelte';
	import { daysInMonth, formatMonth, formatShortDate, fromIsoDate } from '#lib/dates.ts';
	import * as icons from '#lib/icons.ts';
	import { formatCents } from '#lib/money.ts';
	import { flush, type QueuedTransaction } from '#lib/offline/queue.ts';
	import { sync } from '#lib/offline/sync.svelte.ts';
	import { motion } from '#lib/motion.ts';
	import { threadLayout } from '#lib/refund.ts';
	import { displayName, initials } from '#lib/text.ts';

	let { data } = $props();

	const hasBudget = $derived(data.overview.totalLimitCents > 0);
	const day = $derived(Number(data.today.slice(8, 10)));
	const days = $derived(daysInMonth(data.overview.month));
	const story = $derived(monthStory(data.overview.lines, data.overview.freeCents, day, days));
	const bars = $derived(homeBars(data.overview.lines, day, days));
	const category = (id: string | null) => data.context.categories.find((c) => c.id === id);
	const accountAlias = (id: string) => data.context.accounts.find((a) => a.id === id)?.alias ?? '';

	// Optimistisch: wat in de wachtrij staat verschijnt meteen bovenaan
	const recentIds = $derived(new Set(data.recent.map((t) => t.id)));
	const queued = $derived(sync.pending.filter((p) => !recentIds.has(p.payload.id)));
	// Terugbetalingen met hun uitgave verbonden, als die ook bij Recent staat
	const threads = $derived(threadLayout(data.recent));

	let toast = $state<{ text: string; error: boolean; key: number } | null>(null);
	const notify = (text: string, error = false) => (toast = { text, error, key: Date.now() });

	// Signaalkaartjes: wat op je wacht, alleen als er iets is (spec: Startscherm)
	interface Signal {
		href: string;
		icon: icons.IconDef;
		big: string;
		small: string;
		morph?: 'bedrag' | 'titel';
		warn?: boolean;
	}
	const plural = (n: number, one: string, more: string) => (n === 1 ? one : more);
	const signals = $derived.by(() => {
		const all: (Signal | false)[] = [
			data.owed.toReceiveCents > 0 && {
				href: '/te-krijgen',
				icon: icons.teKrijgen,
				big: formatCents(data.owed.toReceiveCents),
				small: `te krijgen van ${data.owed.people} ${plural(data.owed.people, 'persoon', 'personen')}`,
				morph: 'bedrag'
			},
			data.reviewCount > 0 && {
				href: '/te-controleren',
				icon: icons.controleren,
				big: String(data.reviewCount),
				small: 'te controleren',
				morph: 'bedrag'
			},
			data.balanceCheckDue.length > 0 && {
				href: '/saldocheck',
				icon: icons.saldocheck,
				big: 'Saldocheck',
				small: `nog te doen voor ${data.balanceCheckDue.map((a) => a.name).join(' en ')}`,
				morph: 'titel',
				warn: true
			},
			data.proposals > 0 && {
				href: '/vaste-lasten',
				icon: icons.vasteLasten,
				big: String(data.proposals),
				small: plural(
					data.proposals,
					'voorstel voor een vaste last',
					'voorstellen voor vaste lasten'
				)
			}
		];
		return all.filter((s): s is Signal => s !== false);
	});

	// Te bevestigen: de eerste drie, de rest op verzoek; gemiste posten als eigen groep
	const FIRST = 3;
	type Entry =
		| { kind: 'vast'; key: string; date: string; item: (typeof data.expected)[number] }
		| { kind: 'ontvangen'; key: string; date: string; item: (typeof data.receipts)[number] };
	const entries = $derived<Entry[]>(
		[
			...data.expected
				.filter((e) => !e.missed)
				.map((item) => ({ kind: 'vast' as const, key: item.id, date: item.date, item })),
			...data.receipts.map((item) => ({
				kind: 'ontvangen' as const,
				key: item.id,
				date: item.dueDate,
				item
			}))
		].sort((a, b) => a.date.localeCompare(b.date))
	);
	const missed = $derived(data.expected.filter((e) => e.missed));
	let showAll = $state(false);
	let showMissed = $state(false);
	const visible = $derived(showAll ? entries : entries.slice(0, FIRST));
	const waiting = $derived(entries.length + missed.length);
	const showFixed = $derived(waiting > 0 || data.upcoming.length > 0);

	const weekday = new Intl.DateTimeFormat('nl-NL', { weekday: 'short' });
	const dayParts = (iso: string) => ({
		day: Number(iso.slice(8, 10)),
		weekday: weekday.format(fromIsoDate(iso)).replace('.', '')
	});

	// Eén tik "ontvangen" voor een aandeel in een gedeelde vaste last
	let receiving = $state<string | null>(null);
	const receive: SubmitFunction = ({ formData }) => {
		receiving = String(formData.get('id'));
		const item = data.receipts.find((r) => r.id === receiving);
		return async ({ result, update }) => {
			receiving = null;
			if (result.type === 'success') {
				recordEntry('verwacht');
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
			<section class="hero" aria-label="Deze maand">
				<HeroAmount
					cents={data.overview.freeCents}
					label="Nog vrij in {formatMonth(data.overview.month)}"
				/>
				<MonthLine
					{story}
					spentCents={data.overview.totalLimitCents - data.overview.freeCents}
					over={data.overview.freeCents < 0}
				/>
				<p class="story tell">{storySentence(story, data.overview.freeCents)}</p>
			</section>
		{:else}
			<section class="empty" aria-labelledby="empty-title">
				<h1 id="empty-title">Nog geen budget</h1>
				<EmptyState
					icon={icons.budget}
					text="Stel limieten per categorie in, dan zie je hier wat je nog vrij hebt."
					compact
				>
					<a class="button secondary" href="/budget">Budget instellen</a>
				</EmptyState>
			</section>
		{/if}

		<QuickEntry context={data.context} onsaved={saved} suggestions={data.suggestions} />
	</div>

	{#if signals.length > 0}
		<ul class="signals" aria-label="Wacht op je">
			{#each signals as signal (signal.href)}
				<li>
					<SignalCard {...signal} />
				</li>
			{/each}
		</ul>
	{/if}

	{#if showFixed}
		<section class="fixed" aria-labelledby="fixed-title">
			<div class="head">
				<div class="title">
					<h2 id="fixed-title">{waiting > 0 ? 'Te bevestigen' : 'Later deze maand'}</h2>
					{#if waiting > 0}<span class="count num" aria-label="{waiting} posten">{waiting}</span
						>{/if}
				</div>
				<a class="more-link" href="/vaste-lasten">Vaste lasten</a>
			</div>

			{#if visible.length > 0}
				<ul class="card expected">
					{#each visible as entry (entry.key)}
						<li
							class={entry.kind === 'ontvangen' ? 'receipt' : undefined}
							in:fly={{ y: -10, duration: motion(220) }}
							out:fly={{ x: 32, duration: motion(220) }}
						>
							{#if entry.kind === 'vast'}
								<ExpectedItem item={entry.item} ondone={notify} />
							{:else}
								{@const item = entry.item}
								<span
									class="monogram sm hue"
									style:--h={groupHue(item.personName)}
									aria-hidden="true">{initials(item.personName)}</span
								>
								<a class="who" href="/terugbetalingen">
									<span class="name">{item.personName}</span>
									<span class="muted small">
										{displayName(item.counterparty)} · verwacht {formatShortDate(
											item.dueDate
										)}{item.late ? ' · te laat' : ''}
									</span>
								</a>
								<span class="num in">+{formatCents(item.outstandingCents)}</span>
								<form method="POST" action="?/received" use:enhance={receive}>
									<input type="hidden" name="id" value={item.id} />
									<button
										class="button secondary small"
										disabled={receiving === item.id}
										aria-label="{formatCents(
											item.outstandingCents
										)} van {item.personName} ontvangen">Ontvangen</button
									>
								</form>
							{/if}
						</li>
					{/each}
					{#if entries.length > FIRST}
						<li class="toggle">
							<button type="button" class="show-more" onclick={() => (showAll = !showAll)}>
								{showAll ? 'Minder tonen' : `Nog ${entries.length - FIRST} meer`}
								<svg class={['chevron', showAll && 'open']} viewBox="0 0 20 20" aria-hidden="true"
									><path d="M5.5 7.5 10 12l4.5-4.5" /></svg
								>
							</button>
						</li>
					{/if}
				</ul>
			{/if}

			{#if missed.length > 0}
				<div class="card missed-group">
					<button
						type="button"
						class="show-more missed-toggle"
						aria-expanded={showMissed}
						aria-controls="missed-list"
						onclick={() => (showMissed = !showMissed)}
					>
						<span class="badge">{missed.length}</span>
						<span class="label"
							>Gemist of opgezegd?
							<span class="muted">Al meer dan een week niet afgeschreven</span></span
						>
						<svg class={['chevron', showMissed && 'open']} viewBox="0 0 20 20" aria-hidden="true"
							><path d="M5.5 7.5 10 12l4.5-4.5" /></svg
						>
					</button>
					{#if showMissed}
						<ul id="missed-list" class="expected">
							{#each missed as item (item.id)}
								<li
									in:fly={{ y: -10, duration: motion(220) }}
									out:fly={{ x: 32, duration: motion(220) }}
								>
									<ExpectedItem {item} ondone={notify} grouped />
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}

			{#if data.upcoming.length > 0}
				<div class="upcoming">
					{#if waiting > 0}<h3>Later deze maand</h3>{/if}
					<ul>
						{#each data.upcoming as item (item.id)}
							{@const d = dayParts(item.date)}
							<li>
								<a class="upcoming-row" href="/vaste-lasten/{item.recurringId}">
									<span class="date num" aria-label={formatShortDate(item.date)}>
										<span class="d">{d.day}</span><span class="wd">{d.weekday}</span>
									</span>
									<span class="what">
										<span
											class="name"
											data-morph-to="/vaste-lasten/{item.recurringId}"
											data-morph-part="titel">{displayName(item.counterparty)}</span
										>
										<span class="muted small">
											<span
												class={['dot', !item.categoryGroup && 'none']}
												style:--dot={item.categoryGroup ? groupColor(item.categoryGroup) : null}
											></span>
											{item.categoryName ?? 'Geen categorie'}
										</span>
									</span>
									<span class="num amount">{formatCents(item.amountCents, { sign: true })}</span>
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>
	{/if}

	<section class="recent" aria-labelledby="recent-title">
		<div class="head">
			<h2 id="recent-title">Recent</h2>
			<a class="more-link" href="/transacties">Alle transacties</a>
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
						<li class="none">
							<EmptyState
								icon={icons.transacties}
								text="Nog niets ingevoerd. Typ hierboven bijvoorbeeld 12,50 ah, of importeer je historie."
								compact
							>
								<a class="more-link" href="/import">Historie importeren</a>
							</EmptyState>
						</li>
					{/if}
				{/each}
			</ul>
		</div>
	</section>

	{#if bars.fixed || bars.top.length > 0}
		<section class="budget" aria-labelledby="budget-title">
			<div class="head">
				<h2 id="budget-title">Per categorie</h2>
				<a class="more-link" href="/budget">Budget</a>
			</div>
			<div class="bars">
				{#if bars.fixed}
					<BudgetBar name="Vaste lasten" group={FIXED_GROUP} {...bars.fixed} />
				{/if}
				{#each bars.top as line (line.categoryId)}
					<BudgetBar {...line} />
				{/each}
			</div>
			{#if bars.more > 0}
				<a class="more-link quiet" href="/budget"
					>Nog {bars.more} {plural(bars.more, 'categorie', 'categorieën')}</a
				>
			{/if}
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

	.hero {
		display: grid;
		gap: 14px;
	}

	/* De zin onder het getal: het verhaal van de maand, vertellend in Fraunces italic */
	.story {
		font-size: 1.2rem;
		max-width: 34ch;
	}

	.empty {
		display: grid;
		gap: 12px;
		justify-items: start;
	}

	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}

	.head .more-link {
		margin-right: -4px;
	}

	.title {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.count {
		display: inline-grid;
		place-items: center;
		min-width: 26px;
		height: 26px;
		padding: 0 8px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-strong);
		font-size: 0.88rem;
		font-weight: 650;
	}

	/* Signaalkaartjes */
	/* Op een telefoon een strook om te vegen, die tot de rand van het scherm loopt */
	.signals {
		list-style: none;
		margin: -20px -16px 0;
		padding: 4px 16px 10px;
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: minmax(150px, 1fr);
		gap: 10px;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scroll-snap-type: x mandatory;
		scroll-padding-inline: 16px;
		scrollbar-width: none;
	}

	.signals::-webkit-scrollbar {
		display: none;
	}

	.signals li {
		scroll-snap-align: start;
	}

	@container (min-width: 600px) {
		.signals {
			margin: -16px 0 0;
			padding: 0;
			grid-auto-flow: row;
			grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
			overflow: visible;
		}
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

	.signals li + li {
		border-top: 0;
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

	/* "Nog 4 meer" en de groep gemiste posten */
	.show-more {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		width: 100%;
		min-height: var(--tap);
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent-strong);
		font-weight: 600;
		cursor: pointer;
	}

	.toggle {
		padding: 2px 0;
	}

	.chevron {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 220ms var(--ease-spring);
	}

	.chevron.open {
		transform: rotate(180deg);
	}

	.missed-group {
		display: grid;
		padding: 4px 16px;
	}

	.missed-toggle {
		justify-content: flex-start;
		gap: 12px;
		padding: 8px 0;
		color: var(--text);
		text-align: left;
	}

	.missed-toggle .label {
		display: grid;
		flex: 1;
		font-weight: 600;
	}

	.missed-toggle .label .muted {
		font-size: 0.86rem;
		font-weight: 400;
	}

	.missed-toggle .badge {
		display: inline-grid;
		place-items: center;
		min-width: 28px;
		height: 28px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--warn) 22%, transparent);
		color: color-mix(in oklch, var(--warn) 60%, var(--text));
		font-weight: 650;
		font-size: 0.9rem;
	}

	.missed-group .expected {
		padding: 0;
		border-top: 1px solid var(--line);
	}

	/* Later deze maand: rustig, gestippeld, nog niet uitgegeven */
	.upcoming {
		display: grid;
		gap: 6px;
	}

	.upcoming h3 {
		margin-top: 8px;
		font-size: 1.05rem;
	}

	.upcoming-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 0;
		color: inherit;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	.upcoming-row:active {
		transform: scale(0.99);
	}

	.upcoming li + li {
		border-top-style: dashed;
	}

	.upcoming .date {
		display: grid;
		place-items: center;
		flex: none;
		width: 44px;
		height: 44px;
		border: 1px dashed var(--line);
		border-radius: 12px;
		line-height: 1;
	}

	.upcoming .d {
		font-weight: 650;
		font-size: 1.05rem;
	}

	.upcoming .wd {
		color: var(--muted);
		font-size: 0.72rem;
	}

	.upcoming .what {
		display: grid;
		flex: 1;
		min-width: 0;
	}

	.upcoming .name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.upcoming .small {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.86rem;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--dot);
	}

	.dot.none {
		background: none;
		box-shadow: inset 0 0 0 1.5px var(--muted);
	}

	.upcoming .amount {
		color: var(--muted);
		white-space: nowrap;
	}

	.bars {
		display: grid;
		gap: 18px;
	}

	.more-link.quiet {
		justify-self: start;
		margin-left: -12px;
		color: var(--muted);
		font-weight: 550;
	}

	@container (min-width: 900px) {
		.home {
			grid-template-columns: 1.1fr 1fr;
			column-gap: 56px;
		}

		/* Bovenaan over de volle breedte, daaronder twee kolommen */
		.top,
		.signals,
		.fixed {
			grid-column: 1 / -1;
		}

		.top {
			grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
			column-gap: 56px;
			align-items: end;
		}
	}
</style>
