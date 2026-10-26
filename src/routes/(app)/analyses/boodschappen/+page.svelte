<script lang="ts">
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import StackedBar from '#lib/components/StackedBar.svelte';
	import { formatDayMonth, formatMonth } from '#lib/dates.ts';
	import { coveragePercent, type Bucket } from '#lib/groceries.ts';
	import { boodschappen } from '#lib/icons-extra.ts';
	import { formatCents } from '#lib/money.ts';
	import { PRODUCT_GROUP_LABEL, productGroupColor, type ProductGroup } from '#lib/productGroups.ts';
	import { displayName } from '#lib/text.ts';

	let { data } = $props();

	const monthName = $derived(formatMonth(data.month).replace(/ \d{4}$/, ''));
	const when = $derived(data.isCurrent ? 'deze maand' : `in ${monthName}`);
	const percent = $derived(
		data.coverage.share === null ? null : coveragePercent(data.coverage.share)
	);
	const hasLines = $derived(data.rows.length > 0 || data.discount.cents !== 0);

	const LABEL: Record<Bucket, string> = {
		...PRODUCT_GROUP_LABEL,
		zonder_groep: 'Nog geen groep',
		overige_regels: 'Statiegeld en overig'
	};

	function color(bucket: Bucket): string {
		if (bucket === 'zonder_groep' || bucket === 'overige_regels') return productGroupColor(null);
		return productGroupColor(bucket);
	}

	// De balk toont alleen wat erbij komt; korting staat als eigen regel in de lijst
	const segments = $derived(
		data.rows
			.filter((r) => r.cents > 0)
			.map((r) => ({
				key: r.bucket,
				label: LABEL[r.bucket],
				cents: r.cents,
				color: color(r.bucket),
				hatched: r.bucket === 'zonder_groep'
			}))
	);

	/** "€ 4 meer dan gemiddeld"; bij korting gaat het om meer of minder korting. */
	function diffText(diff: number | null, discount = false): string | null {
		if (diff === null) return null;
		const more = discount ? diff < 0 : diff > 0;
		if (Math.abs(diff) < 100) return 'zoals gemiddeld';
		const amount = formatCents(Math.abs(diff), { whole: true });
		if (discount) return `${amount} ${more ? 'meer' : 'minder'} korting dan gemiddeld`;
		return `${amount} ${more ? 'meer' : 'minder'} dan gemiddeld`;
	}

	const groupLabel = (g: ProductGroup | null) => (g ? PRODUCT_GROUP_LABEL[g] : 'Nog geen groep');
</script>

