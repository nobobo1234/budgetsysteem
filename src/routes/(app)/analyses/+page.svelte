<script lang="ts">
	import * as icons from '#lib/icons.ts';
	import { navigating } from '$app/state';
	import AnalysesTabs from '#lib/components/AnalysesTabs.svelte';
	import Chart, { type Series } from '#lib/components/Chart.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import HeroAmount from '#lib/components/HeroAmount.svelte';
	import StackedBar, { type Segment } from '#lib/components/StackedBar.svelte';
	import Tile from '#lib/components/Tile.svelte';
	import { percent, ratio } from '#lib/analyses.ts';
	import { FIXED_GROUP } from '#lib/budget.ts';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatDayMonth, formatMonth } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';
	import { displayName, initials } from '#lib/text.ts';

	let { data } = $props();
	const a = $derived(data.analysis);
	const monthName = $derived(formatMonth(a.month).split(' ')[0]!);
	const busy = $derived(navigating.to?.url.pathname === '/analyses');
	const whole = (cents: number) => formatCents(cents, { whole: true });
	const empty = $derived(a.spentCents === 0 && a.lines.every((l) => l.limitCents === 0));

	// Uitgegeven per dag opgeteld, en vanaf vandaag de verwachting als stippellijn naar het eind
	const chart = $derived.by(() => {
		const days = Array.from({ length: a.daysInMonth }, (_, i) => i + 1);
		const spent: (number | null)[] = days.map((d) => a.cumulative[d - 1] ?? null);
		const series: Series[] = [
			{ label: 'Uitgegeven', values: spent, color: 'var(--accent)', kind: 'line' }
		];
		const f = a.forecast;
		if (f && a.day > 0) {
			const from = a.cumulative[a.day - 1] ?? 0;
			const left = a.daysInMonth - a.day;
			series.push({
				label: 'Verwachting',
				values: days.map((d) =>
					d < a.day ? null : left === 0 ? from : from + ((f.totalCents - from) * (d - a.day)) / left
				),
				color: 'var(--accent)',
				kind: 'line',
				dashed: true
			});
		}
		return {
			series,
			ticks: days.map(String),
			names: days.map((d) => `${d} ${monthName}`)
		};
	});

	// Verwachting tegenover de limieten, in één zin
	const sentence = $derived.by(() => {
		const total = a.forecast?.totalCents ?? a.spentCents;
		if (a.totalLimitCents === 0) return null;
		const diff = a.totalLimitCents - total;
		const verb = a.forecast ? 'blijf je' : 'bleef je';
		const verbOver = a.forecast ? 'kom je' : 'kwam je';
		if (diff >= 0) return `Zo ${verb} ${whole(diff)} onder je limieten.`;
		return `Zo ${verbOver} ${whole(-diff)} boven je limieten.`;
	});

	// Waaruit de verwachting bestaat: wat er al is, de vaste lasten die nog komen en het
	// gemiddelde per dag voor de dagen na vandaag
	const buildup = $derived.by((): Segment[] => {
		const f = a.forecast;
		if (!f) return [];
		const perDay = Math.round(f.variableLeftCents / Math.max(1, f.daysLeft));
		return [
			{ key: 'uitgegeven', label: 'Al uitgegeven', cents: f.spentCents },
			...(f.plannedLeftCents > 0
				? [
						{
							key: 'vast',
							label: 'Vaste lasten die nog komen',
							cents: f.plannedLeftCents,
							color: groupColor(FIXED_GROUP) ?? undefined,
							hatched: true
						}
					]
				: []),
			...(f.daysLeft > 0
				? [
						{
							key: 'dagelijks',
							label: `${f.daysLeft === 1 ? 'Nog 1 dag' : `Nog ${f.daysLeft} dagen`} à ${formatCents(perDay)}`,
							cents: f.variableLeftCents,
							hatched: true
						}
					]
				: [])
		];
	});

	// Per categorie op één schaal, zodat je ze kunt vergelijken; reserveringen apart gearceerd
	const lines = $derived(
		[...a.lines].sort((x, y) => y.spentCents + y.reservedCents - (x.spentCents + x.reservedCents))
	);
	const scale = $derived(
		Math.max(
			1,
			a.uncategorizedCents,
			...a.lines.map((l) => Math.max(l.limitCents, l.spentCents + l.reservedCents))
		)
	);

	const fixedBase = $derived(a.spentCents + (a.forecast ? a.plannedLeftCents : 0));
	const topMax = $derived(Math.max(1, ...a.top.map((t) => t.cents)));

	interface MoreTile {
		href: string;
		title: string;
		value: string;
		icon: icons.IconDef;
	}
	// Meer analyses met een eigen scherm, zoals boodschappen per productgroep en tags (spec:
	// Analyses). Elk komt hier als tegel zodra het scherm er is.
	const more: MoreTile[] = [];
