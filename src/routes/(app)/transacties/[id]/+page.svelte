<script lang="ts">
	import { enhance } from '$app/forms';
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
</script>

<svelte:head>
	<title>{tx.counterparty || 'Transactie'} · Budget</title>
</svelte:head>

<div class="page">
	<a href="/transacties">Terug naar transacties</a>
	<h1>{tx.counterparty || 'Zonder naam'}</h1>
	<p class="muted">
		{sourceText[tx.source]} · {formatShortDate(tx.date)}
		{#if tx.description}· {tx.description}{/if}
	</p>

	<form method="POST" action="?/save" use:enhance class="card form">
		<div class="row">
			<label>
				<span>Bedrag</span>
				<input
					name="amount"
					inputmode="decimal"
					value={tx.amountCents === 0 ? '' : centsToInput(tx.amountCents)}
					placeholder={tx.origCurrency ? 'Eurobedrag invullen' : ''}
					class="num"
					required={tx.origCurrency === null}
				/>
			</label>
			<label>
				<span>Richting</span>
				<select name="direction" value={tx.amountCents > 0 ? 'in' : 'uit'}>
					<option value="uit">Uitgave</option>
					<option value="in">Inkomend</option>
				</select>
			</label>
		</div>
		{#if tx.origCurrency && tx.origAmountCents !== null}
			<p class="muted">Oorspronkelijk {tx.origCurrency} {centsToInput(tx.origAmountCents)}</p>
		{/if}
		<label>
			<span>Datum</span>
			<input type="date" name="date" value={tx.date} required />
		</label>
		<label>
			<span>Tegenpartij</span>
			<input name="counterparty" value={tx.counterparty} maxlength="100" />
		</label>
		<label>
			<span>Categorie</span>
			<select name="categoryId" value={tx.categoryId ?? ''}>
				<option value="">Geen categorie</option>
				{#each data.categories as c (c.id)}
					<option value={c.id}>{c.name}</option>
				{/each}
			</select>
		</label>
		<label>
			<span>Notitie</span>
			<textarea name="note" maxlength="500" rows="2">{tx.note}</textarea>
		</label>
		<button class="button">Opslaan</button>
		{#if form?.message}<p class="error-text" role="alert">{form.message}</p>{/if}
		{#if form?.saved}<p role="status">Opgeslagen.</p>{/if}
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

	<form
		method="POST"
		action="?/delete"
		use:enhance={({ cancel }) => {
			if (!confirm('Deze transactie verwijderen?')) cancel();
		}}
	>
		<button class="button danger">Verwijderen</button>
	</form>
</div>

<style>
	.page {
		max-width: 36rem;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 16px;
	}

	.form {
		display: grid;
		gap: 14px;
	}

	.row {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}

	label {
		display: grid;
		gap: 4px;
	}

	label span {
		font-weight: 550;
		font-size: 0.95rem;
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
</style>
