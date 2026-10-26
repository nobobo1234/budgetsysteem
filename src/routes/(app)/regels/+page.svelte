<script lang="ts">
	import * as icons from '#lib/icons.ts';
	import { tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import ManageTabs from '#lib/components/ManageTabs.svelte';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { groupColor } from '#lib/categoryColor.ts';

	let { data, form } = $props();

	const categoryOptions = $derived<SelectOption[]>(
		data.categories.map((c) => ({
			value: c.id,
			label: c.name,
			group: c.group,
			dot: groupColor(c.group)
		}))
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

	let confirmRule = $state<string | null>(null);
	// Het formulier staat dicht, zodat de lijst bovenaan staat; na toevoegen blijft het open
	let adding = $state(false);
	let ruleFilter = $state('');
	let ruleField = $state('tegenpartij');

	const shownRules = $derived.by(() => {
		const q = ruleFilter.trim().toLowerCase();
		if (!q) return data.rules;
		return data.rules.filter(
			(r) => r.pattern.includes(q) || r.categoryName.toLowerCase().includes(q)
		);
	});

	// Niet het hele formulier resetten: de gekozen categorie mag blijven staan voor de volgende regel
	const keepValues: SubmitFunction = ({ formElement }) => {
		return async ({ result, update }) => {
			await update({ reset: false });
			confirmRule = null;
			const pattern = formElement.querySelector<HTMLInputElement>('input[name="pattern"]');
			if (result.type === 'success' && pattern) pattern.value = '';
		};
	};

	async function openForm() {
		adding = true;
		// Op een telefoon niet meteen het toetsenbord openen: dat bedekt de keuzelijsten
		if (!matchMedia('(pointer: fine)').matches) return;
		await tick();
		document.querySelector<HTMLInputElement>('input[name="pattern"]')?.focus();
	}

	const updated = (n: number) => `${n} ${n === 1 ? 'transactie' : 'transacties'} bijgewerkt`;

	const feedback = $derived(
		form && 'message' in form && form.message
			? { text: form.message, error: true }
			: form && 'reapplied' in form
				? { text: `Regels toegepast; ${updated(form.applied ?? 0)}.`, error: false }
				: form && 'ok' in form
					? { text: `Regel verwijderd; ${updated(form.applied ?? 0)}.`, error: false }
					: form && 'applied' in form
						? { text: `Regel opgeslagen; ${updated(form.applied ?? 0)}.`, error: false }
						: null
	);
</script>

<svelte:head>
	<title>Regels · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<BackLink parents={['/budget', '/instellingen']} />
		<h1 data-morph-head="titel">Regels</h1>
		<p class="muted">
			Regels geven transacties automatisch een categorie, ook bestaande. Een categorie die je zelf
			kiest, blijft staan.
		</p>
	</div>

	<ManageTabs current="regels" categories={data.categories.length} rules={data.rules.length} />

	{#if feedback}
		{#key form}<Toast text={feedback.text} error={feedback.error} />{/key}
	{/if}

	<section aria-label="Regels">
		{#if !adding}
			<button class="button secondary small new-rule" onclick={openForm}>Nieuwe regel</button>
		{:else}
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
						<span class="muted small"
							>Passen meerdere regels, dan wint de laagste prioriteit. Standaard 100.</span
						>
						<input name="priority" type="number" min="0" max="1000" value="100" class="num" />
					</label>
				</details>
				<div class="actions">
					<button class="button">Regel toevoegen</button>
					<button type="button" class="button secondary" onclick={() => (adding = false)}
						>Sluiten</button
					>
				</div>
			</form>
		{/if}

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
				<li class="empty">
					{#if data.rules.length === 0}
						<EmptyState
							icon={icons.regels}
							text="Nog geen regels. Maak er hierboven een, of snel vanuit de import."
							compact
						>
							<a class="more-link" href="/import">Naar de import</a>
						</EmptyState>
					{:else}
						<EmptyState
							icon={icons.zoeken}
							text="Geen regel past bij &quot;{ruleFilter}&quot;."
							compact
						/>
					{/if}
				</li>
			{/each}
		</ul>

		{#if data.rules.length > 0}
			<form method="POST" action="?/reapply" use:enhance class="reapply">
				<button class="button secondary small">Regels opnieuw toepassen</button>
				<span class="muted small">Op alle transacties, behalve categorieën die je zelf koos.</span>
			</form>
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

	.small {
		font-size: 0.85rem;
	}

	.button.small {
		min-height: 40px;
		padding: 0 14px;
		font-size: 0.92rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.dot {
		flex: none;
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: var(--dot);
	}

	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.field > span:first-child {
		font-weight: 550;
		font-size: 0.95rem;
	}

	.field input {
		width: 100%;
	}

	section {
		display: grid;
		gap: 14px;
	}

	.new-rule {
		justify-self: start;
	}

	.reapply {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
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
