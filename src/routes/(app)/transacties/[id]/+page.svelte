<script lang="ts">
	import { enhance } from '$app/forms';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import ShareForm from '#lib/components/ShareForm.svelte';
	import Switch from '#lib/components/Switch.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatMonth, formatShortDate } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';

	let { data, form } = $props();
	const tx = $derived(data.tx);
	const sourceText = {
		import: 'Bankimport',
		handmatig: 'Handmatig',
		bon: 'Bon',
		verwacht: 'Verwacht'
	};

	const ruleText = {
		tegenpartij: 'Tegenpartij bevat',
		iban: 'IBAN is',
		omschrijving: 'Omschrijving bevat'
	};
	const categoryHint = $derived(
		data.rule
			? `Via regel: ${ruleText[data.rule.field]} “${data.rule.pattern}”`
			: tx.categorySource === 'handmatig'
				? 'Zelf gekozen; regels laten deze categorie staan'
				: tx.categorySource === 'intern'
					? 'Overboeking tussen je eigen rekeningen'
					: null
	);

	let saving = $state(false);
	let confirmDelete = $state(false);
	let editingShare = $state(false);
	let confirmUnshare = $state(false);

	const myShare = $derived(data.splits.find((s) => s.note === 'Mijn deel'));
	const anyPaid = $derived(
		data.posts.some((p) => p.paidCents > 0 || p.status === 'kwijtgescholden')
	);
	const postStatus = (p: (typeof data.posts)[number]) =>
		p.status === 'kwijtgescholden'
			? 'Kwijtgescholden'
			: p.status === 'betaald'
				? 'Betaald'
				: p.status === 'deels'
					? `${formatCents(p.paidCents)} betaald`
					: 'Open';
	const labelText = {
		waarschijnlijk: 'Waarschijnlijk',
		mogelijk: 'Mogelijk',
		onwaarschijnlijk: 'Onwaarschijnlijk'
	};
	// Terugboekingen: wat deze boeking verrekent, of wat erop terugkwam
	const original = $derived(data.correction?.original ?? null);
	const corrections = $derived(data.correction?.corrections ?? []);
	const refunds = $derived(data.links.length === 0 ? (data.refundMatch?.candidates ?? []) : []);
	// Koppellijst (`post:<id>` of `retour:<id>`): voorgeselecteerd als de bovenste duidelijk voorloopt
	let chosen = $derived(
		data.match?.preselect
			? `post:${data.match.preselect}`
			: data.refundMatch?.preselect
				? `retour:${data.refundMatch.preselect}`
				: ''
	);
	const chosenRefund = $derived(refunds.find((r) => `retour:${r.id}` === chosen));
	const showLinks = $derived(
		tx.amountCents !== 0 &&
			!original &&
			data.posts.length === 0 &&
			(data.links.length > 0 || (data.match?.candidates.length ?? 0) > 0 || refunds.length > 0)
	);
	const linkTitle = $derived(
		data.links.length === 0 && (data.match?.candidates.length ?? 0) === 0
			? 'Retour van'
			: refunds.length > 0
				? 'Koppelen aan'
				: tx.amountCents > 0
					? 'Ontvangen voor'
					: 'Terugbetaald voor'
	);
	let onlyMine = $state(false);
	const groups = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

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
	{#if form && 'ibanMessage' in form && form.ibanMessage}
		{#key form}<Toast text={form.ibanMessage} />{/key}
	{/if}

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
		<h1><span data-tx-name={tx.id}>{tx.counterparty || 'Zonder naam'}</span></h1>
		<p class={['amount', 'num', tx.amountCents > 0 && 'in']}>
			<span data-tx-amount={tx.id}>
				{#if tx.amountCents === 0 && tx.origCurrency && tx.origAmountCents !== null}
					{tx.origCurrency}
					{centsToInput(tx.origAmountCents)}
				{:else}
					{formatCents(tx.amountCents, { sign: true })}
				{/if}
			</span>
		</p>
		<p class="muted">
			{sourceText[tx.source]} · {formatShortDate(tx.date)}
			{tx.date.slice(0, 4)}
			{#if tx.description}· {tx.description}{/if}
		</p>
		{#if tx.status === 'te_controleren'}
			<p class="review">
				Te controleren{tx.amountCents === 0
					? ': vul het eurobedrag in dat is afgeschreven.'
					: refunds.length > 0
						? ': hoort dit bij een eerdere boeking? Kies hem hieronder.'
						: '.'}
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
				{#if categoryHint}<p class="muted hint">{categoryHint}</p>{/if}
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

	{#if tx.amountCents < 0 && !original}
		<section class="card section" aria-labelledby="share-title">
			<h2 id="share-title">Voorgeschoten</h2>
			{#if editingShare}
				<ShareForm
					totalCents={-tx.amountCents}
					people={data.people}
					initial={data.posts
						.filter((p) => p.personName)
						.map((p) => ({ name: p.personName!, amountCents: p.amountCents }))}
					message={form && 'shareMessage' in form ? form.shareMessage : undefined}
					onclose={() => (editingShare = false)}
				/>
			{:else if data.posts.length > 0}
				<ul class="lines">
					{#if myShare}
						<li class="mine">
							<span>Jouw deel <span class="muted small">telt in je budget</span></span>
							<span class="num">{formatCents(-myShare.amountCents)}</span>
						</li>
					{/if}
					{#each data.posts as p (p.id)}
						{@const payment = p.payments.at(-1)}
						<li>
							{#if payment}
								<!-- Naar de (laatste) betaling op deze post -->
								<a class="row-link" href={`/transacties/${payment.transactionId}`}>
									<span>
										{p.personName ?? 'Nog onbekend'}
										<span class="muted small"
											>{postStatus(p)} · {formatShortDate(payment.date)}</span
										>
									</span>
									<span class="num">{formatCents(p.amountCents)}</span>
								</a>
							{:else}
								<span>
									{p.personName ?? 'Nog onbekend'}
									<span class="muted small">{postStatus(p)}</span>
								</span>
								<span class="num">{formatCents(p.amountCents)}</span>
							{/if}
						</li>
					{/each}
				</ul>
				{#if anyPaid}
					<p class="muted small">
						Er is al betaald of een retour gekoppeld, dus de verdeling ligt vast. Aanpassen of
						kwijtschelden doe je bij
						<a href="/te-krijgen">Te krijgen</a>.
					</p>
				{:else if confirmUnshare}
					<form method="POST" action="?/unshare" use:enhance class="confirm-row">
						<p>Niet meer delen? Het hele bedrag telt dan als jouw uitgave.</p>
						<div class="buttons">
							<button class="button danger">Ja, niet meer delen</button>
							<button
								type="button"
								class="button secondary"
								onclick={() => (confirmUnshare = false)}>Annuleren</button
							>
						</div>
					</form>
				{:else}
					<div class="buttons">
						<button type="button" class="button secondary" onclick={() => (editingShare = true)}
							>Verdeling aanpassen</button
						>
						<button type="button" class="button danger" onclick={() => (confirmUnshare = true)}
							>Niet meer delen</button
						>
					</div>
				{/if}
				{#if form && 'shareMessage' in form && form.shareMessage}
					<p class="error-text" role="alert">{form.shareMessage}</p>
				{/if}
			{:else}
				<p class="muted">
					Betaalde je ook voor anderen? Dan telt alleen jouw deel in je budget en zie je bij Te
					krijgen wat de rest nog moet.
				</p>
				<button type="button" class="button secondary start" onclick={() => (editingShare = true)}
					>Voorgeschoten</button
				>
			{/if}
		</section>
	{/if}

	{#if showLinks}
		<section class="card section" aria-labelledby="link-title">
			<h2 id="link-title">{linkTitle}</h2>
			{#if data.links.length > 0}
				<ul class="lines">
					{#each data.links as l (l.id)}
						<li>
							<!-- Naar de uitgave van de post; zonder uitgave naar het overzicht van de post -->
							<a
								class="row-link"
								href={l.sourceId
									? `/transacties/${l.sourceId}`
									: l.owedId && !l.month
										? '/te-krijgen'
										: '/terugbetalingen'}
							>
								<span>
									{l.personName}
									<span class="muted small"
										>{l.owedId
											? `${l.sourceCounterparty || l.description || 'Post'} · ${l.month ? formatMonth(l.month) : formatShortDate(l.sourceDate ?? l.date!)}`
											: 'Tegoed voor de volgende post'}</span
									>
								</span>
								<span class="side">
									<span class="num">{formatCents(l.amountCents)}</span>
									{#if l.sourceAmountCents !== null}
										<span class="muted small num"
											>van {formatCents(l.sourceAmountCents, { sign: true })}</span
										>
									{/if}
								</span>
							</a>
						</li>
					{/each}
				</ul>
				{#if data.ibanSuggestion}
					<form method="POST" action="?/saveIban" use:enhance class="confirm-row">
						<p>
							Hoort <span class="num">{groups(data.ibanSuggestion.iban)}</span> bij {data
								.ibanSuggestion.name}? Dan herkent de koppellijst die rekening voortaan.
						</p>
						<div class="buttons">
							<button class="button secondary">IBAN bewaren bij {data.ibanSuggestion.name}</button>
						</div>
					</form>
				{/if}
				<form method="POST" action="?/unlink" use:enhance>
					<button class="button secondary">Losmaken</button>
				</form>
			{:else}
				<form method="POST" action="?/link" use:enhance class="match">
					<fieldset>
						<legend class="visually-hidden">Kies de post of uitgave</legend>
						{#each data.match?.candidates ?? [] as c (c.id)}
							<label class="option">
								<input type="radio" name="target" value={`post:${c.id}`} bind:group={chosen} />
								<span class="who-what">
									<strong>{c.personName}</strong>
									<span class="muted small"
										>{c.description || 'Post'} · {formatShortDate(c.date)}</span
									>
								</span>
								<span class="side">
									<span class="num">{formatCents(c.outstandingCents)}</span>
									<span class={['tag', c.label]}>{labelText[c.label]}</span>
								</span>
							</label>
						{/each}
						{#each refunds as r (r.id)}
							<label class="option">
								<input type="radio" name="target" value={`retour:${r.id}`} bind:group={chosen} />
								<span class="who-what">
									<strong>{r.counterparty || 'Zonder naam'}</strong>
									<span class="muted small"
										>{r.categoryName ?? 'Zonder categorie'} · {formatShortDate(r.date)}{r.shared
											? ' · voorgeschoten'
											: ''}</span
									>
								</span>
								<span class="side">
									<span class="num">{formatCents(r.amountCents, { sign: true })}</span>
									<span class={['tag', r.label]}>{labelText[r.label]}</span>
								</span>
							</label>
						{/each}
					</fieldset>
					{#if chosenRefund}
						{#if chosenRefund.shared}
							<Switch
								name="onlyMine"
								bind:checked={onlyMine}
								hint="Voor als het teruggebrachte spul van jou was. Anders gaat het naar verhouding over iedereen."
								>Alleen van mijn deel</Switch
							>
						{:else if chosenRefund.splitCategories.length > 1}
							<div class="field">
								<label for="refund-category">Gaat af van</label>
								<Select
									id="refund-category"
									name="categoryId"
									label="Gaat af van"
									value={chosenRefund.splitCategories[0]?.categoryId ?? ''}
									options={chosenRefund.splitCategories.map((s) => ({
										value: s.categoryId ?? '',
										label: `${s.name ?? 'Zonder categorie'} (${formatCents(-s.amountCents)})`,
										dot: null
									}))}
								/>
							</div>
						{/if}
						<p class="muted small">
							Telt in {chosenRefund.categoryName ?? 'de categorie van de uitgave'} in {formatMonth(
								chosenRefund.date.slice(0, 7)
							)}; het saldo telt hem op {formatShortDate(tx.date)}.
						</p>
					{:else}
						<p class="muted small">
							Een deelbetaling laat de rest open; meer dan er openstaat wordt tegoed.
						</p>
					{/if}
					<div class="buttons">
						<button class="button" disabled={!chosen}>Koppelen</button>
					</div>
				</form>
			{/if}
			{#if form && 'linkMessage' in form && form.linkMessage}
				<p class="error-text" role="alert">{form.linkMessage}</p>
			{/if}
		</section>
	{/if}

	{#if original}
		<section class="card section" aria-labelledby="correction-title">
			<h2 id="correction-title">Verrekend met</h2>
			<ul class="lines">
				<li>
					<a class="row-link" href={`/transacties/${original.id}`}>
						<span>
							{original.counterparty || 'Zonder naam'}
							<span class="muted small"
								>{original.categoryName ?? 'Zonder categorie'} · {formatShortDate(
									original.date
								)}</span
							>
						</span>
						<span class="num">{formatCents(original.amountCents, { sign: true })}</span>
					</a>
				</li>
			</ul>
			{#if data.correction?.shared}
				{@const shared = data.correction.shared}
				<ul class="lines">
					<li class="mine">
						<span>Jouw deel <span class="muted small">telt in je budget</span></span>
						<span class="num">{formatCents(shared.mineCents)} lager</span>
					</li>
					{#each shared.parts as p, i (i)}
						<li>
							<span>
								{p.personName}
								{#if p.payBackCents > 0}
									<span class="muted small"
										>{formatCents(p.payBackCents)} te betalen; had al meer betaald</span
									>
								{/if}
							</span>
							<span class="num">{formatCents(p.cents)} lager</span>
						</li>
					{/each}
				</ul>
				{#if shared.alternative}
					<form method="POST" action="?/correctionMode" use:enhance>
						<input type="hidden" name="mode" value={shared.alternative} />
						<button class="button secondary"
							>{shared.alternative === 'mijn_deel'
								? 'Alleen van mijn deel'
								: 'Naar verhouding verdelen'}</button
						>
					</form>
				{/if}
			{/if}
			<p class="muted small">
				Telt in {original.categoryName ?? 'de categorie van de uitgave'} in {formatMonth(
					original.date.slice(0, 7)
				)}, ook als het geld later binnenkwam; het saldo telt hem op {formatShortDate(tx.date)}.
				{#if data.correction?.auto}Automatisch gekoppeld als storno.{/if}
			</p>
			<form method="POST" action="?/unlinkCorrection" use:enhance>
				<button class="button secondary">Losmaken</button>
			</form>
			{#if form && 'linkMessage' in form && form.linkMessage}
				<p class="error-text" role="alert">{form.linkMessage}</p>
			{/if}
		</section>
	{/if}

	{#if corrections.length > 0}
		<section class="card section" aria-labelledby="refunds-title">
			<h2 id="refunds-title">Teruggekregen</h2>
			<ul class="lines">
				{#each corrections as c (c.id)}
					<li>
						<a class="row-link" href={`/transacties/${c.id}`}>
							<span>
								{c.counterparty || 'Zonder naam'}
								<span class="muted small">{formatShortDate(c.date)}</span>
							</span>
							<span class={['num', c.amountCents > 0 && 'in']}
								>{formatCents(c.amountCents, { sign: true })}</span
							>
						</a>
					</li>
				{/each}
			</ul>
			<p class="muted small">
				Telt in deze categorie en maand.
				{#if (data.correction?.roomCents ?? 0) > 0}Er kan nog {formatCents(
						data.correction!.roomCents
					)} terug.{:else}Het hele bedrag is terug.{/if}
			</p>
		</section>
	{/if}

	<form method="POST" action="?/delete" use:enhance class="delete">
		{#if confirmDelete}
			<p>
				Deze transactie verwijderen? Je kunt dit niet ongedaan maken.{#if corrections.length > 0}
					De retouren erop worden gewone boekingen om te controleren.{/if}
			</p>
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
	.hint {
		margin: 0;
		font-size: 0.85rem;
	}

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

	/* Eén doorlopend vlak, zodat de overgang vanuit de lijst niet afbreekt op een lange naam */
	[data-tx-name],
	[data-tx-amount] {
		display: inline-block;
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

	.section {
		display: grid;
		gap: 14px;
		padding: 20px;
	}

	.small {
		font-size: 0.88rem;
	}

	.lines {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
	}

	.lines li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 48px;
		border-top: 1px solid var(--line);
	}

	.lines li:first-child {
		border-top: 0;
	}

	.lines li > span:first-child {
		display: grid;
		line-height: 1.3;
	}

	.mine {
		font-weight: 600;
	}

	.row-link {
		display: flex;
		flex: 1;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 48px;
		color: inherit;
		text-decoration: none;
	}

	.row-link > span:first-child {
		display: grid;
		line-height: 1.3;
	}

	.num.in {
		color: var(--accent-strong);
	}

	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.start {
		justify-self: start;
	}

	.confirm-row {
		display: grid;
		gap: 10px;
	}

	.match {
		display: grid;
		gap: 10px;
	}

	.match fieldset {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}

	.option {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 52px;
		padding: 4px 6px;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.option:has(input:checked) {
		background: var(--accent-soft);
	}

	.option input {
		flex: none;
		width: 20px;
		height: 20px;
		min-height: 0;
		margin: 0;
		accent-color: var(--accent);
	}

	.who-what {
		flex: 1;
		min-width: 0;
		display: grid;
		line-height: 1.3;
	}

	.side {
		display: grid;
		justify-items: end;
		gap: 2px;
	}

	.tag {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--muted);
	}

	.tag.waarschijnlijk {
		color: var(--accent-strong);
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
