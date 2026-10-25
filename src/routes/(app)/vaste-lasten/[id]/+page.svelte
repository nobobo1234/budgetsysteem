<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import BackLink from '#lib/components/BackLink.svelte';
	import Bars from '#lib/components/Bars.svelte';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatDayMonth, formatMonth, formatShortDate, shiftMonth } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';
	import {
		INTERVAL_LABEL,
		PER_INTERVAL,
		priceSteps,
		rhythmText,
		type Interval
	} from '#lib/recurring.ts';
	import { proposedShareCents } from '#lib/shares.ts';
	import { displayName } from '#lib/text.ts';

	let { data, form } = $props();
	const item = $derived(data.item);
	const running = $derived(item.status === 'actief');
	// Bij een gedeelde last gaat alleen jouw deel opzij
	const reserveFor = $derived(item.mineCents ?? item.medianCents);
	const monthStart = $derived(`${data.today.slice(0, 7)}-01`);

	// svelte-ignore state_referenced_locally
	let interval = $state<string>(data.item.interval);
	let saving = $state(false);
	// Eerst lezen, dan bewerken (spec: Vaste last): het formulier opent via "Bewerken"
	let editing = $state(false);
	let confirmStop = $state(false);
	let addingShare = $state(false);
	let shareKind = $state<'vast' | 'percentage'>('vast');
	let sharePerson = $state('');
	let confirmDelete = $state<string | null>(null);

	const name = $derived(displayName(item.counterparty));
	const color = $derived(item.categoryGroup ? groupColor(item.categoryGroup) : null);

	// De laatste afschrijvingen als staafjes, oudste links; een prijsverhoging valt op
	const monthShort = new Intl.DateTimeFormat('nl-NL', { month: 'short' });
	const chargeBars = $derived.by(() => {
		const list = [...item.history].reverse();
		const steps = priceSteps(list.map((t) => t.amountCents));
		return list.map((t, i) => ({
			key: t.id,
			cents: t.amountCents,
			label: monthShort.format(new Date(`${t.date}T12:00:00`)).replace('.', ''),
			title: `${formatShortDate(t.date)} ${t.date.slice(0, 4)}: ${formatCents(t.amountCents)}${
				t.status === 'verwacht' ? ', verwacht' : ''
			}${steps[i] ? `, ${formatCents(steps[i])} duurder` : ''}`,
			tone: steps[i] ? ('up' as const) : t.status === 'verwacht' ? ('quiet' as const) : undefined,
			note: steps[i] ? `+${formatCents(steps[i], { whole: steps[i] >= 1000 })}` : undefined
		}));
	});
	const raised = $derived(chargeBars.filter((b) => b.tone === 'up').length);

	const thisMonth = $derived(data.today.slice(0, 7));
	const months = $derived(
		Array.from({ length: 37 }, (_, i) => shiftMonth(thisMonth, i - 24))
			.reverse()
			.map((m) => ({ value: m, label: formatMonth(m) }))
	);
	const endOptions = $derived<SelectOption[]>([{ value: '', label: 'Loopt door' }, ...months]);
	const peopleOptions = $derived<SelectOption[]>([
		{ value: '', label: 'Nieuwe persoon' },
		...data.people.map((p) => ({ value: p.id, label: p.name }))
	]);
	const shares = $derived(data.shares.items);
	// Prijsverhoging: vaste aandelen naar verhouding mee, vanaf de volgende maand
	const raise = $derived(
		item.signal === 'prijsverhoging' && item.signalFromCents && item.signalToCents
			? shares
					.filter((s) => s.active && s.kind === 'vast' && s.amountCents)
					.map((s) => ({
						...s,
						proposed: proposedShareCents(s.amountCents!, item.signalFromCents!, item.signalToCents!)
					}))
			: []
	);
	const shareTerms = (s: {
		kind: string;
		amountCents: number | null;
		basisPoints: number | null;
	}) => (s.kind === 'vast' ? formatCents(s.amountCents ?? 0) : `${(s.basisPoints ?? 0) / 100}%`);
	const keepShare: SubmitFunction = () => {
		saving = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			saving = false;
			confirmDelete = null;
			if (result.type === 'success' && result.data && 'shareAdded' in result.data)
				addingShare = false;
		};
	};

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
	<title>{name} · Vaste lasten · Budget</title>
</svelte:head>

