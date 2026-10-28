<script lang="ts">
	import { tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import BackLink from '#lib/components/BackLink.svelte';
	import ManageTabs from '#lib/components/ManageTabs.svelte';
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

	// Eén categorie tegelijk bewerken; 'nieuw' is het formulier voor een nieuwe categorie
	let editing = $state<string | null>(null);
	let groupChoice = $state('');
	let newGroup = $state('');

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

	const feedback = $derived(
		form && 'message' in form && form.message
			? { text: form.message, error: true }
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
		<label class="switch">
			<input
				type="checkbox"
				role="switch"
				name="tracksWarranty"
				checked={c ? c.tracksWarranty : false}
			/>
			<span class="track" aria-hidden="true"></span>
			<span>
				Garantie bijhouden
				<span class="muted small">Een uitgave vanaf € 50 wordt een voorstel bij Te controleren</span
				>
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
		<BackLink parents={['/budget', '/instellingen']} />
		<h1 data-morph-head="titel">Categorieën</h1>
		<p class="muted">
			Categorieën bepalen je budget. Elke categorie hoort bij een groep; buiten budget telt niet mee
			als uitgave.
		</p>
	</div>

	<ManageTabs current="categorieen" categories={active.length} rules={data.ruleCount} />

	{#if feedback}
		{#key form}<Toast text={feedback.text} error={feedback.error} />{/key}
	{/if}

	<section aria-label="Categorieën per groep">
		<div class="head">
			<h2 class="visually-hidden">Per groep</h2>
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
									{#if c.tracksWarranty}<span class="badge">Garantie</span>{/if}
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
</style>
