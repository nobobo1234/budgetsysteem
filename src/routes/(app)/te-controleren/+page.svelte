<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { formatShortDate } from '#lib/dates.ts';
	import * as icons from '#lib/icons.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';
	import { daysBetween, formatOpenFor } from '#lib/owed.ts';
	import { reminderText } from '#lib/remind.ts';
	import { fieldList, receiptAmount } from '#lib/receipts.ts';
	import { displayName, initials } from '#lib/text.ts';

	// Review-inbox (spec: Schermen): alles wat op een besluit wacht, per soort een groep met
	// zijn eigen actie. Bonnen staan bovenaan.
	// De rijen zijn bewust eigen markup en geen ExpectedItem of TransactionItem: deelt deze
	// pagina die componenten met het startscherm, dan splitst Vite ze in losse chunks en wordt
	// de eerste JS-bundel van het startscherm zo'n 2,5 kB groter (budget in lighthouse.mjs).
	// Om dezelfde reden komen de tinten (`hue`) van de server.

	let { data } = $props();
	const inbox = $derived(data.inbox);

	let toast = $state<{ text: string; error: boolean; key: number } | null>(null);
	const notify = (text: string, error = false) => (toast = { text, error, key: Date.now() });

	// Eén formulier tegelijk bezig; de knop van dat formulier staat uit tot het antwoord er is
	let busy = $state<string | null>(null);
	const act =
		(key: string, done: string | ((form: FormData) => string)): SubmitFunction =>
		({ formData }) => {
			busy = key;
			return async ({ result, update }) => {
				busy = null;
				if (result.type === 'success') {
					notify(typeof done === 'string' ? done : done(formData));
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

	// Leest door vanaf het grote getal erboven: "3 dingen wachten op een besluit van je."
	const sentence = $derived(
		data.count === 1 ? 'ding wacht op een besluit van je.' : 'dingen wachten op een besluit van je.'
	);

	// Gemist of opgezegd? Eerst "Niet afgeschreven", dan de keuze; opgezegd stopt de vaste last
	let asking = $state<string | null>(null);
	const skipped = (name: string) => (form: FormData) =>
		form.get('reason') === 'opgezegd' ? `${name} gestopt.` : `${name} deze keer overgeslagen.`;

	// Zoals groupColor in categoryColor.ts
	const dot = (hue: number | null) =>
		hue === null ? null : `oklch(var(--dot-l) var(--dot-c) ${hue})`;

	const amountText = (tx: (typeof inbox.transactions)[number]) =>
		tx.amountCents === 0 && tx.origCurrency && tx.origAmountCents !== null
			? `${tx.origCurrency === 'USD' ? '$' : `${tx.origCurrency} `}${centsToInput(tx.origAmountCents)}`
			: formatCents(tx.amountCents, { sign: true });

	const creditText = {
		dubbel: 'Meer ontvangen dan er openstond; gaat anders naar de volgende maand.',
		vertrokken: 'Binnengekomen na het vertrek; er komt geen post meer.',
		teveel: 'Meer ontvangen dan er openstond.'
	};

	// Herinneren via het deelmenu van de telefoon (Web Share); anders de tekst kopiëren
	async function remind(post: (typeof inbox.reminders)[number]) {
		const text = reminderText(post.personName ?? '', [post], (c) => formatCents(c));
		try {
			if (navigator.share) await navigator.share({ text });
			else {
				await navigator.clipboard.writeText(text);
				notify('Herinnering gekopieerd; plak hem in een bericht.');
			}
		} catch (e) {
			// Annuleren in het deelmenu is geen fout
			if (e instanceof DOMException && e.name === 'AbortError') return;
			notify('Delen lukte niet op dit apparaat.', true);
		}
	}
</script>

<svelte:head>
	<title>Te controleren · Budget</title>
</svelte:head>

{#snippet leave(kind: 'te_laat' | 'herinnering' | 'tegoed', id: string, name: string)}
	<form
		method="POST"
		action="?/leave"
		use:enhance={act(`leave:${id}`, 'Laten staan; hier zie je hem niet meer.')}
	>
		<input type="hidden" name="kind" value={kind} />
		<input type="hidden" name="id" value={id} />
		<button
			class="text-button muted"
			disabled={busy === `leave:${id}`}
			aria-label="{name} laten staan">Laten staan</button
		>
	</form>
{/snippet}

{#snippet groupHead(id: string, title: string, n: number, note: string, more?: string)}
	<div class="head">
		<h2 {id}>{title}</h2>
		<span class="count num" aria-label="{n} {n === 1 ? 'post' : 'posten'}">{n}</span>
		{#if more}<a class="more-link" href={more}>Alle {title.toLowerCase()}</a>{/if}
	</div>
	<p class="muted small note">{note}</p>
{/snippet}

<div class="page">
	<div class="intro">
		<BackLink parents={['/', '/import']} />
		<h1>Te controleren</h1>
		{#if data.count > 0}
			<div class="total">
				<p class="big num" data-morph-head="bedrag">{data.count}</p>
				<p class="tell">{sentence}</p>
			</div>
		{/if}
	</div>

	{#if inbox.receipts.length > 0}
		<section class="group" aria-labelledby="receipts-title">
			{@render groupHead(
				'receipts-title',
				'Bonnen',
				inbox.receipts.length,
				'Wat Haiku niet zeker las, of waar je zelf kiest bij welke transactie hij hoort.',
				'/bonnen'
			)}
			<ul class="card list">
				{#each inbox.receipts as bon (bon.id)}
					{@const name = bon.store ? displayName(bon.store) || bon.store : 'Bon'}
					<li class="item">
						<div class="row">
							<span class="monogram sm" aria-hidden="true">{initials(bon.store || 'Bon')}</span>
							<a class="who" href="/bonnen/{bon.id}">
								<span class="name">{name}</span>
								<span class="muted small">
									{bon.date ? formatShortDate(bon.date) : 'Zonder datum'}{bon.source === 'deelmenu'
										? ' · via deelmenu'
										: ''}
								</span>
							</a>
							<span class="num amount">{receiptAmount(bon.totalCents, bon.currency)}</span>
						</div>
						<div class="why">
							{#if bon.stage === 'fout'}
								<p class="small">Kon niet gelezen worden.</p>
								<div class="actions">
									<a
										class="button secondary small"
										href="/bonnen/{bon.id}"
										aria-label="{name} zelf invullen">Zelf invullen</a
									>
								</div>
							{:else if bon.stage === 'kiezen'}
								<p class="small">Gelezen; kies de transactie waar hij bij hoort.</p>
								<div class="actions">
									<a
										class="button secondary small"
										href="/bonnen/{bon.id}"
										aria-label="{name} koppelen">Kiezen</a
									>
								</div>
							{:else if bon.stage === 'nakijken'}
								<p class="small">
									Verwerkt{bon.transaction
										? ` bij ${displayName(bon.transaction.counterparty) || 'een transactie'}`
										: ''}{bon.doubt.length > 0 ? `; twijfel over ${fieldList(bon.doubt)}` : ''}.
								</p>
								<div class="actions">
									<form
										method="POST"
										action="?/confirmReceipt"
										use:enhance={act(`bon:${bon.id}`, `${name} klopt.`)}
									>
										<input type="hidden" name="id" value={bon.id} />
										<button
											class="button secondary small"
											disabled={busy === `bon:${bon.id}`}
											aria-label="Bon van {name} klopt">Klopt</button
										>
									</form>
									<a class="text-button" href="/bonnen/{bon.id}" aria-label="{name} nakijken"
										>Nakijken</a
									>
								</div>
							{:else}
								<p class="small">
									{bon.doubt.length > 0
										? `Twijfel over ${fieldList(bon.doubt)}.`
										: 'Haiku twijfelt.'} Er is nog niets geboekt.
								</p>
								<div class="actions">
									<a
										class="button secondary small"
										href="/bonnen/{bon.id}"
										aria-label="{name} nakijken">Nakijken</a
									>
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if inbox.missed.length > 0}
		<section class="group" aria-labelledby="missed-title">
			{@render groupHead(
				'missed-title',
				'Gemist of opgezegd?',
				inbox.missed.length,
				'Al meer dan een week niet afgeschreven. Kwam hij toch, bevestig hem dan.'
			)}
			<ul class="card list">
				{#each inbox.missed as item (item.id)}
					{@const name = displayName(item.counterparty)}
					<li class="item">
						<div class="row">
							<span
								class={['monogram', 'sm', item.categoryGroup && 'hue']}
								style:--h={item.hue}
								aria-hidden="true">{initials(item.counterparty)}</span
							>
							<a class="who" href="/vaste-lasten/{item.recurringId}">
								<span
									class="name"
									data-morph-to="/vaste-lasten/{item.recurringId}"
									data-morph-part="titel">{name}</span
								>
								<span class="muted small">
									<span
										class={['dot', !item.categoryGroup && 'none']}
										style:--dot={dot(item.hue)}
										aria-hidden="true"
									></span>
									{item.categoryName ?? 'Geen categorie'} · verwacht {formatShortDate(item.date)}
								</span>
							</a>
							<span class="num amount">{formatCents(item.amountCents)}</span>
						</div>
						{#if asking === item.id}
							<form
								class="actions"
								method="POST"
								action="?/skipExpected"
								use:enhance={act(item.id, skipped(name))}
							>
								<input type="hidden" name="id" value={item.id} />
								<button
									class="button secondary small"
									name="reason"
									value="gemist"
									disabled={busy === item.id}>Deze keer niet</button
								>
								<button
									class="text-button danger-text"
									name="reason"
									value="opgezegd"
									disabled={busy === item.id}>Opgezegd</button
								>
								<button type="button" class="text-button muted" onclick={() => (asking = null)}
									>Annuleren</button
								>
							</form>
						{:else}
							<div class="actions">
								<form
									class="confirm"
									method="POST"
									action="?/confirmExpected"
									use:enhance={act(item.id, `${name} bevestigd.`)}
								>
									<input type="hidden" name="id" value={item.id} />
									{#if item.kind === 'wisselend'}
										<label class="money">
											<span class="visually-hidden">Bedrag {name}</span>
											<span class="prefix" aria-hidden="true">€</span>
											<input
												name="amount"
												inputmode="decimal"
												class="num"
												value={centsToInput(item.amountCents)}
												autocomplete="off"
												required
											/>
										</label>
									{/if}
									<button
										class="button secondary small"
										disabled={busy === item.id}
										aria-label="Bevestig {name}">Toch afgeschreven</button
									>
								</form>
								<button
									type="button"
									class="text-button"
									onclick={() => (asking = item.id)}
									aria-label="{name} niet afgeschreven">Niet afgeschreven</button
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if inbox.transactions.length > 0}
		<section class="group" aria-labelledby="tx-title">
			{@render groupHead(
				'tx-title',
				'Boekingen',
				inbox.transactions.length,
				'Storno’s, terugboekingen en boekingen zonder eurobedrag tellen al mee in je saldo.'
			)}
			<ul class="card list">
				{#each inbox.transactions as tx (tx.id)}
					{@const name = displayName(tx.counterparty) || 'Deze boeking'}
					<li class="item">
						<div class="row">
							<span
								class={['monogram', 'sm', tx.categoryGroup && 'hue']}
								style:--h={tx.hue}
								aria-hidden="true">{initials(tx.counterparty || '?')}</span
							>
							<a class="who" href="/transacties/{tx.id}">
								<span class="name" data-tx-name={tx.id}>{name}</span>
								<span class="muted small">
									<span
										class={['dot', !tx.categoryGroup && 'none']}
										style:--dot={dot(tx.hue)}
										aria-hidden="true"
									></span>
									{tx.categoryName ?? 'Geen categorie'} · {formatShortDate(tx.date)} · {tx.accountAlias}
								</span>
							</a>
							<span class={['num', 'amount', tx.amountCents > 0 && 'in']} data-tx-amount={tx.id}
								>{amountText(tx)}</span
							>
						</div>
						<div class="why">
							{#if tx.reason === 'bedrag'}
								<p class="small">Het eurobedrag ontbreekt nog.</p>
								<div class="actions">
									<a class="button secondary small" href="/transacties/{tx.id}">Bedrag invullen</a>
								</div>
							{:else if tx.reason === 'koppelen' && tx.match}
								<p class="small">
									Hoort waarschijnlijk bij {displayName(tx.match.counterparty)} van {formatShortDate(
										tx.match.date
									)}.
								</p>
								<div class="actions">
									<a
										class="button secondary small"
										href="/transacties/{tx.id}"
										aria-label="{name} koppelen aan een eerdere boeking">Koppelen</a
									>
									<form method="POST" action="?/confirm" use:enhance={act(tx.id, `${name} klopt.`)}>
										<input type="hidden" name="id" value={tx.id} />
										<button
											class="text-button"
											disabled={busy === tx.id}
											aria-label="{name} klopt zo, niet koppelen">Klopt zo</button
										>
									</form>
								</div>
							{:else}
								<p class="small">Klopt het bedrag? Dan telt hij als gewone boeking.</p>
								<div class="actions">
									<form method="POST" action="?/confirm" use:enhance={act(tx.id, `${name} klopt.`)}>
										<input type="hidden" name="id" value={tx.id} />
										<button
											class="button secondary small"
											disabled={busy === tx.id}
											aria-label="{name} klopt">Klopt</button
										>
									</form>
								</div>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if inbox.late.length > 0}
		<section class="group" aria-labelledby="late-title">
			{@render groupHead(
				'late-title',
				'Te laat',
				inbox.late.length,
				'Een week na de ontvangstdag nog niet (helemaal) binnen.'
			)}
			<ul class="card list">
				{#each inbox.late as item (item.id)}
					<li class="item">
						<div class="row">
							<span class="monogram sm hue" style:--h={item.hue} aria-hidden="true"
								>{initials(item.personName)}</span
							>
							<a class="who" href="/terugbetalingen">
								<span class="name">{item.personName}</span>
								<span class="muted small">
									{displayName(item.counterparty)} · verwacht {formatShortDate(item.dueDate)} ·
									{formatOpenFor(daysBetween(item.dueDate, data.today))} te laat
								</span>
							</a>
							<span class="num in">+{formatCents(item.outstandingCents)}</span>
						</div>
						<div class="actions">
							<form
								method="POST"
								action="?/received"
								use:enhance={act(item.id, `${item.personName} ontvangen.`)}
							>
								<input type="hidden" name="id" value={item.id} />
								<button
									class="button secondary small"
									disabled={busy === item.id}
									aria-label="{formatCents(item.outstandingCents)} van {item.personName} ontvangen"
									>Ontvangen</button
								>
							</form>
							{@render leave('te_laat', item.id, item.personName)}
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if inbox.credit.length > 0}
		<section class="group" aria-labelledby="credit-title">
			{@render groupHead(
				'credit-title',
				'Tegoed',
				inbox.credit.length,
				'Dubbel betaald of na een vertrek. Laat het staan, of geef het terug.'
			)}
			<ul class="card list">
				{#each inbox.credit as item (item.personId)}
					<li class="item">
						<div class="row">
							<span class="monogram sm hue" style:--h={item.hue} aria-hidden="true"
								>{initials(item.personName)}</span
							>
							<a class="who" href="/terugbetalingen">
								<span class="name">{item.personName}</span>
								<span class="muted small"
									>{creditText[item.reason]} Laatst op {formatShortDate(item.date)}.</span
								>
							</a>
							<span class="num in">+{formatCents(item.creditCents)}</span>
						</div>
						<div class="actions">
							<form
								method="POST"
								action="?/payable"
								use:enhance={act(
									`pay:${item.personId}`,
									`${formatCents(item.creditCents)} staat nu bij te betalen aan ${item.personName}.`
								)}
							>
								<input type="hidden" name="personId" value={item.personId} />
								<button
									class="button secondary small"
									disabled={busy === `pay:${item.personId}`}
									aria-label="{formatCents(item.creditCents)} teruggeven aan {item.personName}"
									>Teruggeven</button
								>
							</form>
							{@render leave('tegoed', item.personId, `Tegoed van ${item.personName}`)}
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if inbox.reminders.length > 0}
		<section class="group" aria-labelledby="remind-title">
			{@render groupHead(
				'remind-title',
				'Herinneren',
				inbox.reminders.length,
				'Staat al twee weken of langer open. De app stuurt zelf niets.'
			)}
			<ul class="card list">
				{#each inbox.reminders as post (post.id)}
					{@const who = post.personName ?? 'Nog niet gekozen'}
					<li class="item">
						<div class="row">
							<span class="monogram sm hue" style:--h={post.hue} aria-hidden="true"
								>{initials(who)}</span
							>
							<a class="who" href="/te-krijgen">
								<span class="name">{who}</span>
								<span class="muted small">
									{post.description || 'Voorgeschoten'} · {formatOpenFor(post.daysOpen)} open
								</span>
							</a>
							<span class="num in">+{formatCents(post.outstandingCents)}</span>
						</div>
						<div class="actions">
							{#if post.personName}
								<button
									type="button"
									class="button secondary small"
									onclick={() => remind(post)}
									aria-label="{post.personName} herinneren">Herinneren</button
								>
							{:else}
								<a class="button secondary small" href="/te-krijgen">Persoon kiezen</a>
							{/if}
							{@render leave('herinnering', post.id, `Post van ${who}`)}
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if data.count === 0}
		<div class="card">
			<EmptyState
				icon={icons.controleren}
				text="Niets te controleren. Wat de app niet zeker weet, zoals een storno, een gemiste vaste last of een onleesbare bon, komt hier te staan."
			>
				<a class="button secondary" href="/">Naar het overzicht</a>
			</EmptyState>
		</div>
	{/if}

	{#if toast}
		{#key toast.key}<Toast text={toast.text} error={toast.error} />{/key}
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
		gap: 14px;
	}

	.total {
		display: grid;
		gap: 2px;
	}

	/* Hoeveel er wacht: het grote getal van het signaalkaartje schuift hierheen */
	.big {
		font-size: clamp(2.6rem, 11vw, 3.6rem);
		font-weight: 650;
		letter-spacing: -0.03em;
		line-height: 1;
	}

	.group {
		display: grid;
		gap: 8px;
	}

	.head {
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
		background: color-mix(in oklch, var(--warn) 22%, transparent);
		color: color-mix(in oklch, var(--warn) 60%, var(--text));
		font-size: 0.88rem;
		font-weight: 650;
	}

	.note {
		margin-bottom: 4px;
	}

	.small {
		font-size: 0.88rem;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0 16px;
		display: grid;
	}

	.list > li + li {
		border-top: 1px solid var(--line);
	}

	.item {
		display: grid;
		gap: 6px;
		padding: 10px 0;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: var(--tap);
	}

	.who {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
		color: inherit;
		text-decoration: none;
		overflow-wrap: anywhere;
		transition: transform 160ms var(--ease-spring);
	}

	.who:active {
		transform: scale(0.99);
	}

	.name {
		font-weight: 560;
	}

	.in {
		color: var(--accent-strong);
		font-weight: 600;
		white-space: nowrap;
	}

	/* Waarom hij hier staat en wat je ermee kunt, ingesprongen tot onder de naam (monogram van
	   32 px plus 12 px tussenruimte) */
	.why {
		display: grid;
		gap: 4px;
	}

	.why,
	.row + .actions {
		padding-left: 44px;
	}

	/* Het bolletje loopt mee in de tekst, zodat het bij een smal scherm niet alleen staat */
	.dot {
		display: inline-block;
		margin-right: 4px;
		vertical-align: 1px;
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--dot);
	}

	.dot.none {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--muted);
	}

	.amount {
		font-weight: 600;
		white-space: nowrap;
	}

	.confirm {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.money {
		position: relative;
		flex: 1 1 7rem;
		max-width: 9rem;
	}

	.money input {
		width: 100%;
		padding-left: 28px;
		font-weight: 600;
	}

	.prefix {
		position: absolute;
		left: 12px;
		top: 50%;
		translate: 0 -50%;
		color: var(--muted);
		pointer-events: none;
	}

	.text-button.danger-text {
		color: var(--danger);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
	}

	.button.small {
		min-height: var(--tap);
		padding: 0 16px;
		font-size: 0.92rem;
	}

	.text-button {
		min-height: var(--tap);
		padding: 0 4px;
		border: 0;
		background: none;
		color: var(--accent-strong);
		font-weight: 600;
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.text-button:active {
		transform: scale(0.96);
	}

	a.text-button {
		display: inline-flex;
		align-items: center;
		text-decoration: none;
	}

	.head .more-link {
		margin-left: auto;
	}

	.text-button.muted {
		color: var(--muted);
	}

	.text-button[disabled] {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
