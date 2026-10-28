<script lang="ts">
	import BackLink from '#lib/components/BackLink.svelte';
	import { invalidateAll } from '$app/navigation';
	import { formatShortDate } from '#lib/dates.ts';
	import {
		formatAge,
		formatBytes,
		formatCallDuration,
		formatDuration,
		formatPercent,
		formatTokens,
		formatUsd,
		formatVital
	} from '#lib/status.ts';

	let { data } = $props();
	let refreshing = $state(false);

	const h = $derived(data.health);
	const bon = $derived(data.receipts);
	const failed = $derived(
		bon.outcomes.weigering + bon.outcomes.afgekapt + bon.outcomes.ongeldig + bon.outcomes.fout
	);
	const sum = $derived(data.summaries);
	const budget = $derived(data.aiBudget);
	const budgetShare = $derived(
		budget.budgetNanoUsd > 0 ? Math.min(1, budget.spentNanoUsd / budget.budgetNanoUsd) : 1
	);
	const time = new Intl.DateTimeFormat('nl-NL', { timeStyle: 'short' });
	// FCP en TTFB worden ook opgeslagen, maar passen niet op een telefoonscherm
	const VITALS = ['LCP', 'INP', 'CLS'] as const;

	async function refresh() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}
</script>

<svelte:head>
	<title>Status · Budget</title>
</svelte:head>

