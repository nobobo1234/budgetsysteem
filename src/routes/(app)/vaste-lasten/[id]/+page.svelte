<script lang="ts">
	import { enhance } from '$app/forms';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatDayMonth, formatShortDate } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';
	import { INTERVAL_LABEL, PER_INTERVAL, rhythmText, type Interval } from '#lib/recurring.ts';

	let { data, form } = $props();
	const item = $derived(data.item);
	const running = $derived(item.status === 'actief');
	const monthStart = $derived(`${data.today.slice(0, 7)}-01`);

	// svelte-ignore state_referenced_locally
	let interval = $state<string>(data.item.interval);
	let saving = $state(false);
	let confirmStop = $state(false);

	const intervalOptions: SelectOption[] = (['maand', 'kwartaal', 'halfjaar', 'jaar'] as const).map(
		(i) => ({ value: i, label: INTERVAL_LABEL[i] })
	);
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
	<title>{item.counterparty} · Vaste lasten · Budget</title>
</svelte:head>

<div class="page">
	<a class="back" href="/vaste-lasten">
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
		Vaste lasten
	</a>

	<header>
		<h1>{item.counterparty}</h1>
		<p class="amount num">
			{formatCents(item.medianCents)}
			<span class="per">{PER_INTERVAL[item.interval]}</span>
		</p>
		<p class="muted">
			{rhythmText(item.interval, item.expectedDay)}{#if item.kind === 'wisselend'}
				· wisselend, tot nu toe <span class="num">{formatCents(item.minCents)}</span> tot
				<span class="num">{formatCents(item.maxCents)}</span>{/if}
		</p>
		{#if running && item.spread && item.nextDate}
			<p class="reserve">
				<span class="num">{formatCents(item.reservedCents)}</span> van
				<span class="num">{formatCents(item.medianCents)}</span> opzij, afschrijving rond
				{formatDayMonth(item.nextDate)}
			</p>
		{:else if running && item.nextDate}
			<p class="muted">Volgende afschrijving rond {formatDayMonth(item.nextDate)}</p>
		{/if}
		{#if !running && item.stoppedAt}
			<p class="notice">
				Gestopt op {formatShortDate(item.stoppedAt)}
				{item.stoppedAt.slice(0, 4)}. Er komen geen verwachte posten meer.
			</p>
		{/if}
	</header>

	{#if running}
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
			<label class="field">
				<span>Naam</span>
				<input name="counterparty" value={item.counterparty} maxlength="100" required />
			</label>
			<div class="row">
				<label class="field">
					<span>Verwacht bedrag</span>
					<span class="money">
						<span class="prefix" aria-hidden="true">€</span>
						<input
							name="amount"
							inputmode="decimal"
							class="num"
							value={centsToInput(item.medianCents)}
							autocomplete="off"
							required
						/>
					</span>
				</label>
				<fieldset class="field">
					<legend>Soort</legend>
					<div class="segmented">
						<label>
							<input type="radio" name="kind" value="vast" checked={item.kind === 'vast'} />
							<span>Vast</span>
						</label>
						<label>
							<input
								type="radio"
								name="kind"
								value="wisselend"
								checked={item.kind === 'wisselend'}
							/>
							<span>Wisselend</span>
						</label>
					</div>
				</fieldset>
			</div>
			<div class="row">
				<div class="field">
					<label for="rec-interval">Ritme</label>
					<Select
						id="rec-interval"
						name="interval"
						label="Ritme"
						bind:value={interval}
						options={intervalOptions}
					/>
				</div>
				<label class="field">
					<span>Volgende afschrijving</span>
					<input type="date" name="nextDate" value={item.nextDate} min={monthStart} required />
				</label>
			</div>
			<div class="field">
				<label for="rec-category">Categorie</label>
				<Select
					id="rec-category"
					name="categoryId"
					label="Categorie"
					value={item.categoryId ?? ''}
					options={categoryOptions}
				/>
			</div>
			{#if (interval as Interval) !== 'maand'}
				<Switch
					name="spread"
					checked={item.spread}
					hint="Uit: de afschrijfmaand krijgt het hele bedrag in één keer">Uitsmeren</Switch
				>
			{/if}
			<div class="save">
				<button class="button" disabled={saving}>{saving ? 'Opslaan…' : 'Opslaan'}</button>
				{#if form?.message}<p class="error-text" role="alert">{form.message}</p>{/if}
				{#if form?.saved && !saving}<p class="saved" role="status">Opgeslagen</p>{/if}
			</div>
		</form>
	{/if}

	<section class="card">
		<h2>Afschrijvingen</h2>
		{#if item.history.length === 0}
			<p class="muted">
				Nog geen posten in de app. Op de verwachte dag staat hij op je overzicht om te bevestigen.
			</p>
		{:else}
			<ul>
				{#each item.history as t (t.id)}
					<li>
						<a href="/transacties/{t.id}">{formatShortDate(t.date)} {t.date.slice(0, 4)}</a>
						{#if t.status === 'verwacht'}<span class="badge">Verwacht</span>{/if}
						<span class="num">{formatCents(t.amountCents)}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if running}
		<form method="POST" action="?/stop" use:enhance class="stop">
			{#if confirmStop}
				<p>
					{item.counterparty} stoppen? Open verwachte posten vervallen{#if item.spread && item.reservedCents > 0},
						en de <span class="num">{formatCents(item.reservedCents)}</span> die opzij staat valt deze
						maand vrij{/if}.
				</p>
				<div class="confirm">
					<button class="button danger">Ja, stoppen</button>
					<button type="button" class="button secondary" onclick={() => (confirmStop = false)}
						>Annuleren</button
					>
				</div>
			{:else}
				<button type="button" class="button danger" onclick={() => (confirmStop = true)}
					>Stoppen</button
				>
			{/if}
		</form>
	{/if}
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

	h1 {
		overflow-wrap: anywhere;
	}

	.amount {
		font-size: clamp(2rem, 9vw, 2.75rem);
		font-weight: 650;
		letter-spacing: -0.03em;
		line-height: 1.1;
	}

	.per {
		font-size: 1rem;
		font-weight: 500;
		letter-spacing: 0;
		color: var(--muted);
	}

	.reserve {
		justify-self: start;
		padding: 6px 12px;
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		font-size: 0.95rem;
	}

	.notice {
		justify-self: start;
		padding: 6px 12px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
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

	.field input {
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

	section {
		display: grid;
		gap: 12px;
	}

	ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
	}

	li {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: var(--tap);
	}

	li + li {
		border-top: 1px solid var(--line);
	}

	li .num {
		margin-left: auto;
		font-weight: 600;
	}

	.badge {
		padding: 1px 8px;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--muted);
		font-size: 0.8rem;
		font-weight: 600;
	}

	.stop {
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
