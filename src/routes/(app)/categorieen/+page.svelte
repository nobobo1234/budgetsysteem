<script lang="ts">
	import { enhance } from '$app/forms';

	let { data, form } = $props();
	const groups = $derived(Map.groupBy(data.categories, (c) => c.group));
	const fieldText = {
		tegenpartij: 'Tegenpartij bevat',
		iban: 'IBAN is',
		omschrijving: 'Omschrijving bevat'
	};
</script>

<svelte:head>
	<title>Categorieën · Budget</title>
</svelte:head>

<div class="page">
	<h1>Categorieën en regels</h1>
	{#if form && 'message' in form && form.message}<p class="error-text" role="alert">
			{form.message}
		</p>{/if}
	{#if form && 'applied' in form}<p role="status">
			Regel opgeslagen; {form.applied} transacties bijgewerkt.
		</p>{/if}

	<section>
		<h2>Regels</h2>
		<p class="muted">
			De regel met de laagste prioriteit wint. Nieuwe regels gelden ook voor transacties die nog
			geen categorie hebben.
		</p>
		<ul class="rules">
			{#each data.rules as r (r.id)}
				<li>
					<span>{fieldText[r.field]} <strong>{r.pattern}</strong> → {r.categoryName}</span>
					<span class="muted num">{r.priority}</span>
					<form method="POST" action="?/deleteRule" use:enhance>
						<input type="hidden" name="id" value={r.id} />
						<button class="button danger small" aria-label="Regel {r.pattern} verwijderen"
							>Verwijderen</button
						>
					</form>
				</li>
			{:else}
				<li class="muted">Nog geen regels. Maak ze snel vanuit de import.</li>
			{/each}
		</ul>
		<form method="POST" action="?/addRule" use:enhance class="card grid">
			<label>
				<span>Veld</span>
				<select name="field">
					<option value="tegenpartij">Tegenpartij bevat</option>
					<option value="omschrijving">Omschrijving bevat</option>
					<option value="iban">IBAN is</option>
				</select>
			</label>
			<label><span>Patroon</span><input name="pattern" required maxlength="100" /></label>
			<label>
				<span>Categorie</span>
				<select name="categoryId" required>
					{#each data.categories.filter((c) => !c.archived) as c (c.id)}
						<option value={c.id}>{c.name}</option>
					{/each}
				</select>
			</label>
			<label
				><span>Prioriteit</span><input
					name="priority"
					type="number"
					min="0"
					max="1000"
					value="100"
				/></label
			>
			<button class="button">Regel toevoegen</button>
		</form>
	</section>

	<section>
		<h2>Categorieën</h2>
		{#each groups as [group, cats] (group)}
			<h3>{group}</h3>
			<ul class="cats">
				{#each cats as c (c.id)}
					<li class:archived={c.archived}>
						<form method="POST" action="?/updateCategory" use:enhance class="row">
							<input type="hidden" name="id" value={c.id} />
							<label
								><span class="visually-hidden">Naam</span><input
									name="name"
									value={c.name}
									maxlength="60"
									required
								/></label
							>
							<label
								><span class="visually-hidden">Groep</span><input
									name="group"
									value={c.group}
									maxlength="40"
									required
								/></label
							>
							<label class="check"
								><input type="checkbox" name="countsForBudget" checked={c.countsForBudget} /> Telt mee</label
							>
							<button class="button secondary">Opslaan</button>
						</form>
						<form method="POST" action="?/archiveCategory" use:enhance>
							<input type="hidden" name="id" value={c.id} />
							<button class="button danger">{c.archived ? 'Terugzetten' : 'Archiveren'}</button>
						</form>
					</li>
				{/each}
			</ul>
		{/each}

		<form method="POST" action="?/addCategory" use:enhance class="card grid">
			<label><span>Nieuwe categorie</span><input name="name" required maxlength="60" /></label>
			<label><span>Groep</span><input name="group" required maxlength="40" value="Overig" /></label>
			<label class="check"
				><input type="checkbox" name="countsForBudget" checked /> Telt mee voor budget</label
			>
			<button class="button">Toevoegen</button>
		</form>
	</section>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 28px;
		max-width: 52rem;
	}

	section {
		display: grid;
		gap: 12px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
	}

	.rules li {
		display: grid;
		grid-template-columns: 1fr auto auto;
		align-items: center;
		gap: 12px;
	}

	.cats li {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
	}

	.archived {
		opacity: 0.55;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		flex: 1;
	}

	.grid {
		display: grid;
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

	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: var(--tap);
	}

	.check input {
		min-height: auto;
		width: 20px;
		height: 20px;
	}
</style>
