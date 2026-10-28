<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import BackLink from '#lib/components/BackLink.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import WarrantyStrip from '#lib/components/WarrantyStrip.svelte';
	import { formatShortDate } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';
	import { displayName } from '#lib/text.ts';
	import {
		firstYearEnd,
		LIFETIME_KINDS,
		lifetimeEnd,
		MAX_LIFETIME_YEARS,
		warrantySentence
	} from '#lib/warranty.ts';

	// Garantieproduct (spec: Schermen): product en bedrag groot met één zin over wat er geldt, de
	// strook groter, Gegevens met "Bewerken", het bewijs (transactie en bon, of de hint om een foto
	// te maken) en afdanken met bevestiging. Nooit "verlopen"; de levensduur is een schatting.

	let { data, form } = $props();
	const w = $derived(data.warranty);
	const store = $derived(displayName(w.counterparty) || 'de winkel');
	const active = $derived(w.status === 'actief');

	let editing = $state(false);
	let busy = $state(false);
	let confirmDiscard = $state(false);
	// Gekozen levensduur in het formulier; een soort vult hem in, daarna is hij aan te passen
	let years = $state(0);

	const keep: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			busy = false;
			if (result.type === 'success') {
				editing = false;
				confirmDiscard = false;
			}
		};
	};

	function edit() {
		years = w.lifetimeYears;
		editing = true;
	}

	const fmt = (iso: string) => `${formatShortDate(iso)} ${iso.slice(0, 4)}`;

	const feedback = $derived(
		form && 'message' in form && form.message
			? { text: form.message, error: true }
			: form && 'saved' in form
				? { text: 'Opgeslagen', error: false }
				: form && 'discarded' in form
					? { text: `${w.product} afgedankt`, error: false }
					: null
	);

	const parents = $derived(['/garantie', '/te-controleren', `/transacties/${w.transactionId}`]);
	const labels = $derived({ [`/transacties/${w.transactionId}`]: 'Transactie' });
</script>

<svelte:head>
	<title>{w.product} · Garantie · Budget</title>
</svelte:head>

