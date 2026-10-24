<script lang="ts">
	import { enhance } from '$app/forms';
	import { formatShortDate } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';

	let { data, form } = $props();
	let uploading = $state(false);
	const summary = $derived(form && 'summary' in form ? form.summary : null);
</script>

<svelte:head>
	<title>Import · Budget</title>
</svelte:head>

<div class="page">
	<h1>Importeren</h1>
	<p class="muted">
		Download in Mijn SNS je transacties als CAMT.053 (of CSV) en kies het bestand hier. Dezelfde
		export twee keer importeren levert niets dubbel op.
	</p>

	<form
		method="POST"
		action="?/upload"
		enctype="multipart/form-data"
		class="card upload"
		use:enhance={() => {
			uploading = true;
			return async ({ update }) => {
				await update();
				uploading = false;
			};
		}}
	>
		<label>
			<span>Bankbestand</span>
			<input
				type="file"
				name="file"
				accept=".xml,.csv,application/xml,text/xml,text/csv"
				required
			/>
		</label>
		<button class="button" disabled={uploading}
			>{uploading ? 'Bezig met importeren…' : 'Importeren'}</button
		>
		{#if form && 'message' in form && form.message}<p class="error-text" role="alert">
				{form.message}
			</p>{/if}
	</form>

	{#if summary}
		<section class="card result" role="status">
			<h2>Import klaar</h2>
			<dl>
				<div>
					<dt>Nieuw</dt>
					<dd class="num">{summary.newCount}</dd>
				</div>
				<div>
					<dt>Al bekend</dt>
					<dd class="num">{summary.duplicateCount}</dd>
				</div>
				{#if summary.periodStart && summary.periodEnd}
					<div>
						<dt>Periode</dt>
						<dd>
							{formatShortDate(summary.periodStart)}
							{summary.periodStart.slice(0, 4)} tot {formatShortDate(summary.periodEnd)}
							{summary.periodEnd.slice(0, 4)}
						</dd>
					</div>
				{/if}
			</dl>
		</section>
	{/if}

	{#if form && 'applied' in form}
		<p role="status">Regel voor "{form.pattern}" gemaakt; {form.applied} transacties bijgewerkt.</p>
	{/if}

	{#if data.uncategorized.length > 0}
		<section class="groups">
			<h2>Nog zonder categorie</h2>
			<p class="muted">
				Eén klik maakt een regel, voor deze en alle volgende transacties van die tegenpartij.
			</p>
			<ul>
				{#each data.uncategorized as g (g.pattern)}
					<li>
						<div class="who">
							<strong>{g.example}</strong>
							<span class="muted num"
								>{g.count}× · {formatCents(g.totalCents, { whole: true })}</span
							>
						</div>
						<form method="POST" action="?/rule" use:enhance>
							<input type="hidden" name="pattern" value={g.pattern} />
							<label>
								<span class="visually-hidden">Categorie voor {g.example}</span>
								<select name="categoryId" value={g.suggestedCategoryId ?? ''} required>
									<option value="" disabled>Kies categorie</option>
									{#each data.categories as c (c.id)}
										<option value={c.id}>{c.name}</option>
									{/each}
								</select>
							</label>
							<button class="button secondary">Regel maken</button>
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{:else if data.batches.length > 0}
		<p>Alle geïmporteerde transacties hebben een categorie.</p>
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 44rem;
	}

	.upload {
		display: grid;
		gap: 12px;
	}

	.upload label {
		display: grid;
		gap: 4px;
		font-weight: 550;
	}

	.upload input[type='file'] {
		padding: 10px;
	}

	dl {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: 12px;
		margin: 12px 0 0;
	}

	dt {
		color: var(--muted);
	}

	dd {
		margin: 0;
		font-weight: 600;
		font-size: 1.15rem;
	}

	.groups {
		display: grid;
		gap: 12px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 16px;
	}

	li {
		display: grid;
		gap: 8px;
	}

	.who {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		flex-wrap: wrap;
	}

	li form {
		display: flex;
		gap: 8px;
	}

	li form label {
		flex: 1;
	}

	li select {
		width: 100%;
	}
</style>
