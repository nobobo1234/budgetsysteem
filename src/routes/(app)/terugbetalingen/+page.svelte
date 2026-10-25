<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { fly } from 'svelte/transition';
	import HeroAmount from '#lib/components/HeroAmount.svelte';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { formatMonth, formatShortDate, formatShortMonth, shiftMonth } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';
	import { MONTH_STATE_LABEL, type MonthState } from '#lib/shares.ts';

	let { data, form } = $props();
	const o = $derived(data.overview);

	let busy = $state(false);
	/** Geopend vakje: persoon en maand */
	let opened = $state<{ personId: string; month: string } | null>(null);
	let confirm = $state<string | null>(null);

	const keep: SubmitFunction = () => {
		busy = true;
		return async ({ update }) => {
			await update({ reset: false });
			busy = false;
			confirm = null;
		};
	};

	const peopleOptions = $derived<SelectOption[]>([
		{ value: '', label: 'Nieuwe persoon' },
		...data.people.map((p) => ({ value: p.id, label: p.name }))
	]);

	// Startmaand: twee jaar terug tot een jaar vooruit
	const monthOptions = $derived<SelectOption[]>(
		Array.from({ length: 37 }, (_, i) => shiftMonth(data.today.slice(0, 7), i - 24))
			.reverse()
			.map((m) => ({ value: m, label: formatMonth(m) }))
	);

	const feedback = $derived(
		form && 'message' in form && form.message
			? { text: form.message, error: true }
			: form && 'received' in form
				? { text: 'Ontvangen en gekoppeld', error: false }
				: form && 'accepted' in form
					? { text: 'Aandeel toegevoegd', error: false }
					: form && 'dismissed' in form
						? { text: 'Voorstel komt niet terug', error: false }
						: form && 'unlinked' in form
							? { text: 'Betaling losgekoppeld', error: false }
							: form && 'payable' in form
								? { text: 'Post te betalen gemaakt', error: false }
								: form && 'restored' in form
									? { text: 'Kwijtschelden ongedaan gemaakt', error: false }
									: null
	);

	function toggle(personId: string, month: string) {
		opened = opened?.personId === personId && opened.month === month ? null : { personId, month };
		confirm = null;
	}

	const describe = (state: MonthState | 'geen', amount: number, paid: number) =>
		state === 'geen'
			? 'geen aandeel'
			: `${MONTH_STATE_LABEL[state].toLowerCase()}, ${formatCents(paid)} van ${formatCents(amount)}`;

	const shareText = (s: { kind: string; basisPoints: number | null; cents: number }) =>
		s.kind === 'percentage'
			? `${(s.basisPoints ?? 0) / 100}% (${formatCents(s.cents)})`
			: formatCents(s.cents);
</script>

<svelte:head>
	<title>Terugbetalingen · Budget</title>
</svelte:head>

