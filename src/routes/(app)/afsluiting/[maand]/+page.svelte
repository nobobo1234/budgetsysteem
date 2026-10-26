<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import StackedBar from '#lib/components/StackedBar.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { lastDayOf, monthName, outcomeWords, type OpenItem } from '#lib/closing.ts';
	import { formatDayMonth, formatShortDate, shiftMonth } from '#lib/dates.ts';
	import { afsluiting } from '#lib/icons-extra.ts';
	import { formatCents } from '#lib/money.ts';
	import { displayName } from '#lib/text.ts';

	// Maandafsluiting (spec: Analyses → Maandafsluiting, Schermen): wat er nog openstaat, waar het
	// geld heen ging, en voorstellen voor de limieten van de nieuwe maand. Een afgesloten maand
	// toont de momentopname, met wat er sindsdien veranderd is.

	let { data } = $props();
	const p = $derived(data.page);
	const c = $derived(p.content);
	const name = $derived(monthName(p.month));
	const lower = $derived(name.toLowerCase());
	const words = $derived(outcomeWords(c.outcome));
	const nextName = $derived(monthName(shiftMonth(p.month, 1)).toLowerCase());
	const euro = (cents: number) => formatCents(cents, { whole: Math.abs(cents) >= 10_000 });
	const whole = (cents: number) => formatCents(cents, { whole: true });
	const categoryName = (id: string) => c.categories.find((l) => l.categoryId === id)?.name ?? '';

	let toast = $state<{ text: string; error: boolean; key: number } | null>(null);
	const notify = (text: string, error = false) => (toast = { text, error, key: Date.now() });
	let busy = $state<string | null>(null);
	const act =
		(key: string, done: string): SubmitFunction =>
		() => {
			busy = key;
			return async ({ result, update }) => {
				busy = null;
				if (result.type === 'success') {
					notify(done);
					await update();
					return;
				}
				const message = result.type === 'failure' ? result.data?.message : undefined;
				notify(
					typeof message === 'string' ? message : 'Dat lukte niet. Probeer het opnieuw.',
					true
				);
			};
		};

	// Open punten: bij een afgesloten maand de punten van toen, met wat er nu nog openstaat
	const stillOpen = $derived(new Set(p.open.map((o) => `${o.kind}:${o.id}`)));
	const openList = $derived(
		p.status === 'afgesloten'
			? p.openAtClose.map((o) => ({ ...o, solved: !stillOpen.has(`${o.kind}:${o.id}`) }))
			: p.open.map((o) => ({ ...o, solved: false }))
	);
	function openText(o: OpenItem): string {
		const who = displayName(o.name);
		switch (o.kind) {
			case 'verwacht':
				return `${who} wacht op bevestiging`;
			case 'bon':
				return o.name ? `Bon van ${who} nakijken` : 'Bon nakijken';
			case 'boeking':
				return `${who} controleren`;
			case 'aandeel':
				return `Aandeel van ${o.name} is te laat`;
			case 'tegoed':
				return `Tegoed van ${o.name}`;
			case 'herinnering':
				return `${o.name || 'Iemand'} betaalde nog niet terug`;
			case 'saldocheck':
				return `Saldocheck ${o.name} na ${formatDayMonth(lastDayOf(p.month))}`;
		}
	}

	// De balk: vaste lasten, reserveringen, dagelijks en wat over bleef, zoals op Budget. Lege
	// reserveringen of niets over laten we weg; vaste lasten en dagelijks staan er altijd.
	const segments = $derived(
		[
			{
				key: 'vast',
				label: 'Vaste lasten',
				cents: c.split.fixedCents,
				color: groupColor(p.fixedGroup) ?? undefined
			},
			{
				key: 'reserveringen',
				label: 'Reserveringen',
				cents: c.split.reservedCents,
				color: groupColor(p.fixedGroup) ?? undefined,
				hatched: true
			},
			{
				key: 'dagelijks',
				label: 'Dagelijks',
				cents: c.split.dailyCents,
				color: groupColor('Dagelijks') ?? undefined
			},
			{
				key: 'vrij',
				label: 'Over',
				cents: c.split.freeCents,
				color: 'color-mix(in oklch, var(--accent) 28%, var(--surface-2))'
			}
		].filter((x) => x.cents > 0 || x.key === 'vast' || x.key === 'dagelijks')
	);

	const cmp = $derived(c.comparison);
	const cmpLabel = $derived(
		cmp === null
			? ''
			: cmp.months === 1
				? 'de maand ervoor'
				: `het gemiddelde van de ${cmp.months === 3 ? 'drie' : 'twee'} maanden ervoor`
	);
	const cmpMax = $derived(cmp ? Math.max(cmp.totalCents, cmp.averageCents, 1) : 1);

	// Beweging: de kop per woord, dan het bedrag en de balk (closingMotion.ts). Na de eerste
	// weergave geladen; bij prefers-reduced-motion meteen het eindbeeld.
	let heading = $state<HTMLElement>();
	let barWrap = $state<HTMLElement>();
	let counted = $state<number | null>(null);
	$effect(() => {
		const el = heading;
		if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		let stop: (() => void) | undefined;
		let cancelled = false;
		const target = untrack(() => c.outcome.cents);
		// De balk zelf, zonder de legenda: die blijft staan
		const bar = untrack(() => barWrap?.querySelector<HTMLElement>('.track'));
		void import('#lib/closingMotion.ts')
			.then(({ playClosing }) =>
				playClosing({ heading: el, bar, target, count: (v) => (counted = v) })
			)
			.then((s) => {
				if (cancelled) s();
				else stop = s;
			})
			.catch(() => (counted = null));
		return () => {
			cancelled = true;
			stop?.();
		};
	});
	const amount = $derived(counted ?? c.outcome.cents);
