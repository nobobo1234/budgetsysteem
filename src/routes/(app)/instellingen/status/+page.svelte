<script lang="ts">
	import BackLink from '#lib/components/BackLink.svelte';
	import { invalidateAll } from '$app/navigation';
	import { formatShortDate } from '#lib/dates.ts';
	import {
		formatAge,
		formatBytes,
		formatDuration,
		formatPercent,
		formatVital
	} from '#lib/status.ts';

	let { data } = $props();
	let refreshing = $state(false);

	const h = $derived(data.health);
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