</script>

<svelte:head>
	<title>Analyses · Budget</title>
</svelte:head>

<div class={['page', busy && 'busy']}>
	<div class="head">
		<h1>Analyses</h1>
		<AnalysesTabs current="maand" />
		<nav class="months" aria-label="Maand">
			<a class="step" href="?maand={data.previous}">
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5" /></svg>
				Vorige
			</a>
			<span class="current">{formatMonth(a.month)}</span>
			{#if data.next}
				<a class="step" href="?maand={data.next}">
					Volgende
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5L13 10l-5.5 5.5" /></svg>
				</a>
			{/if}
		</nav>
	</div>

	{#if empty}
		<EmptyState
			icon={icons.analyses}
			text="Nog niets uitgegeven in {monthName}. Zodra er uitgaven zijn, zie je hier waar het geld heen gaat."
		>
			<a class="button" href="/import">Historie importeren</a>
		</EmptyState>
	{:else}
		<div class="hero card">
			{#if a.forecast}
				<HeroAmount cents={a.forecast.totalCents} label="Verwacht uitgegeven eind {monthName}" />
			{:else}
				<HeroAmount cents={a.spentCents} label="Uitgegeven in {monthName}" />
			{/if}
			{#if sentence}<p class="tell">{sentence}</p>{/if}

			{#if a.forecast}
				<StackedBar
					label="Opbouw van de verwachting"
					total={Math.max(a.totalLimitCents, a.forecast.totalCents)}
					segments={buildup}
				/>
			{/if}

			<Chart
				label="Uitgegeven in {formatMonth(a.month)}, opgeteld per dag{a.forecast
					? ', met de verwachting tot het eind van de maand'
					: ''}"
				ticks={chart.ticks}
				names={chart.names}
				series={chart.series}
				focus={a.day > 0 ? a.day - 1 : undefined}
				limit={a.totalLimitCents > 0 ? { cents: a.totalLimitCents, label: 'Limieten' } : undefined}
			/>
		</div>

		<section class="card" aria-labelledby="categories-title">
			<div class="section-head">
				<h2 id="categories-title">Per categorie</h2>
				<a class="more-link" href="/budget?maand={a.month}">Budget</a>
			</div>
			<ul class="rows">
				{#each lines as l (l.categoryId)}
					{@const used = l.spentCents + l.reservedCents}
					<li class="cat">
						<span class="name">
							<span class="dot" style:--dot={groupColor(l.group)} aria-hidden="true"></span>
							{l.name}
						</span>
						<span class="num amount">
							{whole(l.spentCents)}{#if l.limitCents > 0}<span class="muted"
									>{` van ${whole(l.limitCents)}`}</span
								>{/if}
						</span>
						<span class="meter" aria-hidden="true">
							{#if l.limitCents > 0}<span class="limit" style:--len={l.limitCents / scale}
								></span>{/if}
							<span
								class={['fill', l.limitCents > 0 && used > l.limitCents && 'over']}
								style:--c={groupColor(l.group)}
								style:--len={l.spentCents / scale}
							></span>
							{#if l.reservedCents > 0}
								<span
									class="fill hatched"
									style:--c={groupColor(l.group)}
									style:--start={l.spentCents / scale}
									style:--len={l.reservedCents / scale}
								></span>
							{/if}
						</span>
						{#if l.reservedCents !== 0}
							<span class="note muted">
								<span class="num">{formatCents(l.reservedCents, { sign: true })}</span> opzij voor vaste
								lasten
							</span>
						{/if}
					</li>
				{/each}
				{#if a.uncategorizedCents > 0}
					<li class="cat">
						<span class="name"
							><span class="dot open" aria-hidden="true"></span>Zonder categorie</span
						>
						<span class="num amount">{whole(a.uncategorizedCents)}</span>
						<span class="meter" aria-hidden="true">
							<span class="fill" style:--c="var(--muted)" style:--len={a.uncategorizedCents / scale}
							></span>
						</span>
					</li>
				{/if}
			</ul>
		</section>

		{#if a.reserves.length > 0}
			<section class="card" aria-labelledby="reserves-title">
				<div class="section-head">
					<h2 id="reserves-title">Opzij gezet</h2>
				</div>
				<p class="muted">
					Deze maand <span class="num">{formatCents(a.reservedCents)}</span> opzij voor vaste lasten die
					niet elke maand komen. Dat telt als uitgave in hun categorie.
				</p>
				<ul class="rows">
					{#each a.reserves as r (r.recurringId)}
						<li class="reserve">
							<span class="name">{displayName(r.counterparty)}</span>
							<span class="num amount"
								>{whole(r.reservedCents)}
								<span class="muted">van {whole(r.expectedCents)}</span></span
							>
							<span class="meter" aria-hidden="true">
								<span
									class="fill"
									style:--c={groupColor(FIXED_GROUP)}
									style:--len={Math.min(1, ratio(r.reservedCents, r.expectedCents))}
								></span>
							</span>
							{#if r.nextDate}
								<span class="note muted">Afschrijving rond {formatDayMonth(r.nextDate)}</span>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section class="card" aria-labelledby="fixed-title">
			<div class="section-head">
				<h2 id="fixed-title">Vaste lasten</h2>
				<a class="more-link" href="/vaste-lasten">Vaste lasten</a>
			</div>
			<p>
				<span class="num">{whole(a.fixedCents + (a.forecast ? a.plannedLeftCents : 0))}</span>, dat
				is
				{percent(ratio(a.fixedCents + (a.forecast ? a.plannedLeftCents : 0), fixedBase))} van je uitgaven
				in {monthName}{a.forecast ? ' (met wat nog komt)' : ''}.
			</p>
			<StackedBar
				label="Vaste lasten en overige uitgaven"
				total={fixedBase}
				segments={[
					{
						key: 'vast',
						label: 'Vaste lasten',
						cents: a.fixedCents,
						color: groupColor(FIXED_GROUP) ?? undefined
					},
					...(a.forecast && a.plannedLeftCents > 0
						? [
								{
									key: 'komt',
									label: 'Komt nog',
									cents: a.plannedLeftCents,
									color: groupColor(FIXED_GROUP) ?? undefined,
									hatched: true
								}
							]
						: []),
					{
						key: 'overig',
						label: 'Overig',
						cents: a.spentCents - a.fixedCents,
						color: 'color-mix(in oklch, var(--accent) 45%, var(--surface-2))'
					}
				]}
			/>
			{#if a.fixedPerMonthCents > 0}
				<p class="muted">
					Je vaste lasten kosten gemiddeld <span class="num">{whole(a.fixedPerMonthCents)}</span> per
					maand.
				</p>
			{/if}
		</section>

		{#if a.top.length > 0}
			<section class="card" aria-labelledby="top-title">
				<div class="section-head">
					<h2 id="top-title">Grootste uitgaven</h2>
					<a class="more-link" href="/transacties?maand={a.month}">Transacties</a>
				</div>
				<ol class="top">
					{#each a.top as t (t.name)}
						<li>
							<a href="/transacties?maand={a.month}&q={encodeURIComponent(t.name)}">
								<span class="monogram sm" aria-hidden="true">{initials(t.name)}</span>
								<span class="who">
									<span class="name">{t.name}</span>
									<span class="muted"
										>{t.count === 1 ? '1 keer' : `${t.count} keer`} · {percent(t.share)}</span
									>
								</span>
								<span class="num amount">{formatCents(-t.cents)}</span>
								<span class="meter" aria-hidden="true">
									<span class="fill" style:--c="var(--accent)" style:--len={t.cents / topMax}
									></span>
								</span>
							</a>
						</li>
					{/each}
				</ol>
			</section>
		{/if}
	{/if}

	{#if more.length > 0}
		<section aria-labelledby="more-title">
			<h2 id="more-title">Meer analyses</h2>
			<ul class="tiles">
				{#each more as tile (tile.href)}
					<li><Tile {...tile} /></li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 56rem;
		transition: opacity 200ms var(--ease-out);
	}

	/* Laden: de oude inhoud blijft staan, gedimd */
	.busy {
		opacity: 0.55;
	}

	.head {
		display: grid;
		gap: 12px;
	}

	.months {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}

	.current {
		font-weight: 600;
		padding: 0 6px;
	}

	.step {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: var(--tap);
		padding: 0 14px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text);
		font-weight: 550;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	.step:first-child {
		padding-left: 8px;
	}

	.step:last-child {
		padding-right: 8px;
	}

	.step:active {
		transform: scale(0.96);
	}

	.step svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	section.card,
	.hero {
		display: grid;
		gap: 14px;
		min-width: 0;
	}

	.hero {
		gap: 16px;
	}

	.section-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 4px 12px;
	}

	.section-head h2 {
		font-size: 1.3rem;
	}

	.section-head .more-link {
		margin-right: -4px;
	}

	.rows,
	.top,
	.tiles {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 16px;
	}

	.cat,
	.reserve {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 6px 12px;
	}

	.name {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-weight: 550;
	}

	.amount {
		font-weight: 600;
		white-space: nowrap;
	}

	.amount .muted {
		font-weight: 400;
	}

	.note {
		grid-column: 1 / -1;
		font-size: 0.88rem;
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--dot, var(--muted));
	}

	.dot.open {
		background: none;
		box-shadow: inset 0 0 0 1.5px var(--muted);
	}

	/* Balken op één schaal. Alleen transform: elk deel is de hele breedte, verschoven en
	   geschaald, en groeit bij het laden vanaf links (zoals StackedBar). */
	.meter {
		grid-column: 1 / -1;
		position: relative;
		height: 10px;
		border-radius: 999px;
		overflow: hidden;
	}

	.limit,
	.fill {
		position: absolute;
		inset: 0;
		transform-origin: left center;
		transform: translateX(calc(var(--start, 0) * 100%)) scaleX(var(--len));
		transition: transform 700ms var(--ease-spring);
	}

	@starting-style {
		.limit,
		.fill {
			transform: translateX(0) scaleX(0);
		}
	}

	.limit {
		background: var(--surface-2);
	}

	.fill {
		background: var(--c);
		box-shadow: inset -2px 0 0 var(--surface);
	}

	.fill.over {
		background: linear-gradient(90deg, var(--c), var(--warn));
	}

	.fill.hatched {
		background: repeating-linear-gradient(
			-45deg,
			var(--c) 0 3px,
			color-mix(in oklch, var(--c) 35%, transparent) 3px 6px
		);
	}

	.top a {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 6px 12px;
		min-height: var(--tap);
		color: inherit;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	.top a:active {
		transform: scale(0.99);
	}

	.top .who {
		display: grid;
		min-width: 0;
	}

	.top .who .name {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.top .who .muted {
		font-size: 0.88rem;
	}

	.top .meter {
		grid-column: 2 / -1;
		height: 6px;
	}

	.tiles {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr));
		gap: 10px;
		margin-top: 12px;
	}

	@media (prefers-reduced-motion: reduce) {
		.limit,
		.fill {
			transition: none;
		}
	}
</style>