<div class="page">
	<BackLink {parents} {labels} />

	<header>
		<h1>{w.product}</h1>
		<p class="amount num">
			<span class="visually-hidden">Betaald </span>{formatCents(-w.amountCents)}
		</p>
		<p class="muted">{store} · {fmt(w.purchaseDate)}</p>
		<p class="tell">{warrantySentence(w, store, data.today)}</p>
	</header>

	{#if feedback}
		{#key form}<Toast text={feedback.text} error={feedback.error} />{/key}
	{/if}

	<section class="card" aria-label="Tijdlijn">
		<WarrantyStrip {w} today={data.today} large />
	</section>

	{#if editing}
		<form method="POST" action="?/save" class="card form" use:enhance={keep}>
			<label class="field">
				<span>Product</span>
				<input name="product" value={w.product} maxlength="60" required autocomplete="off" />
			</label>
			<label class="field">
				<span>Afleverdatum</span>
				<input type="date" name="deliveryDate" value={w.deliveryDate} required />
				<span class="muted hint">Het eerste jaar telt vanaf de dag dat je het product kreeg.</span>
			</label>
			<label class="field">
				<span>Fabrieksgarantie tot</span>
				<input type="date" name="factoryUntil" value={w.factoryUntil ?? ''} />
				<span class="muted hint">Van het garantiebewijs; leeg als je het niet weet.</span>
			</label>
			<fieldset class="field">
				<legend>Soort product</legend>
				<div class="segmented">
					{#each LIFETIME_KINDS as k (k.key)}
						<label>
							<input
								type="radio"
								name="kind"
								value={k.key}
								checked={years === k.years}
								onchange={() => (years = k.years)}
							/>
							<span>{k.label}</span>
						</label>
					{/each}
				</div>
			</fieldset>
			<label class="field">
				<span>Verwachte levensduur in jaren</span>
				<input
					type="number"
					name="lifetimeYears"
					bind:value={years}
					min="1"
					max={MAX_LIFETIME_YEARS}
					inputmode="numeric"
					class="num"
					required
				/>
				<span class="muted hint"
					>Een schatting van hoe lang je het product mag verwachten; zo lang kan de wettelijke
					garantie ongeveer gelden.</span
				>
			</label>
			<div class="save">
				<button class="button" disabled={busy}>{busy ? 'Opslaan…' : 'Opslaan'}</button>
				<button type="button" class="button secondary" onclick={() => (editing = false)}
					>Annuleren</button
				>
			</div>
		</form>
	{:else}
		<section class="card details" aria-labelledby="details-title">
			<div class="section-head">
				<h2 id="details-title">Gegevens</h2>
				{#if active}
					<button type="button" class="button secondary small" onclick={edit}>Bewerken</button>
				{/if}
			</div>
			<dl>
				<div>
					<dt>Afgeleverd</dt>
					<dd>{fmt(w.deliveryDate)}</dd>
				</div>
				<div>
					<dt>Eerste jaar tot</dt>
					<dd>{fmt(firstYearEnd(w.deliveryDate))}</dd>
				</div>
				<div>
					<dt>Fabrieksgarantie tot</dt>
					<dd>{w.factoryUntil ? fmt(w.factoryUntil) : 'Niet ingevuld'}</dd>
				</div>
				<div>
					<dt>Levensduur</dt>
					<dd>
						{w.lifetimeYears} jaar, tot ongeveer {lifetimeEnd(w).slice(0, 4)}
						<span class="muted">(schatting)</span>
					</dd>
				</div>
				{#if w.discardedAt}
					<div>
						<dt>Afgedankt</dt>
						<dd>{fmt(w.discardedAt.slice(0, 10))}</dd>
					</div>
				{/if}
			</dl>
		</section>
	{/if}

	<section class="card proof" aria-labelledby="proof-title">
		<h2 id="proof-title">Bewijs</h2>
		<div class="links">
			<a class="more-link" href="/transacties/{w.transactionId}">Transactie</a>
			{#if w.receiptId}
				<a class="more-link" href="/bonnen/{w.receiptId}">Bon bekijken</a>
			{/if}
		</div>
		{#if w.receiptId}
			<p class="muted small">
				{active
					? 'De bon en de transactie blijven bewaard zolang je het product hebt.'
					: 'De bon mag nu weg.'}
			</p>
		{:else}
			<p class="small">
				Maak een foto van de bon: kassabonnen vervagen. Het bankafschrift bewijst dat je betaalde,
				maar noemt het product niet.
			</p>
			<a class="more-link" href="/bonnen">Bon toevoegen</a>
		{/if}
	</section>

	{#if active}
		<section class="remove" aria-label="Product afdanken">
			{#if confirmDiscard}
				<p>
					{w.product} afdanken? Je krijgt er geen meldingen meer over, en de bon mag daarna weg.
				</p>
				<div class="save">
					<form method="POST" action="?/discard" use:enhance={keep}>
						<button class="button danger" disabled={busy}>Ja, afdanken</button>
					</form>
					<button type="button" class="button secondary" onclick={() => (confirmDiscard = false)}
						>Annuleren</button
					>
				</div>
			{:else}
				<button type="button" class="button danger" onclick={() => (confirmDiscard = true)}
					>Afdanken</button
				>
			{/if}
		</section>
	{/if}
</div>

<style>
	.page {
		max-width: 40rem;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 22px;
	}

	header {
		display: grid;
		gap: 6px;
	}

	h1 {
		overflow-wrap: anywhere;
	}

	.amount {
		font-size: clamp(2rem, 9vw, 2.75rem);
		font-weight: 650;
		letter-spacing: -0.03em;
		line-height: 1.1;
	}

	.card {
		display: grid;
		gap: 12px;
	}

	.small {
		font-size: 0.92rem;
	}

	.form {
		gap: 16px;
		padding: 20px;
		container-type: inline-size;
	}

	.field {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}

	.field > span:first-child,
	legend {
		font-weight: 550;
		font-size: 0.95rem;
	}

	legend {
		padding: 0;
		margin-bottom: 6px;
	}

	.field input {
		width: 100%;
	}

	.hint {
		font-size: 0.88rem;
	}

	/* Keuzeschakelaar: drie soorten onder elkaar, op een breder formulier naast elkaar */
	.segmented {
		display: grid;
		grid-template-columns: 1fr;
		padding: 3px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	@container (min-width: 30rem) {
		.segmented {
			grid-template-columns: repeat(3, 1fr);
		}
	}

	.segmented label {
		position: relative;
		display: grid;
	}

	.segmented input {
		position: absolute;
		opacity: 0;
		inset: 0;
		min-height: 0;
		margin: 0;
		cursor: pointer;
	}

	.segmented span {
		display: grid;
		place-items: center;
		min-height: var(--tap);
		padding: 0 8px;
		border-radius: 8px;
		font-size: 0.92rem;
		font-weight: 550;
		text-align: center;
		color: var(--muted);
		pointer-events: none;
	}

	.segmented input:checked + span {
		background: var(--surface);
		color: var(--text);
		box-shadow: 0 1px 3px oklch(0.2 0.01 85 / 0.14);
	}

	.segmented input:focus-visible + span {
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px 12px;
	}

	.button.small {
		min-height: var(--tap);
		padding: 0 14px;
		font-size: 0.92rem;
	}

	dl {
		margin: 0;
		display: grid;
	}

	dl > div {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 16px;
		padding: 10px 0;
	}

	dl > div + div {
		border-top: 1px solid var(--line);
	}

	dt {
		color: var(--muted);
	}

	dd {
		margin: 0;
		text-align: right;
		font-weight: 550;
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.proof > .more-link {
		justify-self: start;
	}

	.save {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.remove {
		display: grid;
		gap: 8px;
		justify-items: start;
	}
</style>
