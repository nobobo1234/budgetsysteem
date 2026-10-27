<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import HeroAmount from '#lib/components/HeroAmount.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { budget, importeren } from '#lib/icons.ts';
	import { formatCents, parseAmount } from '#lib/money.ts';
	import { byRoom, MIN_HISTORY_MONTHS, periodSentence, plan } from '#lib/startLimits.ts';

	// Startlimieten uit historie (spec: Analyses → Startlimieten uit historie, Schermen): per
	// categorie zonder limiet een voorstel uit de mediaan van de laatste volle maanden, met een
	// optioneel spaardoel ertegenover. Het spaardoel blijft in de pagina en wordt niet bewaard.

	let { data } = $props();
	const p = $derived(data.page);
	const whole = (cents: number) => formatCents(cents, { whole: true });

	type Line = (typeof data.page.lines)[number];
	type WithProposal = Line & { proposal: Extract<Line['proposal'], { kind: 'voorstel' }> };
	const proposed = $derived(
		p.lines.filter((l): l is WithProposal => l.proposal.kind === 'voorstel')
	);
	const without = $derived(p.lines.filter((l) => l.proposal.kind !== 'voorstel'));

	// Per categorie het bedrag in het veld en het vinkje (standaard aan). Na opslaan verdwijnen
	// de categorieën met een limiet uit de lijst; de rest houdt wat je had ingevuld.
	let values = $state<Record<string, string>>({});
	let checked = $state<Record<string, boolean>>({});
	const valueOf = (l: WithProposal) =>
		values[l.categoryId] ?? String(l.proposal.proposalCents / 100);
	const isChecked = (l: WithProposal) => checked[l.categoryId] ?? true;
	const centsOf = (l: WithProposal) => parseAmount(valueOf(l).trim());

	let savingsText = $state('');
	const savingsCents = $derived(parseAmount(savingsText.trim()) ?? 0);
	const savingsInvalid = $derived(
		savingsText.trim() !== '' && parseAmount(savingsText.trim()) === null
	);

	const chosen = $derived(proposed.filter(isChecked));
	const outcome = $derived(
		plan({
			incomeCents: p.incomeCents,
			savingsCents,
			existingLimitsCents: p.existingLimitsCents,
			chosenCents: chosen.map((l) => centsOf(l) ?? 0)
		})
	);
	const hasIncome = $derived(p.incomeCents > 0);
	const short = $derived(hasIncome && outcome.shortfallCents > 0);

	// Bij een tekort: per groep eerst de categorieën waar je eerder al minder uitgaf
	const groups = $derived.by(() => {
		const rows = proposed.map((l) => ({
			...l,
			valueCents: l.proposal.proposalCents,
			lowestCents: l.proposal.lowestCents
		}));
		const grouped = [...Map.groupBy(rows, (l) => l.group)].map(
			([group, lines]) => [group, short ? byRoom(lines) : lines] as const
		);
		if (!short) return grouped;
		const room = (lines: readonly (typeof rows)[number][]) =>
			Math.max(...lines.map((l) => l.valueCents - l.lowestCents));
		return grouped.toSorted((a, b) => room(b[1]) - room(a[1]));
	});

	let showWithout = $state(false);
	let busy = $state(false);
	let error = $state<{ message: string; categoryId: string | null } | null>(null);
	let toast = $state<{ text: string; error: boolean; key: number } | null>(null);
	const notify = (text: string, isError = false) =>
		(toast = { text, error: isError, key: Date.now() });

	const apply: SubmitFunction = () => {
		busy = true;
		error = null;
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'success') {
				const set = Number(result.data?.set ?? 0);
				const skipped = Number(result.data?.skipped ?? 0);
				notify(
					`${set === 1 ? '1 limiet' : `${set} limieten`} ingesteld.` +
						(skipped > 0 ? ` ${skipped} had er al een.` : '')
				);
				await update({ reset: false });
				return;
			}
			if (result.type === 'failure') {
				const d = result.data ?? {};
				error = {
					message: typeof d.message === 'string' ? d.message : 'Dat lukte niet.',
					categoryId: typeof d.categoryId === 'string' ? d.categoryId : null
				};
				if (!error.categoryId) notify(error.message, true);
				return;
			}
			notify('Dat lukte niet. Probeer het opnieuw.', true);
		};
	};
</script>