<div class="page">
	<BackLink parents={['/vaste-lasten', '/', '/budget', '/te-controleren']} />

	<header>
		<h1 data-morph-head="titel">{name}</h1>
		<p class="amount num">
			{formatCents(item.medianCents)}
			<span class="per">{PER_INTERVAL[item.interval]}</span>
		</p>
		<p class="muted">
			{rhythmText(item.interval, item.expectedDay)}{#if item.kind === 'wisselend'}&nbsp;· wisselend,
				tot nu toe <span class="num">{formatCents(item.minCents)}</span> tot
				<span class="num">{formatCents(item.maxCents)}</span>{/if}
		</p>
		{#if running && item.spread && item.nextDate}
			<p class="reserve">
				<span class="num">{formatCents(item.reservedCents)}</span> van
				<span class="num">{formatCents(reserveFor)}</span> opzij, afschrijving rond
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

	<section class="card history" aria-labelledby="history-title">
		<div class="section-head">
			<h2 id="history-title">Afschrijvingen</h2>
			{#if raised > 0}
				<span class="raise-tag"
					>{raised === 1 ? 'Eén prijsverhoging' : `${raised} prijsverhogingen`}</span
				>
			{/if}
		</div>
		{#if chargeBars.length === 0}
			<p class="tell">
				Nog geen afschrijvingen gezien. Op de verwachte dag staat hij op je overzicht om te
				bevestigen.
			</p>
		{:else}
			{#if chargeBars.length > 1}
				<Bars
					bars={chargeBars}
					zoom
					{color}
					label="De laatste {chargeBars.length} afschrijvingen{raised > 0
						? ', met een prijsverhoging'
						: ''}"
				/>
			{/if}
			<ul class="charges">
				{#each item.history.slice(0, 4) as t (t.id)}
					<li>
						<a class="charge" href="/transacties/{t.id}">
							<span>{formatShortDate(t.date)} {t.date.slice(0, 4)}</span>
							{#if t.status === 'verwacht'}<span class="badge">Verwacht</span>{/if}
							<span class="num">{formatCents(t.amountCents)}</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if running}
		{#if editing}
			<form
				method="POST"
				action="?/save"
				class="card form"
				use:enhance={() => {
					saving = true;
					return async ({ result, update }) => {
						await update({ reset: false });
						saving = false;
						if (result.type === 'success') editing = false;
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
					<button type="button" class="button secondary" onclick={() => (editing = false)}
						>Annuleren</button
					>
					{#if form?.message}<p class="error-text" role="alert">{form.message}</p>{/if}
				</div>
			</form>
		{:else}
			<section class="card details" aria-labelledby="details-title">
				<div class="section-head">
					<h2 id="details-title">Gegevens</h2>
					<button type="button" class="button secondary small" onclick={() => (editing = true)}
						>Bewerken</button
					>
				</div>
				<dl>
					<div>
						<dt>Verwacht bedrag</dt>
						<dd class="num">
							{formatCents(item.medianCents)}
							<span class="muted">{item.kind === 'vast' ? 'vast' : 'wisselend'}</span>
						</dd>
					</div>
					<div>
						<dt>Ritme</dt>
						<dd>{INTERVAL_LABEL[item.interval]}</dd>
					</div>
					<div>
						<dt>Volgende afschrijving</dt>
						<dd>{item.nextDate ? formatDayMonth(item.nextDate) : 'Onbekend'}</dd>
					</div>
					<div>
						<dt>Categorie</dt>
						<dd class="category">
							<span class={['dot', !color && 'none']} style:--dot={color} aria-hidden="true"></span>
							{item.categoryName ?? 'Geen categorie'}
						</dd>
					</div>
					{#if item.interval !== 'maand'}
						<div>
							<dt>Uitsmeren</dt>
							<dd>
								{item.spread ? 'Elke maand een deel opzij' : 'Uit, de afschrijfmaand krijgt alles'}
							</dd>
						</div>
					{/if}
				</dl>
				{#if form?.saved}<p class="saved" role="status">Opgeslagen</p>{/if}
			</section>
		{/if}
	{/if}

	{#if running}
		<section class="card shares" aria-labelledby="shares-title">
			<div class="shares-head">
				<h2 id="shares-title">Gedeeld</h2>
				{#if shares.length > 0}
					<span class="muted">
						jouw deel <span class="num">{formatCents(data.shares.mineCents)}</span>
					</span>
				{/if}
			</div>

			{#if raise.length > 0}
				<div class="raise">
					<p>
						{name} is duurder geworden. Gaan de aandelen mee? Een voorstel naar verhouding, vanaf volgende
						maand:
					</p>
					{#each raise as s (s.id)}
						<form method="POST" action="?/changeShare" use:enhance={keepShare} class="inline">
							<input type="hidden" name="shareId" value={s.id} />
							<input type="hidden" name="fromMonth" value={shiftMonth(thisMonth, 1)} />
							<span class="who">{s.personName}</span>
							<span class="money small-money">
								<span class="prefix" aria-hidden="true">€</span>
								<input
									name="amount"
									inputmode="decimal"
									class="num"
									aria-label="Nieuw aandeel van {s.personName}"
									value={centsToInput(s.proposed)}
									autocomplete="off"
								/>
							</span>
							<button class="button secondary small" disabled={saving}>Overnemen</button>
						</form>
					{/each}
				</div>
			{/if}

			{#if shares.length === 0}
				<p class="muted">
					Betaal je dit voor het hele huis? Geef huisgenoten een aandeel. Dan telt alleen jouw deel
					in je budget, en zie je bij <a href="/terugbetalingen">Terugbetalingen</a> wie er betaald heeft.
				</p>
			{:else}
				<ul class="share-list">
					{#each shares as s (s.id)}
						<li class={[!s.active && 'ended']}>
							<div class="row-line">
								<span class="who">{s.personName}</span>
								<span class="num">{shareTerms(s)}</span>
							</div>
							<span class="muted small">
								Rond de {s.receiveDay}e · {formatMonth(s.startMonth)}{s.endMonth
									? ` tot en met ${formatMonth(s.endMonth)}`
									: ' en verder'}{s.kind === 'percentage'
									? ` · nu ${formatCents(s.expectedCents)}`
									: ''}
							</span>
							{#if s.active}
								<details class="more">
									<summary>Aanpassen</summary>
									<form
										method="POST"
										action="?/changeShare"
										use:enhance={keepShare}
										class="share-form"
									>
										<input type="hidden" name="shareId" value={s.id} />
										<div class="row">
											<label class="field">
												<span>{s.kind === 'vast' ? 'Ander bedrag' : 'Ander percentage'}</span>
												<input
													name="amount"
													inputmode="decimal"
													class="num"
													value={s.kind === 'vast'
														? centsToInput(s.amountCents ?? 0)
														: centsToInput(s.basisPoints ?? 0)}
													required
													autocomplete="off"
												/>
											</label>
											<div class="field">
												<label for="from-{s.id}">Vanaf</label>
												<Select
													id="from-{s.id}"
													name="fromMonth"
													label="Vanaf"
													value={shiftMonth(thisMonth, 1)}
													options={months}
												/>
											</div>
										</div>
										<div>
											<button class="button secondary small" disabled={saving}
												>Bedrag opslaan</button
											>
										</div>
									</form>
									<form
										method="POST"
										action="?/updateShare"
										use:enhance={keepShare}
										class="share-form"
									>
										<input type="hidden" name="shareId" value={s.id} />
										<div class="row">
											<label class="field">
												<span>Ontvangstdag</span>
												<input
													name="receiveDay"
													type="number"
													inputmode="numeric"
													min="1"
													max="31"
													value={s.receiveDay}
													required
												/>
											</label>
											<div class="field">
												<label for="end-{s.id}">Tot en met</label>
												<Select
													id="end-{s.id}"
													name="endMonth"
													label="Tot en met"
													value={s.endMonth ?? ''}
													options={endOptions}
												/>
											</div>
										</div>
										<p class="muted small">
											Vertrekt iemand, kies dan de laatste maand. Openstaande posten blijven staan.
										</p>
										<div>
											<button class="button secondary small" disabled={saving}>Opslaan</button>
										</div>
									</form>
									<form method="POST" action="?/deleteShare" use:enhance={keepShare} class="danger">
										<input type="hidden" name="shareId" value={s.id} />
										{#if confirmDelete === s.id}
											<p class="small">
												Aandeel verwijderen? Alle posten ervan vervallen; wat {s.personName} al betaalde
												wordt tegoed.
											</p>
											<div class="confirm">
												<button class="button danger small" disabled={saving}
													>Ja, verwijderen</button
												>
												<button
													type="button"
													class="button secondary small"
													onclick={() => (confirmDelete = null)}>Annuleren</button
												>
											</div>
										{:else}
											<button
												type="button"
												class="button danger small"
												onclick={() => (confirmDelete = s.id)}>Verwijderen</button
											>
										{/if}
									</form>
								</details>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}

			{#if form?.shareMessage}<p class="error-text" role="alert">{form.shareMessage}</p>{/if}
			{#if form && ('shareAdded' in form || 'shareSaved' in form || 'shareDeleted' in form) && !saving}
				<p class="saved" role="status">
					{'shareAdded' in form
						? 'Aandeel toegevoegd'
						: 'shareDeleted' in form
							? 'Aandeel verwijderd'
							: 'Opgeslagen'}
				</p>
			{/if}

			{#if addingShare}
				<form method="POST" action="?/addShare" use:enhance={keepShare} class="share-form add">
					<h3>Nieuw aandeel</h3>
					<div class="row">
						<div class="field">
							<label for="share-person">Wie</label>
							<Select
								id="share-person"
								name="personId"
								label="Wie"
								bind:value={sharePerson}
								options={peopleOptions}
							/>
						</div>
						{#if sharePerson === ''}
							<label class="field">
								<span>Naam</span>
								<input name="newName" maxlength="40" required autocomplete="off" />
							</label>
						{:else}
							<input type="hidden" name="newName" value="" />
						{/if}
					</div>
					<fieldset class="field">
						<legend>Soort</legend>
						<div class="segmented">
							<label>
								<input type="radio" name="kind" value="vast" bind:group={shareKind} />
								<span>Vast bedrag</span>
							</label>
							<label>
								<input type="radio" name="kind" value="percentage" bind:group={shareKind} />
								<span>Percentage</span>
							</label>
						</div>
					</fieldset>
					<div class="row">
						<label class="field">
							<span>{shareKind === 'vast' ? 'Bedrag per keer' : 'Percentage'}</span>
							<span class="money">
								<span class="prefix" aria-hidden="true">{shareKind === 'vast' ? '€' : '%'}</span>
								<input
									name="amount"
									inputmode="decimal"
									class="num"
									placeholder={shareKind === 'vast' ? '0,00' : '25'}
									required
									autocomplete="off"
								/>
							</span>
						</label>
						<label class="field">
							<span>Ontvangstdag</span>
							<input
								name="receiveDay"
								type="number"
								inputmode="numeric"
								min="1"
								max="31"
								value={item.expectedDay}
								required
							/>
						</label>
					</div>
					<div class="row">
						<div class="field">
							<label for="share-start">Vanaf</label>
							<Select
								id="share-start"
								name="startMonth"
								label="Vanaf"
								value={thisMonth}
								options={months}
							/>
						</div>
						<div class="field">
							<label for="share-end">Tot en met</label>
							<Select
								id="share-end"
								name="endMonth"
								label="Tot en met"
								value=""
								options={endOptions}
							/>
						</div>
					</div>
					<p class="muted small">
						{shareKind === 'vast'
							? 'Een vast bedrag verandert nooit vanzelf, net als de overboeking van je huisgenoot.'
							: 'Een percentage volgt het echte bedrag; het aandeel wordt naar beneden afgerond.'}
						Ligt de startmaand in het verleden, dan komen de posten vanaf die maand erbij en worden overboekingen
						die al binnen zijn gekoppeld.
					</p>
					<div class="confirm">
						<button class="button" disabled={saving}>Toevoegen</button>
						<button type="button" class="button secondary" onclick={() => (addingShare = false)}
							>Sluiten</button
						>
					</div>
				</form>
			{:else}
				<div>
					<button type="button" class="button secondary small" onclick={() => (addingShare = true)}
						>Aandeel toevoegen</button
					>
				</div>
			{/if}
		</section>
	{/if}

	{#if running}
		<form method="POST" action="?/stop" use:enhance class="stop">
			{#if confirmStop}
				<p>
					{name} stoppen? Open verwachte posten vervallen{#if item.spread && item.reservedCents > 0},
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

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 8px 12px;
	}

	.raise-tag {
		padding: 2px 10px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--warn) 20%, transparent);
		color: color-mix(in oklch, var(--warn) 60%, var(--text));
		font-size: 0.85rem;
		font-weight: 600;
	}

	.charges {
		margin-top: 4px;
	}

	.charge {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: var(--tap);
		color: inherit;
		text-decoration: none;
	}

	.charge .num {
		margin-left: auto;
		font-weight: 600;
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

	dd .muted {
		font-weight: 400;
	}

	.category {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--dot);
	}

	.dot.none {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--muted);
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

	.small {
		font-size: 0.88rem;
	}

	.button.small {
		min-height: var(--tap);
		padding: 0 14px;
		font-size: 0.92rem;
	}

	.shares-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.share-list li {
		display: grid;
		gap: 2px;
		padding: 10px 0;
		min-height: 0;
	}

	.share-list li.ended {
		color: var(--muted);
	}

	.row-line {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.row-line .num {
		margin-left: auto;
		font-weight: 600;
	}

	.who {
		font-weight: 550;
		overflow-wrap: anywhere;
	}

	.more summary {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		color: var(--accent-strong);
		font-weight: 550;
		cursor: pointer;
	}

	.share-form {
		display: grid;
		gap: 12px;
		padding: 6px 0 12px;
	}

	.share-form.add {
		padding-top: 12px;
		border-top: 1px solid var(--line);
	}

	.share-form h3 {
		font-size: 1.05rem;
	}

	.danger {
		display: grid;
		gap: 8px;
		justify-items: start;
	}

	.raise {
		display: grid;
		gap: 8px;
		padding: 12px;
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}

	.small-money {
		width: 8rem;
	}
</style>
