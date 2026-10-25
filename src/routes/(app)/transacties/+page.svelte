<script lang="ts">
	import { tick } from 'svelte';
	import { navigating } from '$app/state';
	import LinkThreads, { threadGutter } from '#lib/components/LinkThreads.svelte';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import TransactionItem from '#lib/components/TransactionItem.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatDayHeading, formatMonth, formatShortDate } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';
	import { threadLayout } from '#lib/refund.ts';

	let { data } = $props();

	let form: HTMLFormElement;
	let searchInput: HTMLInputElement;
	// Schrijfbaar: volgt de server, en ook wat je typt (voor de wis-knop)
	let query = $derived(data.filter.q);

	// Rekening en periode komen alleen via een link (vanuit de saldocheck); ze blijven bij het filteren
	const rangeFilter = $derived(!!(data.filter.accountId || data.filter.from || data.filter.to));
	const rangeLabel = $derived(
		[
			data.accountName,
			data.filter.from || data.filter.to
				? `${data.filter.from ? formatShortDate(data.filter.from) : '…'} – ${data.filter.to ? formatShortDate(data.filter.to) : '…'}`
				: ''
		]
			.filter(Boolean)
			.join(' · ')
	);

	const PAGE = 50;
	const hasFilter = $derived(
		!!(
			data.filter.q ||
			data.filter.month ||
			data.filter.categoryId ||
			data.filter.status ||
			rangeFilter
		)
	);
	const pages = $derived(Math.max(1, Math.ceil(data.summary.count / PAGE)));
	const busy = $derived(navigating.to?.url.pathname === '/transacties');

	const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

	const monthOptions = $derived.by((): SelectOption[] => {
		const months =
			data.months.includes(data.filter.month) || !data.filter.month
				? data.months
				: [data.filter.month, ...data.months];
		return [
			{ value: '', label: 'Alle maanden' },
			...months.map((m) => ({
				value: m,
				label: capitalize(formatMonth(m)),
				group: m.slice(0, 4)
			}))
		];
	});

	const categoryOptions = $derived<SelectOption[]>([
		{ value: '', label: 'Alle categorieën' },
		{ value: 'geen', label: 'Zonder categorie', dot: null },
		...data.categories.map((c) => ({
			value: c.id,
			label: c.name,
			group: c.group,
			dot: groupColor(c.group)
		}))
	]);

	// Per dag, met het saldo van die dag ernaast
	const days = $derived.by(() => {
		const out: { date: string; net: number; items: typeof data.transactions }[] = [];
		for (const tx of data.transactions) {
			const last = out.at(-1);
			if (last && last.date === tx.date) {
				last.items.push(tx);
				last.net += tx.amountCents;
			} else out.push({ date: tx.date, net: tx.amountCents, items: [tx] });
		}
		return out;
	});

	// Draden tussen terugbetalingen en hun uitgave op deze pagina
	const threads = $derived(threadLayout(data.transactions));

	const pageHref = (p: number) => {
		const parts: [string, string][] = [
			['q', data.filter.q],
			['maand', data.filter.month],
			['categorie', data.filter.categoryId],
			['status', data.filter.status ?? ''],
			['rekening', data.filter.accountId],
			['van', data.filter.from],
			['tot', data.filter.to],
			['pagina', p > 0 ? String(p) : '']
		];
		const q = parts
			.filter(([, v]) => v)
			.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
			.join('&');
		return `?${q}`;
	};

	// Zonder rekening en periode, met de rest van het filter
	const rangeOffHref = $derived.by(() => {
		const parts: [string, string][] = [
			['q', data.filter.q],
			['maand', data.filter.month],
			['categorie', data.filter.categoryId],
			['status', data.filter.status ?? '']
		];
		const q = parts
			.filter(([, v]) => v)
			.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
			.join('&');
		return q ? `?${q}` : '/transacties';
	});

	async function submit() {
		// Eerst de nieuwe waarde in het verborgen veld laten landen
		await tick();
		form.requestSubmit();
	}

	function clearSearch() {
		query = '';
		searchInput.value = '';
		void submit();
		searchInput.focus();
	}
</script>

<svelte:head>
	<title>Transacties · Budget</title>
</svelte:head>