<svelte:head>
	<title>Startlimieten · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<BackLink parents={['/budget']} />
		<h1>Startlimieten</h1>
	</div>

	{#if !p.enoughHistory}
		<div class="card">
			<EmptyState
				icon={importeren}
				text="Voor een voorstel zijn minstens {MIN_HISTORY_MONTHS} volle maanden historie nodig{p
					.months.length > 0
					? `, en je hebt er nu ${p.months.length}`
					: ''}. Met meer historie stelt de app per categorie een limiet voor."
			>
				<a class="button" href="/import">Historie importeren</a>
			</EmptyState>
		</div>
	{:else if proposed.length === 0}
		<div class="card">
			<EmptyState
				icon={budget}
				text="Elke categorie waar je geld aan uitgeeft heeft een limiet. De maandafsluiting stelt ze voortaan bij."
			>
				<a class="button secondary" href="/budget">Naar Budget</a>
			</EmptyState>
		</div>
	{:else}
		<div class="hero">
			{#if hasIncome}
				<HeroAmount
					cents={Math.abs(outcome.leftCents)}
					label={outcome.leftCents >= 0 ? 'Blijft er per maand over' : 'Kom je per maand tekort'}
				/>
			{:else}
				<HeroAmount cents={outcome.totalCents} label="Aan limieten per maand" />
			{/if}
			<p class="tell">{periodSentence(p.months)}.</p>
		</div>

		{#if hasIncome}
			<section class="card savings" aria-labelledby="savings-title">
				<h2 id="savings-title">Spaardoel</h2>
				<label class="field">
					<span>Wat je per maand wilt overhouden <span class="muted">(optioneel)</span></span>
					<span class="money">
						<span class="prefix" aria-hidden="true">€</span>
						<input
							bind:value={savingsText}
							inputmode="decimal"
							class="num"
							placeholder="0"
							aria-label="Spaardoel per maand"
							aria-invalid={savingsInvalid ? 'true' : undefined}
							aria-describedby="savings-help"
						/>
					</span>
				</label>
				{#if savingsInvalid}
					<p class="error-text" role="alert">Dat bedrag kan ik niet lezen.</p>
				{/if}
				<dl class="sums" id="savings-help">
					<div>
						<dt>Inkomen</dt>
						<dd class="num">{whole(p.incomeCents)}</dd>
					</div>
					{#if savingsCents > 0}
						<div>
							<dt>Te verdelen</dt>
							<dd class="num">{whole(outcome.distributableCents)}</dd>
						</div>
					{/if}
					<div>
						<dt>
							Limieten
							{#if p.withLimitCount > 0}<span class="muted"
									>· waarvan {whole(p.existingLimitsCents)} al ingesteld</span
								>{/if}
						</dt>
						<dd class="num">{whole(outcome.totalCents)}</dd>
					</div>
				</dl>
				<p class="muted small">
					Mediaan van je inkomen, zonder eigen overboekingen en terugbetalingen.
				</p>
				{#if short}
					<p class="short" role="status">
						<strong class="num">{whole(outcome.shortfallCents)}</strong> meer dan je wilt uitgeven. Bovenaan
						staan de categorieën waar je eerder al minder uitgaf.
					</p>
				{/if}
			</section>
		{/if}

		<form method="POST" action="?/apply" class="list" use:enhance={apply}>
			<div class="groups">
				{#each groups as [group, lines] (group)}
					<section class="group card" aria-labelledby="group-{group}">
						<h2 id="group-{group}">{group}</h2>
						<ul>
							{#each lines as l (l.categoryId)}
								{@const invalid =
									(isChecked(l) && centsOf(l) === null) || error?.categoryId === l.categoryId}
								<li class={['row', !isChecked(l) && 'off']}>
									<label class="pick">
										<input
											type="checkbox"
											name="kies"
											value={l.categoryId}
											checked={isChecked(l)}
											onchange={(e) => (checked[l.categoryId] = e.currentTarget.checked)}
										/>
										<span class="dot" style:--dot={groupColor(l.group)} aria-hidden="true"></span>
										<span class="name">{l.name}</span>
									</label>
									<span class="money small-money">
										<span class="prefix" aria-hidden="true">€</span>
										<input
											name="limiet-{l.categoryId}"
											inputmode="decimal"
											class="num"
											aria-label="Limiet {l.name}"
											value={valueOf(l)}
											oninput={(e) => {
												values[l.categoryId] = e.currentTarget.value;
												if (error?.categoryId === l.categoryId) error = null;
											}}
											aria-invalid={invalid ? 'true' : undefined}
											aria-describedby="range-{l.categoryId}"
										/>
									</span>
									<p class="range muted" id="range-{l.categoryId}">
										<span class="num">{whole(l.proposal.lowestCents)}</span> tot
										<span class="num">{whole(l.proposal.highestCents)}</span
										>{#if l.proposal.plannedCents > 0}, met
											<span class="num">{whole(l.proposal.plannedCents)}</span> gepland{/if}
									</p>
									{#if error?.categoryId === l.categoryId}
										<p class="error-text" role="alert">{error.message}</p>
									{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/each}
			</div>

			{#if without.length > 0}
				<section class="card without" aria-label="Zonder voorstel">
					<button
						type="button"
						class="toggle"
						aria-expanded={showWithout}
						aria-controls="without-list"
						onclick={() => (showWithout = !showWithout)}
					>
						<span class="count num">{without.length}</span>
						<span class="label">zonder voorstel</span>
						<svg class={['chevron', showWithout && 'open']} viewBox="0 0 20 20" aria-hidden="true"
							><path d="M5.5 7.5 10 12l4.5-4.5" /></svg
						>
					</button>
					{#if showWithout}
						<ul id="without-list" class="plain">
							{#each without as l (l.categoryId)}
								<li class="none">
									<span class="dot" style:--dot={groupColor(l.group)} aria-hidden="true"></span>
									<span class="name">{l.name}</span>
									<span class="muted">Geen uitgaven</span>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			{/if}

			<div class="submit">
				<button class="button" disabled={busy || chosen.length === 0}>
					Limieten instellen{#if chosen.length > 0}<span class="num"> ({chosen.length})</span>{/if}
				</button>
				<p class="muted small">
					Voor deze maand; volgende maanden nemen ze over. Een bestaande limiet blijft staan.
				</p>
			</div>
		</form>
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
		max-width: 64rem;
	}

	.intro,
	.hero {
		display: grid;
		gap: 8px;
	}

	.savings {
		display: grid;
		gap: 12px;
	}

	.savings h2,
	.group h2 {
		font-size: 1.3rem;
	}

	.field {
		display: grid;
		gap: 6px;
		font-weight: 550;
	}

	.field .muted {
		font-weight: 400;
	}

	.money {
		position: relative;
		display: grid;
	}

	.prefix {
		position: absolute;
		left: 14px;
		top: 50%;
		translate: 0 -50%;
		color: var(--muted);
		pointer-events: none;
	}

	.money input {
		padding-left: 32px;
		font-weight: 600;
	}

	.sums {
		display: grid;
		gap: 6px;
		margin: 0;
	}

	.sums div {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
	}

	.sums dd {
		margin: 0;
		font-weight: 600;
		white-space: nowrap;
	}

	.small {
		font-size: 0.88rem;
	}

	.short {
		padding: 10px 12px;
		border-radius: var(--radius-sm);
		background: color-mix(in oklch, var(--warn) 18%, transparent);
	}

	.list {
		display: grid;
		gap: 12px;
	}

	.groups {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
		align-items: start;
	}

	@container (min-width: 760px) {
		.groups {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.group {
		display: grid;
		gap: 10px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}

	/* Vinkje en naam links, het bedragveld rechts, de laagste en hoogste maand eronder */
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 7.5rem;
		align-items: center;
		column-gap: 12px;
		padding-block: 8px;
	}

	.row + .row {
		border-top: 1px solid var(--line);
	}

	.row .range,
	.row .error-text {
		grid-column: 1 / -1;
		padding-left: 32px;
		font-size: 0.88rem;
	}

	.row.off .name,
	.row.off .range {
		color: var(--muted);
	}

	.row.off input:not([type='checkbox']) {
		opacity: 0.6;
	}

	.pick {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: var(--tap);
		min-width: 0;
		cursor: pointer;
	}

	.pick input {
		flex: none;
		width: 20px;
		height: 20px;
		min-height: 0;
		margin: 0 2px 0 0;
		accent-color: var(--accent);
	}

	.name {
		min-width: 0;
		overflow-wrap: anywhere;
		font-weight: 550;
	}

	.small-money input {
		text-align: right;
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--dot);
	}

	.without {
		padding-block: 6px;
	}

	.toggle {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: var(--tap);
		padding: 0;
		border: 0;
		background: none;
		color: var(--text);
		font-weight: 600;
		text-align: left;
		cursor: pointer;
	}

	.toggle .label {
		flex: 1;
	}

	.count {
		display: inline-grid;
		place-items: center;
		min-width: 28px;
		height: 28px;
		padding: 0 8px;
		border-radius: 999px;
		background: var(--surface-2);
		font-size: 0.9rem;
	}

	.chevron {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
		color: var(--muted);
		transition: transform 220ms var(--ease-spring);
	}

	.chevron.open {
		transform: rotate(180deg);
	}

	.plain {
		border-top: 1px solid var(--line);
		margin-top: 6px;
	}

	.none {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 48px;
	}

	.none + .none {
		border-top: 1px solid var(--line);
	}

	.none .name {
		flex: 1;
		font-weight: 400;
	}

	.submit {
		display: grid;
		justify-items: start;
		gap: 8px;
	}
</style>
