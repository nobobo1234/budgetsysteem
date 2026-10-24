<script lang="ts">
	import { tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { groupColor } from '#lib/categoryColor.ts';

	let { data, form } = $props();

	type Category = (typeof data.categories)[number];
	const NEW_GROUP = '__nieuw__';

	const active = $derived(data.categories.filter((c) => !c.archived));
	const archived = $derived(data.categories.filter((c) => c.archived));
	const groups = $derived(Map.groupBy(active, (c) => c.group));
	const groupNames = $derived([...new Set(data.categories.map((c) => c.group))]);
	const groupOptions = $derived<SelectOption[]>([
		...groupNames.map((g) => ({ value: g, label: g, dot: groupColor(g) })),
		{ value: NEW_GROUP, label: 'Nieuwe groep…' }
	]);
	const categoryOptions = $derived<SelectOption[]>(
		active.map((c) => ({ value: c.id, label: c.name, group: c.group, dot: groupColor(c.group) }))
	);

	const fieldOptions: SelectOption[] = [
		{ value: 'tegenpartij', label: 'Tegenpartij bevat' },
		{ value: 'omschrijving', label: 'Omschrijving bevat' },
		{ value: 'iban', label: 'IBAN is' }
	];
	const fieldText = {
		tegenpartij: 'Tegenpartij bevat',
		iban: 'IBAN is',
		omschrijving: 'Omschrijving bevat'
	};

	// Eén categorie tegelijk bewerken; 'nieuw' is het formulier voor een nieuwe categorie
	let editing = $state<string | null>(null);
	let groupChoice = $state('');
	let newGroup = $state('');
	let confirmRule = $state<string | null>(null);
	let ruleFilter = $state('');
	let ruleField = $state('tegenpartij');

	const shownRules = $derived.by(() => {
		const q = ruleFilter.trim().toLowerCase();
		if (!q) return data.rules;
		return data.rules.filter(
			(r) => r.pattern.includes(q) || r.categoryName.toLowerCase().includes(q)
		);
	});

	async function edit(c: Category | null) {
		editing = c ? c.id : 'nieuw';
		groupChoice = c ? c.group : (groupNames.at(-1) ?? NEW_GROUP);
		newGroup = '';
		await tick();
		document.getElementById(`naam-${editing}`)?.focus();
	}

	async function chooseGroup(value: string) {
		groupChoice = value;
		if (value === NEW_GROUP) {
			await tick();
			document.getElementById(`groep-nieuw-${editing}`)?.focus();
		}
	}

	// Na opslaan het formulier sluiten; bij een fout open laten met de ingevulde waarden
	const closeOnSuccess: SubmitFunction = () => {
		return async ({ result, update }) => {
			await update({ reset: false });
			if (result.type === 'success') editing = null;
		};
	};

	// Niet het hele formulier resetten: de gekozen categorie mag blijven staan voor de volgende regel
	const keepValues: SubmitFunction = ({ formElement }) => {
		return async ({ result, update }) => {
			await update({ reset: false });
			confirmRule = null;
			const pattern = formElement.querySelector<HTMLInputElement>('input[name="pattern"]');
			if (result.type === 'success' && pattern) pattern.value = '';
		};
	};

	const feedback = $derived(
		form && 'message' in form && form.message
			? { text: form.message, error: true }
			: form && 'applied' in form
				? {
						text: `Regel opgeslagen; ${form.applied} ${form.applied === 1 ? 'transactie' : 'transacties'} bijgewerkt.`,
						error: false
					}
				: form && 'ok' in form
					? { text: 'Opgeslagen.', error: false }
					: null
	);
</script>

<svelte:head>
	<title>Categorieën · Budget</title>
</svelte:head>

{#snippet editor(c: Category | null)}
	{@const key = c ? c.id : 'nieuw'}
	<form
		method="POST"
		action={c ? '?/updateCategory' : '?/addCategory'}
		use:enhance={closeOnSuccess}
		class="editor"
	>
		{#if c}<input type="hidden" name="id" value={c.id} />{/if}
		<label class="field">
			<span>Naam</span>
			<input id="naam-{key}" name="name" value={c?.name ?? ''} maxlength="60" required />
		</label>
		<div class="field">
			<label for="groep-{key}">Groep</label>
			<Select
				id="groep-{key}"
				label="Groep"
				value={groupChoice}
				options={groupOptions}
				onchange={chooseGroup}
			/>
			{#if groupChoice === NEW_GROUP}
				<input
					id="groep-nieuw-{key}"
					name="group"
					bind:value={newGroup}
					maxlength="40"
					placeholder="Naam van de nieuwe groep"
					aria-label="Naam van de nieuwe groep"
					required
				/>
			{:else}
				<input type="hidden" name="group" value={groupChoice} />
			{/if}
		</div>
		<label class="switch">
			<input
				type="checkbox"
				role="switch"
				name="countsForBudget"
				checked={c ? c.countsForBudget : true}
			/>
			<span class="track" aria-hidden="true"></span>
			<span>
				Telt mee voor budget
				<span class="muted small">Uit voor inkomen, sparen en overboekingen</span>
			</span>
		</label>
		<div class="actions">
			<button class="button">{c ? 'Opslaan' : 'Toevoegen'}</button>
			<button type="button" class="button secondary" onclick={() => (editing = null)}
				>Annuleren</button
			>
		</div>
	</form>
	{#if c}
		<form method="POST" action="?/archiveCategory" use:enhance={closeOnSuccess} class="archive">
			<input type="hidden" name="id" value={c.id} />
			<button class="text-button danger-text">Archiveren</button>
			<span class="muted small">Bestaande transacties houden de categorie.</span>
		</form>
	{/if}
{/snippet}

<div class="page">
	<div class="intro">
		<h1>Categorieën en regels</h1>
		<p class="muted">
			Categorieën bepalen je budget. Regels geven nieuwe transacties automatisch de juiste
			categorie.
		</p>
	</div>

	<nav class="jump" aria-label="Op deze pagina">
		<a href="#categorieen">Categorieën <span class="num">{active.length}</span></a>
		<a href="#regels">Regels <span class="num">{data.rules.length}</span></a>
	</nav>

	{#if feedback}
		{#key form}<Toast text={feedback.text} error={feedback.error} />{/key}
	{/if}

	<section id="categorieen" aria-labelledby="cat-title">
		<div class="head">
			<h2 id="cat-title">Categorieën</h2>
			{#if editing !== 'nieuw'}
				<button class="button secondary small" onclick={() => edit(null)}>Nieuwe categorie</button>
			{/if}
		</div>

		{#if editing === 'nieuw'}
			<div class="card new">
				<h3>Nieuwe categorie</h3>
				{@render editor(null)}
			</div>
		{/if}

		{#each groups as [group, cats] (group)}
			<div class="card group">
				<h3><span class="dot" style:--dot={groupColor(group)} aria-hidden="true"></span>{group}</h3>
				<ul>
					{#each cats as c (c.id)}
						<li class={[editing === c.id && 'open']}>
							{#if editing === c.id}
								{@render editor(c)}
							{:else}
								<button class="row" onclick={() => edit(c)} aria-label="{c.name} wijzigen">
									<span class="name">{c.name}</span>
									{#if !c.countsForBudget}<span class="badge">Buiten budget</span>{/if}
									<svg class="pencil" viewBox="0 0 20 20" aria-hidden="true">
										<path
											d="M13.5 3.5l3 3L7 16H4v-3z"
											fill="none"
											stroke="currentColor"
											stroke-width="1.6"
											stroke-linejoin="round"
										/>
									</svg>
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/each}

		{#if archived.length > 0}
			<details class="archived">
				<summary>Gearchiveerd <span class="num muted">({archived.length})</span></summary>
				<ul>
					{#each archived as c (c.id)}
						<li>
							<span>{c.name} <span class="muted small">{c.group}</span></span>
							<form method="POST" action="?/archiveCategory" use:enhance>
								<input type="hidden" name="id" value={c.id} />
								<button class="button secondary small">Terugzetten</button>
							</form>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</section>

	<section id="regels" aria-labelledby="rules-title">
		<div class="intro">
			<h2 id="rules-title">Regels</h2>
			<p class="muted">
				Passen meerdere regels, dan wint die met de laagste prioriteit. Een nieuwe regel geldt ook
				voor transacties die nog geen categorie hebben.
			</p>
		</div>

		<form method="POST" action="?/addRule" use:enhance={keepValues} class="card rule-form">
			<h3>Nieuwe regel</h3>
			<div class="sentence">
				<span class="word">Als</span>
				<div class="field-select">
					<Select name="field" label="Veld" bind:value={ruleField} options={fieldOptions} />
				</div>
				<input
					name="pattern"
					required
					maxlength="100"
					aria-label="Patroon"
					placeholder={ruleField === 'iban' ? 'NL00BANK0123456789' : 'bijvoorbeeld albert heijn'}
					autocomplete="off"
				/>
				<span class="word">dan</span>
				<div class="cat-select">
					<Select
						name="categoryId"
						label="Categorie"
						placeholder="Kies categorie"
						options={categoryOptions}
						required
					/>
				</div>
			</div>
			<details class="more">
				<summary>Prioriteit</summary>
				<label class="field priority">
					<span class="muted small">Lager wint als meerdere regels passen. Standaard 100.</span>
					<input name="priority" type="number" min="0" max="1000" value="100" class="num" />
				</label>
			</details>
			<button class="button">Regel toevoegen</button>
		</form>

		{#if data.rules.length > 6}
			<input
				type="search"
				class="filter"
				bind:value={ruleFilter}
				aria-label="Regels filteren"
				placeholder="Filter op patroon of categorie"
				autocomplete="off"
			/>
		{/if}

		<ul class="rules">
			{#each shownRules as r (r.id)}
				<li>
					<div class="rule">
						<span class="when">
							<span class="muted">{fieldText[r.field]}</span>
							<strong>{r.pattern}</strong>
						</span>
						<span class="then">
							<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true">
								<path
									d="M3 8h9M8.5 4.5L12 8l-3.5 3.5"
									fill="none"
									stroke="currentColor"
									stroke-width="1.5"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
							<span class="dot" style:--dot={groupColor(r.categoryGroup)} aria-hidden="true"></span>
							{r.categoryName}
							{#if r.priority !== 100}
								<span class="muted small num">· prioriteit {r.priority}</span>
							{/if}
						</span>
					</div>
					<form method="POST" action="?/deleteRule" use:enhance={keepValues}>
						<input type="hidden" name="id" value={r.id} />
						{#if confirmRule === r.id}
							<button class="button danger small">Verwijderen</button>
						{:else}
							<button
								type="button"
								class="icon-button"
								aria-label="Regel {r.pattern} verwijderen"
								onclick={() => (confirmRule = r.id)}
							>
								<svg viewBox="0 0 20 20" aria-hidden="true">
									<path
										d="M4 6h12M8 6V4h4v2M6 6l.8 10h6.4L14 6"
										fill="none"
										stroke="currentColor"
										stroke-width="1.6"
										stroke-linejoin="round"
										stroke-linecap="round"
									/>
								</svg>
							</button>
						{/if}
					</form>
				</li>
			{:else}
				<li class="empty muted">
					{#if data.rules.length === 0}
						Nog geen regels. Maak er hierboven een, of snel vanuit de
						<a href="/import">import</a>.
					{:else}
						Geen regel past bij "{ruleFilter}".
					{/if}
				</li>
			{/each}
		</ul>
	</section>
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
		gap: 8px;
	}

	section {
		display: grid;
		gap: 14px;
		scroll-margin-top: 16px;
	}

	.jump {
		display: flex;
		gap: 8px;
		margin-top: -8px;
	}

	.jump a {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 0 14px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text);
		font-weight: 550;
		text-decoration: none;
	}

	.jump .num {
		color: var(--muted);
	}

	.head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}

	.small {
		font-size: 0.85rem;
	}

	.button.small {
		min-height: 40px;
		padding: 0 14px;
		font-size: 0.92rem;
	}

	@container (min-width: 900px) {
		section {
			scroll-margin-top: 72px;
		}
	}

	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.group {
		display: grid;
		gap: 4px;
		padding: 14px 8px 8px;
	}

	.group h3,
	.new h3 {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 8px 6px;
	}

	.new {
		display: grid;
		gap: 8px;
		padding: 16px 8px 8px;
	}

	.dot {
		flex: none;
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: var(--dot);
	}

	.group li + li {
		border-top: 1px solid var(--line);
	}

	.group li.open,
	.group li.open + li {
		border-color: transparent;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 52px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		text-align: start;
		cursor: pointer;
	}

	@media (hover: hover) {
		.row:hover {
			background: var(--surface-2);
		}

		.row:hover .pencil {
			opacity: 1;
		}
	}

	.name {
		flex: 1;
		min-width: 0;
	}

	.badge {
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--muted);
		font-size: 0.8rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.pencil {
		flex: none;
		width: 18px;
		height: 18px;
		color: var(--muted);
		opacity: 0.6;
		transition: opacity 120ms;
	}

	.editor {
		display: grid;
		gap: 14px;
		padding: 12px 8px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		animation: rise 200ms var(--ease-out);
	}

	.open .editor,
	.new .editor {
		background: color-mix(in oklch, var(--surface-2) 60%, transparent);
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

	.switch {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: var(--tap);
		cursor: pointer;
	}

	.switch > span:last-child {
		display: grid;
	}

	.switch input {
		position: absolute;
		opacity: 0;
		width: 44px;
		height: 26px;
		min-height: 0;
		margin: 0;
		cursor: pointer;
	}

	.track {
		position: relative;
		flex: none;
		width: 44px;
		height: 26px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--text) 22%, transparent);
	}

	.track::after {
		content: '';
		position: absolute;
		top: 3px;
		left: 3px;
		width: 20px;
		height: 20px;
		border-radius: 999px;
		background: #fff;
		box-shadow: 0 1px 3px oklch(0.2 0.01 85 / 0.25);
		transition: transform 220ms var(--ease-spring);
	}

	.switch input:checked + .track {
		background: var(--accent);
	}

	.switch input:checked + .track::after {
		transform: translateX(18px);
	}

	.switch input:focus-visible + .track {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.archive {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		padding: 4px 8px 10px;
	}

	.text-button {
		min-height: var(--tap);
		padding: 0;
		border: 0;
		background: none;
		font-weight: 600;
		cursor: pointer;
	}

	.danger-text {
		color: var(--danger);
	}

	.archived {
		padding: 4px 16px;
		border-radius: var(--radius);
		background: var(--surface);
	}

	.archived summary {
		min-height: var(--tap);
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 550;
		cursor: pointer;
	}

	.archived li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		padding: 8px 0;
		border-top: 1px solid var(--line);
	}

	.rule-form {
		display: grid;
		gap: 14px;
		padding: 18px;
	}

	.sentence {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		align-items: center;
		gap: 8px 10px;
	}

	.sentence input {
		grid-column: 2;
		width: 100%;
	}

	.word {
		color: var(--muted);
		font-weight: 550;
	}

	/* Breed: "Als [veld] [patroon]" op één regel, "dan [categorie]" eronder */
	@container (min-width: 700px) {
		.sentence {
			grid-template-columns: auto minmax(0, 13rem) minmax(0, 1fr);
		}

		.sentence input {
			grid-column: auto;
		}

		.cat-select {
			grid-column: 2 / -1;
		}
	}

	.more summary {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		color: var(--accent-strong);
		font-weight: 550;
		cursor: pointer;
	}

	.priority input {
		width: 8rem;
	}

	.filter {
		width: 100%;
		border-radius: 999px;
		padding: 0 16px;
	}

	.rules li {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 60px;
		padding: 8px 0;
		border-top: 1px solid var(--line);
	}

	.rules li:last-child {
		border-bottom: 1px solid var(--line);
	}

	.rule {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
	}

	.when {
		display: flex;
		flex-wrap: wrap;
		gap: 0 6px;
		overflow-wrap: anywhere;
	}

	.when strong {
		font-weight: 600;
	}

	.then {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 6px;
	}

	.arrow {
		width: 16px;
		height: 16px;
		color: var(--muted);
	}

	.icon-button {
		display: grid;
		place-items: center;
		width: var(--tap);
		height: var(--tap);
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.icon-button:hover {
		color: var(--danger);
		background: color-mix(in oklch, var(--danger) 10%, transparent);
	}

	.icon-button svg {
		width: 20px;
		height: 20px;
	}

	.rules .empty {
		display: block;
	}
</style>