<div class="page">
	<h1>{data.filter.status ? 'Te controleren' : 'Transacties'}</h1>

	<form
		bind:this={form}
		method="GET"
		class="filters"
		role="search"
		data-sveltekit-keepfocus
		data-sveltekit-replacestate
		data-sveltekit-noscroll
	>
		<div class="searchfield">
			<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">
				<circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="1.7" />
				<path d="M13 13l4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
			</svg>
			<input
				bind:this={searchInput}
				type="search"
				name="q"
				value={data.filter.q}
				oninput={(e) => (query = e.currentTarget.value)}
				aria-label="Zoeken"
				placeholder="Zoek op naam of notitie"
				maxlength="100"
				enterkeyhint="search"
				autocomplete="off"
			/>
			{#if query}
				<button type="button" class="clear" aria-label="Zoekterm wissen" onclick={clearSearch}>
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" />
					</svg>
				</button>
			{/if}
			<button class="go" aria-label="Zoeken">
				<svg viewBox="0 0 20 20" aria-hidden="true">
					<path
						d="M4 10h11M11 5.5l4.5 4.5-4.5 4.5"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
			</button>
		</div>
		<Select
			name="maand"
			label="Maand"
			value={data.filter.month}
			options={monthOptions}
			onchange={submit}
		/>
		<Select
			name="categorie"
			label="Categorie"
			value={data.filter.categoryId}
			options={categoryOptions}
			onchange={submit}
		/>
		{#if data.filter.status}<input type="hidden" name="status" value={data.filter.status} />{/if}
		{#if data.filter.accountId}<input
				type="hidden"
				name="rekening"
				value={data.filter.accountId}
			/>{/if}
		{#if data.filter.from}<input type="hidden" name="van" value={data.filter.from} />{/if}
		{#if data.filter.to}<input type="hidden" name="tot" value={data.filter.to} />{/if}
	</form>

	{#if data.transactions.length > 0 || hasFilter}
		<div class="summary" aria-live="polite">
			<p>
				<span class="num">{data.summary.count}</span>
				{data.summary.count === 1 ? 'transactie' : 'transacties'}
				{#if data.summary.outCents < 0}
					<span class="sep" aria-hidden="true">·</span>
					<span class="num">{formatCents(data.summary.outCents, { whole: true })}</span> uit
				{/if}
				{#if data.summary.inCents > 0}
					<span class="sep" aria-hidden="true">·</span>
					<span class="num in"
						>{formatCents(data.summary.inCents, { whole: true, sign: true })}</span
					> in
				{/if}
			</p>
			{#if data.filter.status}
				<a class="tag" href="/transacties" aria-label="Filter te controleren weghalen">
					Te controleren
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" />
					</svg>
				</a>
			{/if}
			{#if rangeFilter}
				<a class="tag range" href={rangeOffHref} aria-label="Filter {rangeLabel} weghalen">
					{rangeLabel}
					<svg viewBox="0 0 16 16" aria-hidden="true">
						<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" />
					</svg>
				</a>
			{/if}
			{#if hasFilter}<a href="/transacties" class="reset">Filters wissen</a>{/if}
		</div>
	{/if}

	{#if data.transactions.length === 0}
		<div class="empty card">
			{#if rangeFilter && !data.filter.q}
				<h2>Geen boekingen in deze periode</h2>
				<p class="muted">
					Mis je een uitgave, voer hem dan in op het overzicht of importeer een export van de bank.
				</p>
				<div class="actions">
					<a class="button" href="/">Uitgave invoeren</a>
					<a class="button secondary" href="/import">Export importeren</a>
				</div>
			{:else if hasFilter}
				<h2>Niets gevonden{data.filter.q ? ` voor "${data.filter.q}"` : ''}.</h2>
				<p class="muted">Probeer een ander woord, of zoek in alle maanden en categorieën.</p>
				<a class="button secondary" href="/transacties">Filters wissen</a>
			{:else}
				<h2>Nog geen transacties</h2>
				<p class="muted">
					Importeer je SNS-historie, of voer een uitgave in op het overzicht, zoals
					<strong>12,50 ah</strong>.
				</p>
				<div class="actions">
					<a class="button" href="/import">Historie importeren</a>
					<a class="button secondary" href="/">Naar het overzicht</a>
				</div>
			{/if}
		</div>
	{:else}
		<div
			class={['days', busy && 'busy', threads.lanes > 0 && 'threaded']}
			style:--gutter="{threadGutter(threads.lanes)}px"
			aria-busy={busy}
		>
			{#if threads.lanes > 0}<LinkThreads layout={threads} />{/if}
			{#each days as day (day.date)}
				<section class="day" aria-labelledby="day-{day.date}">
					<header>
						<h2 id="day-{day.date}">{formatDayHeading(day.date, data.today)}</h2>
						<span class={['num', 'net', day.net > 0 && 'in']}>
							{formatCents(day.net, { sign: true })}
						</span>
					</header>
					<ul>
						{#each day.items as tx (tx.id)}
							<li data-tx-row={tx.id}>
								<TransactionItem {tx} href="/transacties/{tx.id}" showDate={false} />
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>

		{#if pages > 1}
			<nav class="pager" aria-label="Pagina's">
				{#if data.page > 0}
					<a class="button secondary" href={pageHref(data.page - 1)}>Nieuwer</a>
				{:else}
					<span></span>
				{/if}
				<span class="muted num">Pagina {data.page + 1} van {pages}</span>
				{#if data.hasMore}
					<a class="button secondary" href={pageHref(data.page + 1)}>Ouder</a>
				{:else}
					<span></span>
				{/if}
			</nav>
		{/if}
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 48rem;
	}

	.filters {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.searchfield {
		grid-column: 1 / -1;
		position: relative;
		display: flex;
		align-items: center;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--surface);
	}

	.searchfield:focus-within {
		border-color: var(--focus);
		box-shadow: 0 0 0 3px var(--accent-soft);
	}

	.icon {
		flex: none;
		width: 20px;
		height: 20px;
		margin-left: 14px;
		color: var(--muted);
	}

	.searchfield input {
		flex: 1;
		min-height: 48px;
		padding: 0 6px 0 10px;
		border: 0;
		background: transparent;
		outline: none;
	}

	.searchfield input::-webkit-search-cancel-button {
		display: none;
	}

	.clear,
	.go {
		flex: none;
		display: grid;
		place-items: center;
		width: var(--tap);
		height: var(--tap);
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.clear svg {
		width: 14px;
		height: 14px;
	}

	.go {
		margin-right: 2px;
		background: var(--accent);
		color: var(--on-accent);
		transform: scale(0.86);
		transition: transform 160ms var(--ease-spring);
	}

	.go:active {
		transform: scale(0.78);
	}

	.go svg {
		width: 20px;
		height: 20px;
	}

	@container (min-width: 700px) {
		.filters {
			grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr);
		}

		.searchfield {
			grid-column: auto;
		}
	}

	.summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 14px;
		margin-top: -4px;
		color: var(--muted);
		font-size: 0.95rem;
	}

	.summary p {
		margin-right: auto;
	}

	.summary .num {
		color: var(--text);
		font-weight: 600;
	}

	.summary .in,
	.net.in {
		color: var(--accent-strong);
	}

	.sep {
		margin: 0 4px;
		opacity: 0.6;
	}

	.tag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 32px;
		padding: 0 8px 0 12px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--warn) 22%, transparent);
		color: var(--text);
		font-weight: 550;
		text-decoration: none;
	}

	.tag.range {
		background: var(--accent-soft);
	}

	.tag svg {
		width: 16px;
		height: 16px;
	}

	.reset {
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
	}

	.days {
		position: relative;
		display: grid;
		gap: 8px;
		transition: opacity 160ms var(--ease-out);
	}

	/* Links een strook voor de draden; die loopt een stukje de rand van de pagina in */
	.threaded {
		margin-left: -8px;
	}

	.threaded .day header,
	.threaded .day ul {
		margin-left: var(--gutter);
	}

	/* Laadstaat bij een nieuwe zoekopdracht: de oude lijst blijft staan, maar zichtbaar oud */
	.days.busy {
		opacity: 0.45;
	}

	.day header {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		padding: 12px 0 6px;
		background: var(--bg);
		border-bottom: 1px solid var(--line);
	}

	@container (min-width: 900px) {
		.day header {
			top: 57px;
		}
	}

	.day h2 {
		font-size: 1.15rem;
	}

	.net {
		color: var(--muted);
		font-size: 0.9rem;
		font-weight: 550;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li + li {
		border-top: 1px solid var(--line);
	}

	.empty {
		display: grid;
		gap: 10px;
		justify-items: start;
		padding: 24px;
	}

	.empty h2 {
		font-size: 1.35rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 4px;
	}

	.pager {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		gap: 12px;
	}

	.pager > :last-child {
		justify-self: end;
	}

	.pager > :first-child {
		justify-self: start;
	}
</style>