</script>

<svelte:head>
	<title>{name} afsluiten · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<BackLink parents={['/', '/afsluiting']} labels={{ '/afsluiting': 'Afgesloten maanden' }} />
		{#key p.month}
			<h1 bind:this={heading} data-morph-head="titel">{name} {p.month.slice(0, 4)}</h1>
		{/key}
		{#if p.status === 'loopt'}
			<p class="tell">{name} loopt nog.</p>
		{:else if p.hasData}
			<p class="tell">
				{words.before} <span class="num amount">{whole(amount)}</span>
				{words.after}
			</p>
			{#if p.status === 'afgesloten' && p.closedAt}
				<p class="muted">
					Afgesloten op {formatDayMonth(p.closedAt.slice(0, 10))}.
					{#if p.change && p.change.totalCents !== 0}
						<span class="changed">
							Sinds afsluiten veranderd:
							<strong class="num">{euro(Math.abs(p.change.totalCents))}</strong>
							{p.change.totalCents > 0 ? 'meer' : 'minder'} uitgegeven{#if p.change.categories[0]},
								vooral in {p.change.categories[0].name}{/if}.
						</span>
					{:else if p.change && p.change.categories.length > 0}
						<span class="changed">Sinds afsluiten is de verdeling over categorieën veranderd.</span>
					{/if}
				</p>
			{:else if p.open.length === 0}
				<p class="muted">Niets meer open: de cijfers van {lower} kloppen.</p>
			{/if}
		{/if}
	</div>

	{#if p.status === 'loopt'}
		<div class="card">
			<EmptyState
				icon={afsluiting}
				text="Vanaf 1 {nextName} staat de afsluiting van {lower} klaar. Tot die tijd houd je hem bij op het overzicht."
			>
				<a class="button secondary" href="/">Naar het overzicht</a>
			</EmptyState>
		</div>
	{:else if !p.hasData}
		<div class="card">
			<EmptyState
				icon={afsluiting}
				text="Over {lower} is nog niets bekend. Importeer een export van de bank, dan staat hier waar het geld heen ging."
			>
				<a class="button secondary" href="/import">Export importeren</a>
			</EmptyState>
		</div>
	{:else}
		{#if openList.length > 0}
			<section class="card open" aria-labelledby="open-title">
				<div class="section-head">
					<h2 id="open-title">
						{p.status === 'afgesloten' ? 'Open bij het afsluiten' : 'Nog open'}
					</h2>
					<p class="muted num">{openList.length}</p>
				</div>
				<p class="muted">
					{p.status === 'afgesloten'
						? 'Deze punten stonden open toen je de maand afsloot.'
						: 'Zolang dit openstaat, kunnen de cijfers hieronder nog veranderen.'}
				</p>
				<ul class="rows">
					{#each openList as o (`${o.kind}:${o.id}`)}
						<li>
							{#if o.solved}
								<span class="row solved">
									<span class="check" aria-hidden="true">
										<svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" /></svg>
									</span>
									<span class="what">
										{openText(o)}
										<span class="muted">Opgelost</span>
									</span>
								</span>
							{:else}
								<a class="row" href={o.href}>
									<span class="dot" aria-hidden="true"></span>
									<span class="what">
										{openText(o)}
										{#if o.date}<span class="muted">{formatShortDate(o.date)}</span>{/if}
									</span>
									{#if o.amountCents !== null}
										<span class="num amount-cell">{formatCents(o.amountCents)}</span>
									{/if}
									<svg class="chevron" viewBox="0 0 20 20" aria-hidden="true"
										><path d="M7.5 4.5L13 10l-5.5 5.5" /></svg
									>
								</a>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section class="card" aria-labelledby="split-title">
			<div class="section-head">
				<h2 id="split-title">Limiet en uitgaven</h2>
				{#if c.totalLimitCents > 0}
					<p class="muted num">{whole(c.totalLimitCents)} aan limieten</p>
				{/if}
			</div>
			<div class="bar" bind:this={barWrap}>
				<StackedBar
					label="Uitgaven van {lower}"
					total={Math.max(c.totalLimitCents, c.totalSpentCents)}
					{segments}
				/>
			</div>
			{#if c.freeCents < 0}
				<p class="over">
					<span class="num">{whole(-c.freeCents)}</span> boven je limieten.
				</p>
			{/if}
		</section>

		{#if p.extremes.over.length > 0 || p.extremes.left.length > 0}
			<div class="pair">
				{#if p.extremes.over.length > 0}
					<section class="card" aria-labelledby="over-title">
						<h2 id="over-title">Over de limiet</h2>
						<ul class="list">
							{#each p.extremes.over as l (l.categoryId)}
								<li>
									<span class="cat-dot" style:--c={groupColor(l.group)} aria-hidden="true"></span>
									<span class="what">{l.name}</span>
									<span class="num warn">{euro(l.diffCents)} te veel</span>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
				{#if p.extremes.left.length > 0}
					<section class="card" aria-labelledby="left-title">
						<h2 id="left-title">Meeste over</h2>
						<ul class="list">
							{#each p.extremes.left as l (l.categoryId)}
								<li>
									<span class="cat-dot" style:--c={groupColor(l.group)} aria-hidden="true"></span>
									<span class="what">{l.name}</span>
									<span class="num">{euro(l.diffCents)} over</span>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</div>
		{/if}

		{#if cmp}
			{@const diff = cmp.totalCents - cmp.averageCents}
			<section class="card" aria-labelledby="cmp-title">
				<h2 id="cmp-title">Tegenover eerder</h2>
				<p>
					{name} kostte <strong class="num">{whole(cmp.totalCents)}</strong>,
					{#if diff === 0}
						precies zoveel als {cmpLabel}.
					{:else}
						<span class="num">{whole(Math.abs(diff))}</span>
						{diff > 0 ? 'meer' : 'minder'} dan {cmpLabel}
						(<span class="num">{whole(cmp.averageCents)}</span>).
					{/if}
				</p>
				<div class="compare" aria-hidden="true">
					<span class="label">{name}</span>
					<span class="track"><span style:--len={cmp.totalCents / cmpMax}></span></span>
					<span class="label">Eerder</span>
					<span class="track before"><span style:--len={cmp.averageCents / cmpMax}></span></span>
				</div>
				{#if cmp.riser || cmp.faller}
					<dl class="movers">
						{#if cmp.riser}
							<div>
								<dt class="muted">Grootste stijger</dt>
								<dd>
									{categoryName(cmp.riser.categoryId)},
									<span class="num">{euro(cmp.riser.diffCents)}</span> meer
								</dd>
							</div>
						{/if}
						{#if cmp.faller}
							<div>
								<dt class="muted">Grootste daler</dt>
								<dd>
									{categoryName(cmp.faller.categoryId)},
									<span class="num">{euro(-cmp.faller.diffCents)}</span> minder
								</dd>
							</div>
						{/if}
					</dl>
				{/if}
			</section>
		{/if}

		<div class="pair">
			<section class="card figure" aria-labelledby="owed-title">
				<div class="section-head">
					<h2 id="owed-title">Te krijgen</h2>
					<a class="more-link" href="/te-krijgen">Bekijken</a>
				</div>
				<p class="big num">{euro(c.owedCents)}</p>
				<p class="muted">
					{c.owedCents > 0
						? `Stond aan het eind van ${lower} nog open.`
						: `Aan het eind van ${lower} stond niets open.`}
				</p>
			</section>
			<section class="card figure" aria-labelledby="res-title">
				<h2 id="res-title">Reserveringen</h2>
				<p class="big num">{euro(c.split.reservedCents)}</p>
				{#if c.reservations.length > 0}
					<ul class="list">
						{#each c.reservations as r (r.recurringId)}
							<li>
								<span class="what">{displayName(r.counterparty)}</span>
								<span class="num">{euro(r.amountCents)}</span>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="muted">Er ging in {lower} niets opzij.</p>
				{/if}
			</section>
		</div>

		{#if p.proposals.length > 0}
			<section class="card" aria-labelledby="next-title">
				<h2 id="next-title">Limieten voor {nextName}</h2>
				<p class="muted">
					Een tik neemt het voorstel over; de andere limieten blijven zoals ze zijn.
				</p>
				<ul class="proposals">
					{#each p.proposals as s (s.categoryId)}
						<li>
							<span class="cat-dot" style:--c={groupColor(s.group)} aria-hidden="true"></span>
							<span class="what">
								{s.name}
								<span class="num change">
									<span class="muted">{whole(s.fromCents)}</span>
									<span aria-hidden="true">→</span><span class="visually-hidden">wordt</span>
									{whole(s.toCents)}
								</span>
								<span class="muted">
									{s.reason === 'over'
										? 'drie maanden over de limiet'
										: 'drie maanden onder 70% van de limiet'}
								</span>
							</span>
							<form
								method="POST"
								action="?/proposal"
								use:enhance={act(s.categoryId, `Limiet van ${s.name} aangepast.`)}
							>
								<input type="hidden" name="categoryId" value={s.categoryId} />
								<button
									class="button secondary"
									disabled={busy !== null}
									aria-label="Voorstel voor {s.name} overnemen">Overnemen</button
								>
							</form>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if p.status === 'klaar'}
			<section class="card close" aria-labelledby="close-title">
				<h2 id="close-title">Klaar met {lower}?</h2>
				<p class="muted">
					{p.open.length > 0
						? 'Afsluiten kan ook met open punten: ze blijven bij de afsluiting zichtbaar.'
						: 'Afsluiten legt deze cijfers vast. Komt er later nog iets bij, dan zie je het verschil.'}
				</p>
				<form method="POST" action="?/close" use:enhance={act('close', `${name} afgesloten.`)}>
					<button class="button" disabled={busy !== null}>Maand afsluiten</button>
				</form>
			</section>
		{/if}
	{/if}

	{#if toast}
		{#key toast.key}<Toast text={toast.text} error={toast.error} />{/key}
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 44rem;
	}

	.intro {
		display: grid;
		gap: 8px;
	}

	.tell {
		font-size: 1.3rem;
	}

	.amount {
		font-weight: 650;
		font-style: normal;
	}

	.changed {
		color: var(--text);
	}

	.card {
		display: grid;
		align-content: start;
		gap: 14px;
		padding: 20px;
	}

	.section-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 4px 12px;
	}

	.rows,
	.list,
	.proposals {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rows li + li,
	.proposals li + li {
		border-top: 1px solid var(--line);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: var(--tap);
		padding: 10px 0;
		color: var(--text);
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	.row:active {
		transform: scale(0.98);
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--warn);
	}

	.check {
		display: grid;
		place-items: center;
		flex: none;
		width: 20px;
		height: 20px;
		margin-left: -6px;
		color: var(--accent-strong);
	}

	.check svg {
		width: 20px;
		height: 20px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.what {
		display: grid;
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.what .muted {
		font-size: 0.88rem;
	}

	.solved .what {
		color: var(--muted);
	}

	.amount-cell {
		white-space: nowrap;
	}

	.chevron {
		flex: none;
		width: 18px;
		height: 18px;
		fill: none;
		stroke: var(--muted);
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	/* De balk vult van links (closingMotion.ts animeert alleen `transform`) */
	.bar :global(.track) {
		will-change: transform;
	}

	/* Tekst in oranje haalt geen AA; over de limiet staat daarom rustig rood, zoals op Budget */
	.over,
	.warn {
		color: var(--danger);
		font-weight: 550;
	}

	.pair {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
	}

	@media (min-width: 640px) {
		.pair {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.list li {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 36px;
	}

	.list .num {
		white-space: nowrap;
	}

	.cat-dot {
		flex: none;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--c, transparent);
		box-shadow: inset 0 0 0 1.5px var(--c, var(--muted));
	}

	.compare {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 8px 12px;
		font-size: 0.88rem;
	}

	.compare .label {
		color: var(--muted);
	}

	.compare .track {
		height: 10px;
		border-radius: 999px;
		background: var(--surface-2);
		overflow: hidden;
	}

	.compare .track span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
		transform: scaleX(var(--len));
		transform-origin: left center;
		transition: transform 600ms var(--ease-out);
	}

	.compare .before span {
		background: color-mix(in oklch, var(--accent) 35%, var(--surface-2));
	}

	.movers {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
		gap: 12px;
		margin: 0;
	}

	.movers dt {
		font-size: 0.88rem;
	}

	.movers dd {
		margin: 0;
	}

	.figure .big {
		font-size: 1.75rem;
		font-weight: 650;
		letter-spacing: -0.01em;
		line-height: 1.1;
	}

	.proposals li {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 0;
	}

	.proposals .cat-dot {
		align-self: flex-start;
		margin-top: 7px;
	}

	.change {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		white-space: nowrap;
		font-weight: 600;
	}

	.close {
		justify-items: start;
	}

	@media (prefers-reduced-motion: reduce) {
		.compare .track span {
			transition: none;
		}
	}
</style>