<div class="page">
	<a class="back" href="/te-krijgen">
		<svg viewBox="0 0 20 20" aria-hidden="true">
			<path
				d="M12.5 4.5L7 10l5.5 5.5"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
		Te krijgen
	</a>

	<div class="intro">
		<h1>Terugbetalingen</h1>
		<HeroAmount cents={o.arrearsCents} label="Achterstand" />
		<p class="muted">
			Vervallen en nog niet volledig binnen{#if o.creditCents > 0}
				· <span class="num">{formatCents(o.creditCents)}</span> tegoed{/if}
		</p>
	</div>

	{#if feedback}
		{#key form}<Toast text={feedback.text} error={feedback.error} />{/key}
	{/if}

	{#if form && 'forgiven' in form && form.forgiven}
		<form method="POST" action="?/unforgive" use:enhance={keep} class="card undo" role="status">
			<input type="hidden" name="id" value={form.forgiven} />
			<span>Kwijtgescholden; dat deel telt nu in de categorie van de vaste last.</span>
			<button class="button secondary small" disabled={busy}>Ongedaan maken</button>
		</form>
	{/if}

	{#if data.due.length > 0}
		<section aria-labelledby="due-title" class="section">
			<h2 id="due-title">Klaar om te bevestigen</h2>
			<ul class="card list">
				{#each data.due as item (item.id)}
					<li out:fly={{ x: 32, duration: 220 }}>
						<div class="what">
							<span class="desc">{item.personName}</span>
							<span class="muted small">
								{item.counterparty} · verwacht {formatShortDate(item.dueDate)}
								{#if item.late}<span class="flag">Te laat</span>{/if}
							</span>
						</div>
						<span class="num amount in">+{formatCents(item.outstandingCents)}</span>
						<form method="POST" action="?/received" use:enhance={keep}>
							<input type="hidden" name="id" value={item.id} />
							<button
								class="button small"
								disabled={busy}
								aria-label="{formatCents(item.outstandingCents)} van {item.personName} ontvangen"
								>Ontvangen</button
							>
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#each data.proposals as p (p.key)}
		<form method="POST" action="?/accept" use:enhance={keep} class="card proposal">
			<h2>
				Krijg je van {p.personName ?? p.counterparty} elke maand
				<span class="num">{formatCents(p.amountCents)}</span> voor {p.recurringName}?
			</h2>
			<p class="muted small">
				Een vaste overboeking rond de {p.receiveDay}e, sinds {formatMonth(p.startMonth)}.
				{p.recurringName} kost <span class="num">{formatCents(p.recurringCents)}</span> per maand.
			</p>
			<input type="hidden" name="key" value={p.key} />
			<input type="hidden" name="recurringId" value={p.recurringId} />
			<input type="hidden" name="receiveDay" value={p.receiveDay} />
			<div class="grid">
				{#if p.personId}
					<input type="hidden" name="personId" value={p.personId} />
					<input type="hidden" name="newName" value="" />
				{:else}
					<div class="field">
						<label for="who-{p.key}">Wie</label>
						<Select id="who-{p.key}" name="personId" label="Wie" value="" options={peopleOptions} />
					</div>
					<label class="field">
						<span>Naam als nieuwe persoon</span>
						<input name="newName" maxlength="40" value="" autocomplete="off" />
					</label>
				{/if}
				<label class="field">
					<span>Aandeel per maand</span>
					<input
						name="amount"
						inputmode="decimal"
						class="num"
						value={centsToInput(p.amountCents)}
						required
						autocomplete="off"
					/>
				</label>
				<div class="field">
					<label for="start-{p.key}">Vanaf</label>
					<Select
						id="start-{p.key}"
						name="startMonth"
						label="Vanaf"
						value={p.startMonth}
						options={monthOptions}
					/>
				</div>
			</div>
			<p class="muted small">
				Een startmaand in het verleden maakt de posten vanaf die maand aan en koppelt de
				overboekingen die al binnen zijn.
			</p>
			<div class="actions">
				<button class="button" disabled={busy}>Ja, aandeel</button>
				<button class="button secondary" formaction="?/dismiss" disabled={busy}>Nee</button>
			</div>
		</form>
	{/each}

	<section aria-label="Per persoon" class="people">
		{#each o.persons as person (person.personId)}
			<article class="card person" in:fly={{ y: 8, duration: 220 }}>
				<header>
					<h2>{person.name}</h2>
					{#if person.arrearsCents > 0}
						<span class="num late-sum">{formatCents(person.arrearsCents)} achter</span>
					{/if}
				</header>
				<p class="muted small">
					Afgelopen zes maanden <span class="num">{formatCents(person.receivedCents)}</span>
					ontvangen van <span class="num">{formatCents(person.expectedCents)}</span> verwacht
				</p>

				<ol class="boxes" aria-label="Laatste zes maanden van {person.name}">
					{#each person.boxes as box (box.month)}
						{@const isOpen = opened?.personId === person.personId && opened.month === box.month}
						<li>
							<button
								type="button"
								class={['box', box.state]}
								disabled={box.state === 'geen'}
								aria-expanded={box.state === 'geen' ? undefined : isOpen}
								aria-label="{formatMonth(box.month)}: {describe(
									box.state,
									box.amountCents,
									box.paidCents
								)}"
								onclick={() => toggle(person.personId, box.month)}
							>
								<span class="month">{formatShortMonth(box.month)}</span>
								<svg viewBox="0 0 20 20" aria-hidden="true">
									{#if box.state === 'binnen'}
										<path d="M5 10.5l3.2 3L15 6.5" />
									{:else if box.state === 'deels'}
										<circle cx="10" cy="10" r="6" />
										<path d="M10 4a6 6 0 0 1 0 12z" class="fill" />
									{:else if box.state === 'open'}
										<circle cx="10" cy="10" r="6" />
									{:else if box.state === 'te_laat'}
										<path d="M10 4.5v7M10 15v.5" />
									{:else if box.state === 'kwijtgescholden'}
										<path d="M5.5 10h9" />
									{:else}
										<path d="M8 10h4" class="faint" />
									{/if}
								</svg>
								<span class="state">{MONTH_STATE_LABEL[box.state]}</span>
							</button>
						</li>
					{/each}
				</ol>

				{#each person.boxes as box (box.month)}
					{#if opened?.personId === person.personId && opened.month === box.month}
						<div class="detail" in:fly={{ y: -6, duration: 180 }}>
							<h3>{formatMonth(box.month)}</h3>
							{#each box.posts as post (post.id)}
								<div class="post">
									<div class="row">
										<div class="what">
											<span class="desc">{post.counterparty}</span>
											<span class="muted small">
												{MONTH_STATE_LABEL[post.state]} · verwacht {formatShortDate(post.dueDate)}
											</span>
										</div>
										<span class="num amount">
											{formatCents(post.paidCents)} / {formatCents(post.amountCents)}
										</span>
									</div>
									{#if post.payments.length > 0}
										<ul class="payments">
											{#each post.payments as pay (pay.transactionId)}
												<li>
													<a href="/transacties/{pay.transactionId}"
														>{formatShortDate(pay.date)}
														<span class="num">{formatCents(pay.amountCents)}</span></a
													>
													<form method="POST" action="?/unlink" use:enhance={keep}>
														<input type="hidden" name="id" value={pay.transactionId} />
														<button class="link" disabled={busy}>Loskoppelen</button>
													</form>
												</li>
											{/each}
										</ul>
									{:else}
										<p class="muted small">Nog geen betaling gekoppeld.</p>
									{/if}
									<div class="actions">
										{#if post.state === 'kwijtgescholden'}
											<form method="POST" action="?/unforgive" use:enhance={keep}>
												<input type="hidden" name="id" value={post.id} />
												<button class="button secondary small" disabled={busy}
													>Kwijtschelden ongedaan maken</button
												>
											</form>
										{:else if post.state !== 'binnen'}
											<form method="POST" action="?/received" use:enhance={keep}>
												<input type="hidden" name="id" value={post.id} />
												<button class="button small" disabled={busy}>Ontvangen</button>
											</form>
											{#if confirm === post.id}
												<form method="POST" action="?/forgive" use:enhance={keep}>
													<input type="hidden" name="id" value={post.id} />
													<button class="button danger small" disabled={busy}
														>Ja, kwijtschelden</button
													>
												</form>
												<button
													type="button"
													class="button secondary small"
													onclick={() => (confirm = null)}>Annuleren</button
												>
											{:else}
												<button
													type="button"
													class="button danger small"
													onclick={() => (confirm = post.id)}>Kwijtschelden</button
												>
											{/if}
										{/if}
									</div>
									{#if confirm === post.id}
										<p class="small">
											<span class="num">{formatCents(post.amountCents - post.paidCents)}</span> telt
											dan in {formatMonth(box.month)} als jouw uitgave.
										</p>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				{/each}

				{#if person.creditCents > 0}
					<form method="POST" action="?/payable" use:enhance={keep} class="credit">
						<input type="hidden" name="personId" value={person.personId} />
						<p class="small">
							<span class="num">{formatCents(person.creditCents)}</span> tegoed; gaat naar de volgende
							post. Te veel betaald?
						</p>
						<button class="button secondary small" disabled={busy}
							>Maak er een post te betalen van</button
						>
					</form>
				{/if}
			</article>
		{:else}
			<div class="empty">
				<h2>Nog geen gedeelde vaste lasten</h2>
				<p class="muted">
					Betaal je iets voor het hele huis, zoals de wifi? Geef huisgenoten een aandeel bij de
					vaste last; hun maandelijkse overboekingen komen dan hier.
				</p>
				<a class="button secondary" href="/vaste-lasten">Naar vaste lasten</a>
			</div>
		{/each}
	</section>

	{#if o.persons.length > 0}
		<p class="legend muted small">
			Elk vakje is een maand: binnen, deels, open, te laat of kwijtgescholden. Te laat is een week
			na de verwachte dag nog niet volledig binnen. Tik op een maand voor de betalingen.
		</p>
	{/if}

	{#if o.lasts.length > 0}
		<section aria-labelledby="lasts-title" class="section">
			<h2 id="lasts-title">Gedeelde vaste lasten</h2>
			<ul class="card list">
				{#each o.lasts as last (last.recurringId)}
					<li>
						<a class="what" href="/vaste-lasten/{last.recurringId}">
							<span class="desc">{last.counterparty}</span>
							<span class="muted small">
								{#each last.shares as s, i (s.id)}{i > 0 ? ' · ' : ''}{s.name}
									{shareText(s)}{:else}Geen aandelen deze maand{/each}
							</span>
						</a>
						<span class="lastsum">
							<span class="num">{formatCents(last.grossCents)}</span>
							<span class="muted small"
								>jouw deel <span class="num">{formatCents(last.mineCents)}</span></span
							>
						</span>
					</li>
				{/each}
			</ul>
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

	.back {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		justify-self: start;
		min-height: var(--tap);
		margin: 0 0 -16px -6px;
		text-decoration: none;
		font-weight: 550;
	}

	.back svg {
		width: 20px;
		height: 20px;
	}

	.intro,
	.section {
		display: grid;
		gap: 10px;
	}

	.small {
		font-size: 0.88rem;
	}

	.button.small {
		min-height: var(--tap);
		padding: 0 14px;
		font-size: 0.92rem;
	}

	.undo,
	.credit {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.credit {
		padding-top: 10px;
		border-top: 1px solid var(--line);
	}

	ul,
	ol {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list li {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: var(--tap);
		padding: 8px 0;
	}

	.list li + li {
		border-top: 1px solid var(--line);
	}

	.what {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
		overflow-wrap: anywhere;
		color: inherit;
		text-decoration: none;
	}

	.desc {
		font-weight: 550;
	}

	.amount {
		font-weight: 600;
		white-space: nowrap;
	}

	.in {
		color: var(--accent-strong);
	}

	.flag {
		margin-left: 4px;
		padding: 1px 8px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--warn) 22%, transparent);
		color: var(--text);
		font-weight: 600;
	}

	.lastsum {
		display: grid;
		justify-items: end;
		font-weight: 600;
		white-space: nowrap;
	}

	.lastsum .small {
		font-weight: 400;
	}

	.proposal {
		display: grid;
		gap: 12px;
		padding: 18px;
		border-left: 4px solid var(--accent);
	}

	.proposal h2 {
		font-size: 1.15rem;
	}

	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 14px;
	}

	@container (min-width: 560px) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.field > span:first-child,
	.field > label {
		font-weight: 550;
		font-size: 0.95rem;
	}

	.field input {
		width: 100%;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.people {
		display: grid;
		gap: 16px;
	}

	.person {
		display: grid;
		gap: 10px;
		padding: 18px;
	}

	.person header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.late-sum {
		font-weight: 650;
	}

	.boxes {
		display: grid;
		grid-template-columns: repeat(6, minmax(0, 1fr));
		gap: 6px;
	}

	.box {
		width: 100%;
		min-height: 64px;
		display: grid;
		justify-items: center;
		align-content: center;
		gap: 2px;
		padding: 6px 2px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.box:active:not(:disabled) {
		transform: scale(0.96);
	}

	.box:disabled {
		cursor: default;
		background: transparent;
		color: var(--muted);
	}

	.box[aria-expanded='true'] {
		outline: 2px solid var(--text);
		outline-offset: 1px;
	}

	.box svg {
		width: 20px;
		height: 20px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.box svg .fill {
		fill: currentColor;
		stroke: none;
	}

	.box svg .faint {
		opacity: 0.5;
	}

	.month {
		font-size: 0.8rem;
		font-weight: 600;
	}

	.state {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.68rem;
	}

	.box.binnen {
		background: var(--accent-soft);
		border-color: transparent;
		color: var(--accent-strong);
	}

	.box.deels {
		border-color: var(--accent);
	}

	.box.te_laat {
		background: color-mix(in oklch, var(--warn) 24%, var(--surface));
		border-color: transparent;
	}

	.box.kwijtgescholden {
		background: var(--surface-2);
		color: var(--muted);
	}

	.detail {
		display: grid;
		gap: 10px;
		padding: 12px 0 4px;
		border-top: 1px solid var(--line);
	}

	.detail h3 {
		font-size: 1rem;
	}

	.post {
		display: grid;
		gap: 6px;
	}

	.post + .post {
		padding-top: 10px;
		border-top: 1px solid var(--line);
	}

	.row {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.payments li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 4px 12px;
	}

	.payments a {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: var(--tap);
	}

	.link {
		min-height: var(--tap);
		padding: 0;
		border: 0;
		background: none;
		color: var(--accent-strong);
		font: inherit;
		font-weight: 550;
		cursor: pointer;
	}

	.empty {
		display: grid;
		gap: 10px;
		justify-items: start;
		padding: 8px 0;
	}

	.legend {
		margin-top: -12px;
	}
</style>