<div class="page" class:refreshing aria-busy={refreshing}>
	<div class="intro">
		<BackLink parents={['/instellingen']} />
		<h1 data-morph-head="titel">Status</h1>
	</div>

	<section
		class="card summary"
		class:ok={data.attention.length === 0}
		aria-labelledby="samenvatting"
	>
		<h2 id="samenvatting">
			{data.attention.length === 0
				? 'Alles werkt'
				: data.attention.length === 1
					? 'Eén punt vraagt aandacht'
					: `${data.attention.length} punten vragen aandacht`}
		</h2>
		{#if data.attention.length > 0}
			<ul>
				{#each data.attention as item (item)}<li>{item}</li>{/each}
			</ul>
		{/if}
		<div class="checked">
			<p class="muted">
				Bijgewerkt om <span class="num">{time.format(new Date(data.checkedAt))}</span>
			</p>
			<button class="button secondary" onclick={refresh} disabled={refreshing}>Vernieuwen</button>
		</div>
	</section>

	<section aria-labelledby="backups">
		<h2 id="backups">Backups</h2>
		<dl class="card">
			<div>
				<dt>Litestream</dt>
				<dd class="num">{formatAge(h.backups.litestreamAgeSeconds)}</dd>
			</div>
			<div>
				<dt>restic</dt>
				<dd class="num">{formatAge(h.backups.resticAgeSeconds)}</dd>
			</div>
		</dl>
	</section>

	<section aria-labelledby="server">
		<h2 id="server">Server</h2>
		<dl class="card">
			<div>
				<dt>Database</dt>
				<dd>{h.database ? 'Bereikbaar' : 'Niet bereikbaar'}</dd>
			</div>
			<div>
				<dt>Schijf</dt>
				<dd class="num">
					{h.disk
						? `${formatPercent(h.disk.usedPercent)} gebruikt · ${formatBytes(h.disk.freeBytes)} vrij`
						: 'Onbekend'}
				</dd>
			</div>
			<div>
				<dt>Draait</dt>
				<dd class="num">{formatDuration(h.uptimeSeconds)}</dd>
			</div>
			<div>
				<dt>Starts</dt>
				<dd class="num">{h.starts.last24h} in 24 u · {h.starts.last7d} in 7 d</dd>
			</div>
			<div>
				<dt>Herstarts</dt>
				<dd class="num">{h.starts.restarts7d} in 7 d</dd>
			</div>
		</dl>
	</section>

	<section aria-labelledby="fouten">
		<h2 id="fouten">Fouten</h2>
		<dl class="card">
			<div>
				<dt>Laatste 24 uur</dt>
				<dd class="num">
					{h.errors.last24h}
					{#if h.errors.last24h > 0}
						<span class="muted"
							>({h.errors.kinds24h} {h.errors.kinds24h === 1 ? 'soort' : 'soorten'})</span
						>
					{/if}
				</dd>
			</div>
			<div>
				<dt>Laatste 7 dagen</dt>
				<dd class="num">{h.errors.last7d}</dd>
			</div>
		</dl>
	</section>

	<section aria-labelledby="bonnen">
		<h2 id="bonnen">Bonnen lezen</h2>
		<p class="muted">
			Elke keer dat Haiku een bon leest, in de laatste {bon.days} dagen. Zeker maar gecorrigeerd hoort
			bij nul te blijven.
		</p>
		{#if bon.calls === 0}
			<p class="card empty">Nog geen bonnen gelezen.</p>
		{:else}
			<dl class="card">
				<div>
					<dt>Gelezen</dt>
					<dd class="num">{bon.calls} keer</dd>
				</div>
				<div>
					<dt>Uitkomst</dt>
					<dd class="num">
						{bon.outcomes.zeker} zeker · {bon.outcomes.controleren} controleren · {bon.outcomes
							.onzeker} onzeker{#if failed > 0}
							· {failed} mislukt{/if}
					</dd>
				</div>
				<div>
					<dt>Achteraf gecorrigeerd</dt>
					<dd class="num">
						{bon.corrected}
						{#if bon.correctedSure > 0}
							<span class="warn-text">({bon.correctedSure} zeker maar fout)</span>
						{/if}
					</dd>
				</div>
				<div>
					<dt>Kosten</dt>
					<dd class="num">{formatUsd(bon.costNanoUsd)}</dd>
				</div>
				<div>
					<dt>Tokens</dt>
					<dd class="num">
						{formatTokens(bon.inputTokens)} in · {formatTokens(bon.outputTokens)} uit
					</dd>
				</div>
				<div>
					<dt>Duur (mediaan)</dt>
					<dd class="num">{bon.medianMs === null ? '–' : formatCallDuration(bon.medianMs)}</dd>
				</div>
			</dl>
		{/if}
	</section>

	<section aria-labelledby="ai-kosten">
		<h2 id="ai-kosten">AI-kosten deze maand</h2>
		<p class="muted">
			Bonnen, samenvattingen en vragen samen, tegenover het maandbudget. Is het op, dan krijgt de
			samenvatting de vaste tekst; bonnen gaan voor.
		</p>
		<div class="card budget">
			<p>
				<strong class="num">{formatUsd(budget.spentNanoUsd)}</strong>
				<span class="muted">van <span class="num">{formatUsd(budget.budgetNanoUsd)}</span></span>
				{#if !budget.available}<span class="warn-text">· op</span>{/if}
			</p>
			<span class="meter" aria-hidden="true"
				><span class:full={!budget.available} style:--share={budgetShare}></span></span
			>
		</div>
	</section>

	<section aria-labelledby="samenvattingen">
		<h2 id="samenvattingen">Samenvattingen</h2>
		<p class="muted">
			Elke keer dat Haiku de zinnen van een maandafsluiting schreef, in de laatste {sum.days} dagen. Klopt
			niet hoort bij nul te blijven.
		</p>
		{#if sum.calls === 0}
			<p class="card empty">Nog geen samenvattingen geschreven.</p>
		{:else}
			<dl class="card">
				<div>
					<dt>Geschreven</dt>
					<dd class="num">{sum.calls} keer</dd>
				</div>
				<div>
					<dt>Uitkomst</dt>
					<dd class="num">
						{sum.outcomes.geschreven} door de controle · {sum.fallback} vaste tekst{#if sum.outcomes.controle > 0}
							<span class="muted">({sum.outcomes.controle} na de controle)</span>{/if}
					</dd>
				</div>
				<div>
					<dt>Klopt niet</dt>
					<dd class="num">
						{#if sum.wrongTaps > 0}
							<span class="warn-text">{sum.wrongTaps} {sum.wrongTaps === 1 ? 'zin' : 'zinnen'}</span
							>
							<span class="muted"
								>in {sum.wrongCalls}
								{sum.wrongCalls === 1 ? 'samenvatting' : 'samenvattingen'}</span
							>
						{:else}
							0
						{/if}
					</dd>
				</div>
				<div>
					<dt>Kosten</dt>
					<dd class="num">{formatUsd(sum.costNanoUsd)}</dd>
				</div>
				<div>
					<dt>Tokens</dt>
					<dd class="num">
						{formatTokens(sum.inputTokens)} in · {formatTokens(sum.outputTokens)} uit
					</dd>
				</div>
				<div>
					<dt>Duur (mediaan)</dt>
					<dd class="num">{sum.medianMs === null ? '–' : formatCallDuration(sum.medianMs)}</dd>
				</div>
			</dl>
		{/if}
	</section>

	<section aria-labelledby="snelheid">
		<h2 id="snelheid">Snelheid</h2>
		<p class="muted">
			p75 per week, gemeten op je eigen apparaten. Goed is LCP tot 2,5 s, INP tot 200 ms en CLS tot
			0,1.
		</p>
		{#if data.vitals.length === 0}
			<p class="card empty">
				Nog geen metingen. Ze komen vanzelf binnen terwijl je de app gebruikt.
			</p>
		{:else}
			<div class="card table">
				<table>
					<thead>
						<tr>
							<th scope="col">Week van</th>
							{#each VITALS as name (name)}<th scope="col" class="value">{name}</th>{/each}
						</tr>
					</thead>
					<tbody>
						{#each data.vitals as row (row.weekStart)}
							<tr>
								<th scope="row">
									<span class="num">{formatShortDate(row.weekStart)}</span>
									<span class="muted count num">
										{Object.values(row.metrics).reduce((n, m) => Math.max(n, m.count), 0)} metingen
									</span>
								</th>
								{#each VITALS as name (name)}
									{@const m = row.metrics[name]}
									<td class="value num">
										{#if m}
											<span class="rating {m.rating}">{formatVital(name, m.p75)}</span>
											<span class="visually-hidden">, {m.rating}</span>
										{:else}
											<span class="muted" aria-label="geen meting">–</span>
										{/if}
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>

<style>
	.warn-text {
		color: color-mix(in oklch, var(--warn) 70%, var(--text));
	}

	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 28px;
		max-width: 44rem;
		transition: opacity 160ms var(--ease-out);
	}

	.page.refreshing {
		opacity: 0.6;
	}

	.intro {
		display: grid;
		gap: 4px;
		justify-items: start;
	}

	section {
		display: grid;
		gap: 12px;
	}

	.summary {
		gap: 10px;
		border-left: 4px solid var(--warn);
	}

	.summary.ok {
		border-left-color: var(--accent);
	}

	.summary ul {
		margin: 0;
		padding-left: 1.2em;
		display: grid;
		gap: 4px;
	}

	.checked {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 12px;
	}

	dl {
		margin: 0;
		padding-block: 4px;
		display: grid;
	}

	dl div {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: 2px 16px;
		padding: 10px 0;
	}

	dl div + div {
		border-top: 1px solid var(--line);
	}

	dt {
		color: var(--muted);
	}

	dd {
		margin: 0;
		text-align: right;
	}

	.empty {
		color: var(--muted);
	}

	.budget {
		display: grid;
		gap: 10px;
	}

	.meter {
		display: block;
		height: 8px;
		border-radius: 999px;
		background: var(--surface-2);
		overflow: hidden;
	}

	.meter span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
		transform: scaleX(var(--share));
		transform-origin: left center;
	}

	.meter .full {
		background: var(--warn);
	}

	.table {
		padding: 4px 12px;
	}

	table {
		width: 100%;
		border-collapse: collapse;
	}

	th,
	td {
		padding: 10px 4px;
		text-align: left;
		vertical-align: top;
	}

	thead th {
		color: var(--muted);
		font-weight: 550;
		font-size: 0.9rem;
	}

	tbody tr {
		border-top: 1px solid var(--line);
	}

	tbody th {
		font-weight: 500;
	}

	tbody th span {
		display: block;
	}

	.count {
		font-size: 0.85rem;
		font-weight: 400;
	}

	.value {
		text-align: right;
		white-space: nowrap;
	}

	/* Beoordeling als bolletje voor het getal; de tekst houdt de tekstkleur (contrast AA) */
	.rating::before {
		content: '';
		display: inline-block;
		width: 8px;
		height: 8px;
		margin-right: 6px;
		border-radius: 50%;
		vertical-align: 0.1em;
	}

	.goed::before {
		background: var(--accent);
	}

	.matig::before {
		background: var(--warn);
	}

	.slecht::before {
		background: var(--danger);
	}
</style>
