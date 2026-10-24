<script lang="ts">
	import { enhance } from '$app/forms';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatShortDate } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';

	let { data, form } = $props();
	const tx = $derived(data.tx);
	const sourceText = {
		import: 'Bankimport',
		handmatig: 'Handmatig',
		bon: 'Bon',
		verwacht: 'Verwacht'
	};

	let saving = $state(false);
	let confirmDelete = $state(false);

	const categoryOptions = $derived<SelectOption[]>([
		{ value: '', label: 'Geen categorie', dot: null },
		...data.categories.map((c) => ({
			value: c.id,
			label: c.name,
			group: c.group,
			dot: groupColor(c.group)
		}))
	]);
</script>

<svelte:head>
	<title>{tx.counterparty || 'Transactie'} · Budget</title>
</svelte:head>

<div class="page">
	<a class="back" href="/transacties">
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
		Transacties
	</a>

	<header>
		<h1>{tx.counterparty || 'Zonder naam'}</h1>
		<p class={['amount', 'num', tx.amountCents > 0 && 'in']}>
			{#if tx.amountCents === 0 && tx.origCurrency && tx.origAmountCents !== null}
				{tx.origCurrency}
				{centsToInput(tx.origAmountCents)}
			{:else}
				{formatCents(tx.amountCents, { sign: true })}
			{/if}
		</p>
		<p class="muted">
			{sourceText[tx.source]} · {formatShortDate(tx.date)}
			{tx.date.slice(0, 4)}
			{#if tx.description}· {tx.description}{/if}
		</p>
		{#if tx.status === 'te_controleren'}
			<p class="review">
				Te controleren{tx.amountCents === 0 ? ': vul het eurobedrag in dat is afgeschreven.' : '.'}
			</p>
		{/if}
	</header>

	<form
		method="POST"
		action="?/save"
		class="card form"
		use:enhance={() => {
			saving = true;
			return async ({ update }) => {
				await update({ reset: false });
				saving = false;
			};
		}}
	>
		<div class="row">
			<label class="field">
				<span>Bedrag</span>
				<span class="money">
					<span class="prefix" aria-hidden="true">€</span>
					<input
						name="amount"
						inputmode="decimal"
						value={tx.amountCents === 0 ? '' : centsToInput(tx.amountCents)}
						placeholder={tx.origCurrency ? 'Eurobedrag' : '0,00'}
						class="num"
						autocomplete="off"
						required={tx.origCurrency === null}
					/>
				</span>
			</label>
			<fieldset class="field">
				<legend>Richting</legend>
				<div class="segmented">
					<label>
						<input type="radio" name="direction" value="uit" checked={tx.amountCents <= 0} />
						<span>Uitgave</span>
					</label>
					<label>
						<input type="radio" name="direction" value="in" checked={tx.amountCents > 0} />
						<span>Inkomend</span>
					</label>
				</div>
			</fieldset>
		</div>
		{#if tx.origCurrency && tx.origAmountCents !== null}
			<p class="muted hint">
				Oorspronkelijk {tx.origCurrency}
				<span class="num">{centsToInput(tx.origAmountCents)}</span>
			</p>
		{/if}
		<div class="row">
			<label class="field">
				<span>Datum</span>
				<input type="date" name="date" value={tx.date} required />
			</label>
			<!-- Geen omhullend label: klikken in de lijst zou de knop opnieuw activeren -->
			<div class="field">
				<label for="tx-category">Categorie</label>
				<Select
					id="tx-category"
					name="categoryId"
					label="Categorie"
					value={tx.categoryId ?? ''}
					options={categoryOptions}
				/>
			</div>
		</div>
		<label class="field">
			<span>Tegenpartij</span>
			<input name="counterparty" value={tx.counterparty} maxlength="100" autocomplete="off" />
		</label>
		<label class="field">
			<span>Notitie</span>
			<textarea name="note" maxlength="500" rows="2" placeholder="Optioneel">{tx.note}</textarea>
		</label>
		<div class="save">
			<button class="button" disabled={saving}>{saving ? 'Opslaan…' : 'Opslaan'}</button>
			{#if form?.message}<p class="error-text" role="alert">{form.message}</p>{/if}
			{#if form?.saved && !saving}<p class="saved" role="status">Opgeslagen</p>{/if}
		</div>
	</form>

	{#if data.splits.length > 0}
		<section class="card">
			<h2>Verdeling</h2>
			<ul>
				{#each data.splits as s (s.id)}
					<li><span>{s.note}</span><span class="num">{formatCents(s.amountCents)}</span></li>
				{/each}
			</ul>
			{#each data.owed as o (o.id)}
				<p class="muted">
					Te krijgen van {o.person}: <span class="num">{formatCents(o.amountCents)}</span>
				</p>
			{/each}
		</section>
	{/if}

	<form method="POST" action="?/delete" use:enhance class="delete">
		{#if confirmDelete}
			<p>Deze transactie verwijderen? Je kunt dit niet ongedaan maken.</p>
			<div class="confirm">
				<button class="button danger">Ja, verwijderen</button>
				<button type="button" class="button secondary" onclick={() => (confirmDelete = false)}
					>Annuleren</button
				>
			</div>
		{:else}
			<button type="button" class="button danger" onclick={() => (confirmDelete = true)}
				>Verwijderen</button
			>
		{/if}
	</form>
</div>

<style>
	.page {
		max-width: 36rem;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		justify-self: start;
		min-height: var(--tap);
		margin-left: -6px;
		text-decoration: none;
		font-weight: 550;
	}

	.back svg {
		width: 20px;
		height: 20px;
	}

	header {
		display: grid;
		gap: 6px;
	}

	.amount {
		font-size: clamp(2rem, 9vw, 2.75rem);
		font-weight: 650;
		letter-spacing: -0.03em;
		line-height: 1.1;
	}

	.amount.in {
		color: var(--accent-strong);
	}

	.review {
		justify-self: start;
		padding: 6px 12px;
		border-radius: var(--radius-sm);
		background: color-mix(in oklch, var(--warn) 22%, transparent);
		font-weight: 550;
		font-size: 0.95rem;
	}

	.form {
		display: grid;
		gap: 16px;
		padding: 20px;
	}

	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
	}

	@container (min-width: 520px) {
		.row {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 12px;
		}
	}

	.field {
		display: grid;
		gap: 6px;
		align-content: start;
		min-width: 0;
	}

	.field > span,
	.field > label,
	legend {
		font-weight: 550;
		font-size: 0.95rem;
	}

	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
	}

	legend {
		padding: 0;
		margin-bottom: 6px;
	}

	.field input,
	.field textarea {
		width: 100%;
	}

	.money {
		position: relative;
		display: block;
	}

	.prefix {
		position: absolute;
		left: 12px;
		top: 50%;
		translate: 0 -50%;
		color: var(--muted);
		pointer-events: none;
	}

	.money input {
		padding-left: 28px;
		font-weight: 600;
	}

	.segmented {
		display: grid;
		grid-template-columns: 1fr 1fr;
		padding: 3px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
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
		min-height: 38px;
		border-radius: 8px;
		font-size: 0.92rem;
		font-weight: 550;
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

	.hint {
		margin-top: -8px;
		font-size: 0.9rem;
	}

	.save {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
	}

	.saved {
		color: var(--accent-strong);
		font-weight: 550;
		animation: fade-in 200ms var(--ease-out);
	}

	@keyframes fade-in {
		from {
			opacity: 0;
		}
	}

	ul {
		list-style: none;
		padding: 0;
		margin: 12px 0 0;
		display: grid;
		gap: 6px;
	}

	li {
		display: flex;
		justify-content: space-between;
	}

	.delete {
		display: grid;
		gap: 10px;
		justify-items: start;
		padding-top: 8px;
		border-top: 1px solid var(--line);
	}

	.confirm {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