<svelte:head>
	<title>Boodschappen · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<BackLink parents={['/budget', '/analyses']} labels={{ '/analyses': 'Analyses' }} />
		<h1>Boodschappen {formatMonth(data.month)}</h1>
		<nav class="months" aria-label="Maand">
			<a class="step" href="?maand={data.previous}">
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5" /></svg>
				Vorige
			</a>
			{#if !data.isCurrent}<a class="step" href="/analyses/boodschappen">Deze maand</a>{/if}
			{#if data.next}
				<a class="step" href="?maand={data.next}">
					Volgende
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5L13 10l-5.5 5.5" /></svg>
				</a>
			{/if}
		</nav>
	</div>

	{#if data.missingCategory}
		<EmptyState
			icon={boodschappen}
			text="Er is geen categorie Boodschappen meer, dus er valt niets te verdelen."
		>
			<a class="more-link" href="/categorieen">Categorieën</a>
		</EmptyState>
	{:else if percent === null}
		<EmptyState icon={boodschappen} text="Geen boodschappen {when}.">
			<a class="more-link" href="/bonnen">Bon toevoegen</a>
		</EmptyState>
	{:else}
		<section class="card coverage" aria-labelledby="coverage-text">
			<p id="coverage-text" class="tell">
				{percent}% van je boodschappen {when} heeft een bon met regels.
			</p>
			<div class="meter" aria-hidden="true">
				<span style:--share={data.coverage.share}></span>
			</div>
			<p class="muted small num">
				{formatCents(data.coverage.coveredCents)} van {formatCents(data.coverage.totalCents)}.
				Alleen die aankopen staan hieronder; de rest heeft geen bon met regels.
			</p>
		</section>

		<section class="card groups" aria-labelledby="groups-title">
			<div class="card-head">
				<h2 id="groups-title">Per productgroep</h2>
				{#if hasLines}<p class="num muted">{formatCents(data.total.cents)} op bonnen</p>{/if}
			</div>
			{#if !hasLines}
				<EmptyState compact icon={boodschappen} text="Nog geen bon met regels {when}.">
					<a class="more-link" href="/bonnen">Bonnen</a>
				</EmptyState>
			{:else}
				<StackedBar label="Boodschappen per productgroep" {segments} legend={false} />
				<ul class="rows num" aria-label="Boodschappen per productgroep">
					{#each data.rows as r (r.bucket)}
						{@const diff = diffText(r.diffCents)}
						<li>
							<span
								class={['swatch', r.bucket === 'zonder_groep' && 'hatched']}
								style:--c={color(r.bucket)}
								aria-hidden="true"
							></span>
							<span class="what">
								{LABEL[r.bucket]}
								{#if diff}<span class="muted diff">{diff}</span>{/if}
							</span>
							<span class="amount">{formatCents(r.cents)}</span>
						</li>
					{/each}
					{#if data.discount.cents !== 0 || (data.discount.averageCents ?? 0) !== 0}
						{@const diff = diffText(data.discount.diffCents, true)}
						<li class="discount">
							<span class="swatch none" aria-hidden="true"></span>
							<span class="what">
								Korting
								{#if diff}<span class="muted diff">{diff}</span>{/if}
							</span>
							<span class="amount">{formatCents(data.discount.cents)}</span>
						</li>
					{/if}
					<li class="total">
						<span class="swatch none" aria-hidden="true"></span>
						<span class="what">
							Totaal op bonnen
							{#if diffText(data.total.diffCents)}<span class="muted diff"
									>{diffText(data.total.diffCents)}</span
								>{/if}
						</span>
						<span class="amount">{formatCents(data.total.cents)}</span>
					</li>
				</ul>
				<p class="muted small">
					{#if data.comparedMonths === 0}
						Nog geen eerdere maanden met bonnen om mee te vergelijken.
					{:else}
						Gemiddeld: over {data.comparedMonths === 1
							? 'de vorige maand'
							: `${data.comparedMonths} van de vorige drie maanden`} met bonnen. Korting en bonus tellen
						als één regel en niet per groep.
					{/if}
				</p>
			{/if}
		</section>

		{#if data.topLines.length > 0}
			<section class="card top" aria-labelledby="top-title">
				<h2 id="top-title">Duurste regels</h2>
				<ol>
					{#each data.topLines as l (l.id)}
						<li>
							<a class="line" href="/bonnen/{l.receiptId}">
								<span class="desc">{l.description || 'Zonder omschrijving'}</span>
								<span class="amount num">{formatCents(l.cents)}</span>
								<span class="meta muted">
									<span class="swatch" style:--c={productGroupColor(l.group)} aria-hidden="true"
									></span>
									{groupLabel(l.group)} · {displayName(l.counterparty) || 'Zonder naam'}, {formatDayMonth(
										l.date
									)}
								</span>
							</a>
						</li>
					{/each}
				</ol>
				<p class="muted small">Klopt een groep niet? Pas hem aan op de bon.</p>
			</section>
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

	.intro {
		display: grid;
		gap: 8px;
	}

	.months {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
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

	.step:first-child {
		padding-left: 8px;
	}

	.step:last-child:not(:first-child) {
		padding-right: 8px;
	}

	.coverage,
	.groups,
	.top {
		display: grid;
		gap: 14px;
	}

	.small {
		font-size: 0.9rem;
	}

	/* Dekking als balk: alleen transform, zoals de budgetbalk */
	.meter {
		position: relative;
		height: 10px;
		border-radius: 999px;
		background: var(--surface-2);
		overflow: hidden;
	}

	.meter span {
		position: absolute;
		inset: 0;
		background: var(--accent);
		transform-origin: left center;
		transform: scaleX(var(--share));
		transition: transform 700ms var(--ease-spring);
	}

	@starting-style {
		.meter span {
			transform: scaleX(0);
		}
	}

	.card-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		flex-wrap: wrap;
		gap: 4px 12px;
	}

	h2 {
		font-size: 1.25rem;
	}

	ul,
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}

	.rows li {
		display: grid;
		grid-template-columns: 12px minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 10px;
		padding: 10px 0;
		border-top: 1px solid var(--line);
	}

	.rows li:first-child {
		border-top: 0;
	}

	.rows .total {
		font-weight: 650;
	}

	.what {
		display: grid;
		min-width: 0;
	}

	.diff {
		font-size: 0.85rem;
		font-weight: 400;
	}

	.amount {
		font-weight: 600;
		white-space: nowrap;
		text-align: right;
	}

	.swatch {
		display: inline-block;
		width: 10px;
		height: 10px;
		border-radius: 3px;
		background: var(--c);
	}

	.swatch.none {
		background: none;
	}

	.hatched {
		background: repeating-linear-gradient(
			-45deg,
			var(--c) 0 3px,
			color-mix(in oklch, var(--c) 35%, transparent) 3px 6px
		);
	}

	.top li + li {
		border-top: 1px solid var(--line);
	}

	.line {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 2px 12px;
		min-height: var(--tap);
		padding: 10px 0;
		color: inherit;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	.line:active {
		transform: scale(0.99);
	}

	.desc {
		font-weight: 550;
		overflow-wrap: anywhere;
	}

	.meta {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.88rem;
	}
</style>
