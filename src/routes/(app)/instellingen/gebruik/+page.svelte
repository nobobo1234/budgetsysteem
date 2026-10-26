<script lang="ts">
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import { formatShortDate } from '#lib/dates.ts';
	import * as icons from '#lib/icons.ts';
	import { formatEntryTime, streakSentence } from '#lib/usage-view.ts';

	let { data } = $props();

	const u = $derived(data.usage);
	const week = $derived(u.weeks[0]);
	const LETTERS = ['m', 'd', 'w', 'd', 'v', 'z', 'z'];
	const DAY_NAMES = [
		'maandag',
		'dinsdag',
		'woensdag',
		'donderdag',
		'vrijdag',
		'zaterdag',
		'zondag'
	];
	const state = (d: boolean | null) => (d === null ? 'komt nog' : d ? 'invoer' : 'geen invoer');
</script>

<svelte:head>
	<title>Gebruik · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<BackLink parents={['/instellingen']} />
		<h1 data-morph-head="titel">Gebruik</h1>
	</div>

	{#if !week}
		<EmptyState
			icon={icons.gebruik}
			text="Nog niets gemeten. Elke dag waarop je iets invoert of bevestigt, komt hier te staan."
		>
			<a class="more-link" href="/">Naar het overzicht</a>
		</EmptyState>
	{:else}
		<section class="card this-week" aria-labelledby="deze-week">
			<h2 id="deze-week">Deze week</h2>
			<ol class="strip" aria-label="Dagen met invoer deze week">
				{#each week.days as d, i (i)}
					<li class={[d === true && 'on', d === null && 'later']}>
						<span aria-hidden="true">{LETTERS[i]}</span>
						<span class="visually-hidden">{DAY_NAMES[i]}: {state(d)}</span>
					</li>
				{/each}
			</ol>
			<p class="tell">{streakSentence(u)}</p>
		</section>

		<section aria-labelledby="per-week">
			<h2 id="per-week">Per week</h2>
			<p class="muted">
				Een dag telt als je iets invoerde of bevestigde: snelinvoer, een verwachte post of een bon.
				Openen tot opslaan is de tijd van het openen van de app tot je eerste invoer.
			</p>
			<div class="card table">
				<table>
					<thead>
						<tr>
							<th scope="col">Week van</th>
							<th scope="col">Dagen</th>
							<th scope="col" class="value">Mediaan</th>
							<th scope="col" class="value">p75</th>
						</tr>
					</thead>
					<tbody>
						{#each u.weeks as row (row.weekStart)}
							<tr>
								<th scope="row">
									<span class="num">{formatShortDate(row.weekStart)}</span>
									<span class="muted count num">
										{row.entries}
										{row.entries === 1 ? 'invoer' : 'invoeren'}
									</span>
								</th>
								<td>
									<span class="dots" aria-hidden="true">
										{#each row.days as d, i (i)}
											<span class={['dot', d === true && 'on', d === null && 'later']}></span>
										{/each}
									</span>
									<span class="num">{row.daysWithEntry} van {row.daysSoFar}</span>
								</td>
								<td class="value num">
									{#if row.medianMs === null}
										<span class="muted" aria-label="geen meting">–</span>
									{:else}
										{formatEntryTime(row.medianMs)}
									{/if}
								</td>
								<td class="value num">
									{#if row.p75Ms === null}
										<span class="muted" aria-label="geen meting">–</span>
									{:else}
										{formatEntryTime(row.p75Ms)}
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 28px;
		max-width: 44rem;
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

	.this-week {
		gap: 14px;
	}

	/* Zeven vakjes, maandag tot zondag: gevuld als je die dag iets invoerde */
	.strip {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 2.75rem));
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.strip li {
		display: grid;
		place-items: center;
		aspect-ratio: 1;
		border-radius: 10px;
		border: 1.5px solid var(--line);
		color: var(--muted);
		font-weight: 550;
	}

	.strip li.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}

	.strip li.later {
		border-style: dashed;
		opacity: 0.6;
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

	td .num {
		display: block;
	}

	.dots {
		display: flex;
		gap: 3px;
		margin: 5px 0 4px;
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1.5px var(--line);
	}

	.dot.on {
		background: var(--accent);
		box-shadow: none;
	}

	.dot.later {
		opacity: 0.4;
	}

	.value {
		text-align: right;
		white-space: nowrap;
	}
</style>
