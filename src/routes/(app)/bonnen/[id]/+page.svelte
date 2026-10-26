<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { fade } from 'svelte/transition';
	import BackLink from '#lib/components/BackLink.svelte';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { formatShortDate } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';
	import { motion } from '#lib/motion.ts';
	import {
		itemCountText,
		itemFieldList,
		receiptAmount,
		signedAmount,
		stageSentence,
		type ItemFieldName,
		type ReceiptFieldName
	} from '#lib/receipts.ts';
	import { displayName } from '#lib/text.ts';

	// Bon (spec: Schermen, Bonnetjes en koppelen): wat Haiku las, per veld hoe zeker, en de
	// koppellijst om hem te verwerken. Tijdens het lezen een rustige laadstaat die overgaat in de
	// herkende velden. Notities van Haiku zijn gewone tekst. Een screenshot met transacties toont
	// een lijst: per regel aanvinken en de koppeling, en daarna één bevestigknop.

	let { data } = $props();
	const r = $derived(data.receipt);
	const reading = $derived(r.stage === 'wordt_gelezen');
	const isList = $derived(r.kind === 'lijst');
	const name = $derived(isList ? 'Screenshot' : r.store ? displayName(r.store) || r.store : 'Bon');
	const doubt = $derived(
		(['winkel', 'datum', 'totaal', 'valuta'] as const).filter(
			(f) => r.confidence[f].status !== 'zeker'
		) as ReceiptFieldName[]
	);

	let toast = $state<{ text: string; error: boolean; key: number } | null>(null);
	const notify = (text: string, error = false) => (toast = { text, error, key: Date.now() });

	let editing = $state(false);
	let relink = $state(false);
	let deleting = $state(false);
	let busy = $state<string | null>(null);
	let large = $state(false);

	// Een onvolledige bon opent meteen in het formulier
	const formOpen = $derived(editing || (!reading && !isList && !data.complete));
	const showMatch = $derived(
		!reading &&
			!isList &&
			data.complete &&
			!formOpen &&
			(relink || r.stage === 'kiezen' || r.stage === 'onzeker' || r.stage === 'fout')
	);

	// Voorselectie alleen bij een duidelijke voorloper; anders kies je zelf
	let chosen = $derived<string | null>(data.preselect ? `transactie:${data.preselect}` : null);

	const act =
		(key: string, done: string, after?: () => void): SubmitFunction =>
		() => {
			busy = key;
			return async ({ result, update }) => {
				busy = null;
				if (result.type === 'success') {
					after?.();
					notify(done);
					await update({ reset: false });
					return;
				}
				if (result.type === 'redirect') {
					await update();
					return;
				}
				const message = result.type === 'failure' ? result.data?.message : undefined;
				notify(
					typeof message === 'string' ? message : 'Dat lukte niet. Probeer het opnieuw.',
					true
				);
			};
		};

	// Zolang Haiku leest, elke twee seconden kijken (hooguit drie minuten)
	$effect(() => {
		if (!reading) return;
		// Pas na een verversing de volgende plannen, zodat ze elkaar nooit afbreken
		const started = Date.now();
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const next = () => {
			if (stopped || Date.now() - started > 180_000) return;
			timer = setTimeout(() => void invalidate('app:bon').finally(next), 2000);
		};
		next();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});

	const fieldRows: { key: ReceiptFieldName; label: string }[] = [
		{ key: 'winkel', label: 'Winkel' },
		{ key: 'datum', label: 'Datum' },
		{ key: 'totaal', label: 'Totaal' },
		{ key: 'valuta', label: 'Valuta' },
		{ key: 'betaalwijze', label: 'Betaalwijze' }
	];

	const paymentText = {
		pin: 'Pin',
		creditcard: 'Creditcard',
		contant: 'Contant',
		cadeaukaart: 'Cadeaukaart',
		overig: 'Anders'
	};

	function value(key: ReceiptFieldName): string {
		switch (key) {
			case 'winkel':
				return r.store ?? '';
			case 'datum':
				return r.date ? `${formatShortDate(r.date)} ${r.date.slice(0, 4)}` : '';
			case 'totaal':
				return r.totalCents === null ? '' : receiptAmount(r.totalCents, r.currency);
			case 'valuta':
				return r.currency ?? '';
			case 'betaalwijze':
				return r.paymentMethod ? paymentText[r.paymentMethod] : '';
		}
	}

	function confidenceText(key: ReceiptFieldName): string {
		const c = r.confidence[key];
		if (c.corrected) return 'Zelf aangepast';
		if (c.model === null) return 'Niet gelezen';
		if (c.status === 'zeker') return 'Zeker';
		if (c.status === 'controleren') return 'Twijfel';
		return c.model === 'onleesbaar' ? 'Onleesbaar' : 'Klopt niet';
	}

	const labelText = {
		waarschijnlijk: 'Waarschijnlijk',
		mogelijk: 'Mogelijk',
		onwaarschijnlijk: 'Onwaarschijnlijk'
	};

	const txAmount = (t: {
		amountCents: number;
		origAmountCents: number | null;
		origCurrency: string | null;
	}) =>
		t.amountCents === 0 && t.origCurrency && t.origAmountCents !== null
			? `${t.origCurrency} ${centsToInput(t.origAmountCents)}`
			: formatCents(t.amountCents, { sign: true });

	const accountOptions = $derived(data.accounts.map((a) => ({ value: a.id, label: a.name })));

	// Screenshot met transacties: wat is aangevinkt en waar elke regel bij hoort
	type Item = (typeof data.items)[number];
	let checked = $derived<Record<string, boolean>>(
		Object.fromEntries(data.items.map((i) => [i.id, i.plan.checked]))
	);
	let targets = $derived<Record<string, string>>(
		Object.fromEntries(
			data.items.map((i) => [
				i.id,
				i.plan.action === 'koppelen'
					? `transactie:${i.plan.transactionId}`
					: i.plan.action === 'nieuw'
						? 'nieuw'
						: ''
			])
		)
	);
	const picked = $derived(data.items.filter((i) => checked[i.id]));
	const newCount = $derived(picked.filter((i) => targets[i.id] === 'nieuw').length);
	const linkCount = $derived(picked.filter((i) => targets[i.id]?.startsWith('transactie:')).length);
	const openCount = $derived(picked.filter((i) => !targets[i.id]).length);
	const doubled = $derived.by(() => {
		const links = picked.map((i) => targets[i.id]).filter((t) => t?.startsWith('transactie:'));
		return new Set(links).size !== links.length;
	});

	const ITEM_FIELDS: ItemFieldName[] = ['datum', 'tegenpartij', 'bedrag', 'valuta'];
	const itemName = (i: Item) =>
		i.counterparty ? displayName(i.counterparty) || i.counterparty : 'Zonder naam';
	const itemDoubt = (i: Item) => ITEM_FIELDS.filter((f) => i.confidence[f].status !== 'zeker');
	const itemNotes = (i: Item) =>
		ITEM_FIELDS.map((f) => i.confidence[f].note)
			.filter((n) => n !== '')
			.join(' ');

	function itemState(i: Item): string {
		if (!i.complete) return 'niet volledig gelezen';
		if (!checked[i.id]) return 'overslaan';
		const t = targets[i.id];
		if (t === 'nieuw') return i.currency === 'EUR' ? 'nieuw' : 'nieuw, eurobedrag later';
		return t ? 'staat er al' : 'kies zelf';
	}

	function itemOptions(i: Item): SelectOption[] {
		return [
			...i.candidates.map((c) => ({
				value: `transactie:${c.id}`,
				label: `${displayName(c.counterparty) || 'Zonder naam'} · ${formatShortDate(c.date)} · ${txAmount(c)} · ${labelText[c.label]}`
			})),
			{ value: 'nieuw', label: 'Nieuwe transactie' }
		];
	}

	const listSummary = $derived.by(() => {
		if (picked.length === 0) return 'Niets aangevinkt.';
		const parts = [];
		if (newCount > 0) parts.push(`${newCount} nieuw`);
		if (linkCount > 0) parts.push(`${linkCount} al in je cijfers`);
		if (openCount > 0) parts.push(`${openCount} nog te kiezen`);
		return `${parts.join(', ')}.`;
	});
</script>

<svelte:head>
	<title>{name} · Budget</title>
</svelte:head>

<div class="page">
	<BackLink parents={['/bonnen', '/te-controleren', '/']} />

	<header>
		<h1>{reading ? 'Bon' : name}</h1>
		{#if reading}
			<span class="bar amount-bar" aria-hidden="true"></span>
			<p class="tell" role="status">{stageSentence('wordt_gelezen', [])}</p>
		{:else}
			<p class="amount num" in:fade={{ duration: motion(240) }}>
				{#if isList}
					{itemCountText(r.itemCount)}
				{:else}
					{r.totalCents === null ? '—' : receiptAmount(r.totalCents, r.currency)}
				{/if}
			</p>
			<p class="tell" in:fade={{ duration: motion(240) }}>{stageSentence(r.stage, doubt)}</p>
		{/if}
		<p class="muted small">
			{r.source === 'deelmenu' ? 'Via het deelmenu' : 'Vanuit de app'} · ontvangen {formatShortDate(
				r.createdAt.slice(0, 10)
			)}
		</p>
	</header>

	<figure class={['preview', 'card', large && 'large']}>
		<img
			src="/api/receipts/{r.id}/image"
			alt={isList ? 'Het screenshot' : 'Foto van de bon'}
			decoding="async"
		/>
		<button type="button" class="text-button" onclick={() => (large = !large)}
			>{large ? 'Kleiner' : 'Groter'}</button
		>
	</figure>

	{#if formOpen}
		<form
			method="POST"
			action="?/correct"
			class="card form"
			use:enhance={act('correct', 'Opgeslagen.', () => (editing = false))}
		>
			<h2>Gegevens</h2>
			{#if r.stage === 'fout'}
				<p class="muted small">Vul in wat op de bon staat; daarna kies je waar hij bij hoort.</p>
			{/if}
			<label class="field">
				<span>Winkel</span>
				<input name="store" value={r.store ?? ''} maxlength="100" autocomplete="off" required />
			</label>
			<div class="pair">
				<label class="field">
					<span>Datum</span>
					<input type="date" name="date" value={r.date ?? ''} required />
				</label>
				<label class="field">
					<span>Totaal</span>
					<input
						name="amount"
						class="num"
						inputmode="decimal"
						value={r.totalCents === null ? '' : centsToInput(r.totalCents)}
						placeholder="0,00"
						autocomplete="off"
						required
					/>
				</label>
			</div>
			<label class="field">
				<span>Valuta</span>
				<input
					name="currency"
					class="currency"
					value={r.currency ?? 'EUR'}
					maxlength="3"
					autocomplete="off"
					required
				/>
			</label>
			<div class="buttons">
				<button class="button" disabled={busy === 'correct'}
					>{busy === 'correct' ? 'Opslaan…' : 'Opslaan'}</button
				>
				{#if data.complete}
					<button type="button" class="button secondary" onclick={() => (editing = false)}
						>Annuleren</button
					>
				{/if}
			</div>
		</form>
	{:else if !isList || reading}
		<section class="card details" aria-labelledby="details-title" aria-busy={reading}>
			<div class="section-head">
				<h2 id="details-title">Gegevens</h2>
				{#if !reading}
					<button type="button" class="button secondary small" onclick={() => (editing = true)}
						>Bewerken</button
					>
				{/if}
			</div>
			<dl>
				{#each fieldRows as f (f.key)}
					<div>
						<dt>{f.label}</dt>
						{#if reading}
							<dd><span class="bar" aria-hidden="true"></span></dd>
						{:else}
							{@const c = r.confidence[f.key]}
							<dd in:fade={{ duration: motion(240) }}>
								<span>{value(f.key) || '—'}</span>
								<span class={['conf', c.status, c.corrected && 'own']}>
									<span class="mark" aria-hidden="true"></span>{confidenceText(f.key)}
								</span>
								{#if c.note && !c.corrected}<span class="muted hint">{c.note}</span>{/if}
							</dd>
						{/if}
					</div>
				{/each}
			</dl>
			{#if !reading && r.lineCount > 0}
				<p class="muted small">
					{r.lineCount}
					{r.lineCount === 1 ? 'regel' : 'regels'} gelezen.
				</p>
			{/if}
		</section>
	{/if}

	{#if isList && !reading && r.stage === 'lijst'}
		<form
			method="POST"
			action="?/confirmList"
			class="card section"
			aria-labelledby="list-title"
			use:enhance={act('list', 'Lijst bevestigd.', () =>
				dispatchEvent(new CustomEvent('invoer', { detail: 'bon' }))
			)}
		>
			<div class="section-head">
				<h2 id="list-title">Transacties</h2>
				<span class="muted small" aria-live="polite"
					>{picked.length} van {data.items.length} aangevinkt</span
				>
			</div>
			{#if data.items.length === 0}
				<p class="muted small">
					Haiku vond geen transacties op dit screenshot. Laat het opnieuw lezen of gooi het weg.
				</p>
			{:else}
				<ul class="items">
					{#each data.items as item (item.id)}
						{@const label = itemName(item)}
						{@const doubt = itemDoubt(item)}
						{@const notes = itemNotes(item)}
						<li class="item">
							<label class={['pick', !item.complete && 'off']}>
								<input
									type="checkbox"
									name="item"
									value={item.id}
									checked={checked[item.id]}
									disabled={!item.complete}
									onchange={(e) => (checked = { ...checked, [item.id]: e.currentTarget.checked })}
								/>
								<span class="who-what">
									<strong>{label}</strong>
									<span class="muted small"
										>{item.date ? formatShortDate(item.date) : 'Zonder datum'} · {itemState(
											item
										)}</span
									>
								</span>
								<span class={['num', 'side', (item.amountCents ?? 0) > 0 && 'in']}
									>{item.amountCents === null
										? '—'
										: signedAmount(item.amountCents, item.currency)}</span
								>
							</label>
							{#if checked[item.id]}
								{#if item.plan.action === 'koppelen' || item.plan.action === 'kiezen'}
									<div class="target">
										<Select
											name="target-{item.id}"
											label="Waar hoort {label} bij?"
											value={targets[item.id]}
											options={itemOptions(item)}
											onchange={(v) => (targets = { ...targets, [item.id]: v })}
											required
										/>
									</div>
								{:else}
									<input type="hidden" name="target-{item.id}" value="nieuw" />
								{/if}
							{/if}
							{#if !item.complete}
								<p class="hint">
									<span class="conf onzeker"><span class="mark" aria-hidden="true"></span></span>
									Niet alles te lezen{notes ? `: ${notes}` : ''}. Voer hem zelf in als hij erbij
									hoort.
								</p>
							{:else if doubt.length > 0}
								<p class="hint">
									<span class="conf controleren"><span class="mark" aria-hidden="true"></span></span
									>
									Twijfel over {itemFieldList(doubt)}.{notes ? ` ${notes}` : ''}
								</p>
							{/if}
						</li>
					{/each}
				</ul>
				{#if newCount > 0}
					<div class="field">
						<label for="lijst-account">Rekening voor nieuwe transacties</label>
						<Select
							id="lijst-account"
							name="accountId"
							label="Rekening"
							value={data.defaultAccount ?? ''}
							options={accountOptions}
							required
						/>
					</div>
				{/if}
				<p class="muted small">
					{doubled ? 'Twee regels horen bij dezelfde transactie; kies er één.' : listSummary}
				</p>
				<div class="buttons">
					<button
						class="button"
						disabled={picked.length === 0 || openCount > 0 || doubled || busy === 'list'}
						>{busy === 'list' ? 'Bevestigen…' : 'Bevestigen'}</button
					>
				</div>
			{/if}
		</form>
	{:else if isList && !reading}
		<section class="card section" aria-labelledby="list-title">
			<h2 id="list-title">Transacties</h2>
			<ul class="items">
				{#each data.items as item (item.id)}
					{@const label = itemName(item)}
					<li>
						{#if item.linked}
							{@const t = item.linked}
							<a class="row-link" href="/transacties/{t.id}">
								<span>
									{label}
									<span class="muted small"
										>{formatShortDate(t.date)}{t.status === 'te_controleren'
											? ' · te controleren'
											: ''}</span
									>
								</span>
								<span class={['num', t.amountCents > 0 && 'in']}>{txAmount(t)}</span>
							</a>
						{:else}
							<div class="row-link skipped">
								<span>
									{label}
									<span class="muted small"
										>{item.date ? formatShortDate(item.date) : 'Zonder datum'} · overgeslagen</span
									>
								</span>
								<span class="num muted"
									>{item.amountCents === null
										? '—'
										: signedAmount(item.amountCents, item.currency)}</span
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if showMatch}
		<section class="card section" aria-labelledby="match-title">
			<h2 id="match-title">Waar hoort hij bij?</h2>
			<form
				method="POST"
				action="?/settle"
				class="match"
				use:enhance={act('settle', 'Bon verwerkt.', () => {
					relink = false;
					dispatchEvent(new CustomEvent('invoer', { detail: 'bon' }));
				})}
			>
				<fieldset>
					<legend class="visually-hidden">Kies de transactie of een nieuwe</legend>
					{#each data.candidates as c (c.id)}
						{@const target = `transactie:${c.id}`}
						<label class="option">
							<input
								type="radio"
								name="target"
								value={target}
								checked={chosen === target}
								onchange={() => (chosen = target)}
							/>
							<span class="who-what">
								<strong>{displayName(c.counterparty) || 'Zonder naam'}</strong>
								<span class="muted small"
									>{c.categoryName ?? 'Geen categorie'} · {formatShortDate(c.date)} · {c.accountAlias}</span
								>
							</span>
							<span class="side">
								<span class="num">{txAmount(c)}</span>
								<span class={['tag', c.label]}>{labelText[c.label]}</span>
							</span>
						</label>
					{/each}
					<label class="option">
						<input
							type="radio"
							name="target"
							value="nieuw"
							checked={chosen === 'nieuw'}
							onchange={() => (chosen = 'nieuw')}
						/>
						<span class="who-what">
							<strong>Nieuwe transactie</strong>
							<span class="muted small">{name} · {r.date ? formatShortDate(r.date) : ''}</span>
						</span>
						<span class="side">
							<span class="num"
								>{r.currency === 'EUR'
									? formatCents(-(r.totalCents ?? 0), { sign: true })
									: receiptAmount(r.totalCents, r.currency)}</span
							>
						</span>
					</label>
				</fieldset>
				{#if chosen === 'nieuw'}
					<div class="field">
						<label for="bon-account">Rekening</label>
						<Select
							id="bon-account"
							name="accountId"
							label="Rekening"
							value={data.defaultAccount ?? ''}
							options={accountOptions}
							required
						/>
					</div>
				{/if}
				<p class="muted small">
					{#if data.candidates.length === 0}
						Geen transactie gevonden die erop lijkt.
					{:else if !data.preselect}
						Geen duidelijke voorloper; kies zelf, zodat niets dubbel telt.
					{:else}
						De bovenste loopt duidelijk voor.
					{/if}
				</p>
				<div class="buttons">
					<button class="button" disabled={!chosen || busy === 'settle'}>Verwerken</button>
					{#if relink}
						<button type="button" class="button secondary" onclick={() => (relink = false)}
							>Annuleren</button
						>
					{/if}
				</div>
			</form>
		</section>
	{:else if !reading && data.linked && !formOpen}
		{@const t = data.linked}
		<section class="card section" aria-labelledby="linked-title">
			<h2 id="linked-title">Hoort bij</h2>
			<a class="row-link" href="/transacties/{t.id}">
				<span>
					{displayName(t.counterparty) || 'Zonder naam'}
					<span class="muted small"
						>{formatShortDate(t.date)}{t.source === 'bon' ? ' · uit deze bon' : ''}{t.status ===
						'te_controleren'
							? ' · te controleren'
							: ''}</span
					>
				</span>
				<span class="num">{txAmount(t)}</span>
			</a>
			<div class="buttons">
				{#if r.stage === 'nakijken'}
					<form method="POST" action="?/confirm" use:enhance={act('confirm', 'Nagekeken.')}>
						<button class="button" disabled={busy === 'confirm'}>Klopt</button>
					</form>
				{/if}
				<button type="button" class="button secondary" onclick={() => (relink = true)}
					>Andere koppeling</button
				>
			</div>
		</section>
	{/if}

	{#if (r.stage === 'fout' || r.stage === 'lijst') && !data.linked}
		<form
			method="POST"
			action="?/reread"
			class="again"
			use:enhance={act('reread', 'Wordt opnieuw gelezen.')}
		>
			<button class="button secondary" disabled={busy === 'reread'}>Opnieuw lezen</button>
		</form>
	{/if}

	{#if !reading}
		<div class="delete">
			{#if deleting}
				<p>Bon weggooien? De foto verdwijnt; een transactie die erbij hoort blijft staan.</p>
				<form
					method="POST"
					action="?/delete"
					class="buttons"
					use:enhance={act('delete', 'Weggegooid.')}
				>
					<button class="button danger" disabled={busy === 'delete'}>Weggooien</button>
					<button type="button" class="button secondary" onclick={() => (deleting = false)}
						>Annuleren</button
					>
				</form>
			{:else}
				<button type="button" class="text-button danger-text" onclick={() => (deleting = true)}
					>Bon weggooien</button
				>
			{/if}
		</div>
	{/if}

	{#if toast}
		{#key toast.key}<Toast text={toast.text} error={toast.error} />{/key}
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 44rem;
		container-type: inline-size;
	}

	header {
		display: grid;
		gap: 6px;
		justify-items: start;
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

	.small {
		font-size: 0.88rem;
	}

	.preview {
		display: grid;
		justify-items: center;
		gap: 4px;
		margin: 0;
		padding: 8px;
	}

	.preview img {
		max-width: 100%;
		max-height: 240px;
		border-radius: var(--radius-sm);
		object-fit: contain;
		background: var(--surface-2);
	}

	.preview.large img {
		max-height: none;
	}

	.form,
	.details,
	.section {
		display: grid;
		gap: 12px;
	}

	.pair {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 12px;
	}

	@container (min-width: 480px) {
		.pair {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.field > span,
	.field > label {
		font-weight: 550;
		font-size: 0.95rem;
	}

	.field input {
		width: 100%;
	}

	.currency {
		max-width: 7rem;
		text-transform: uppercase;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
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
		flex: none;
		color: var(--muted);
	}

	dd {
		display: grid;
		justify-items: end;
		gap: 2px;
		margin: 0;
		min-width: 0;
		text-align: right;
		font-weight: 550;
		overflow-wrap: anywhere;
	}

	.hint {
		font-weight: 400;
		font-size: 0.85rem;
	}

	/* Zekerheid per veld: groen zeker, oranje twijfel of niet gelezen */
	.conf {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--muted);
	}

	.mark {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--accent);
	}

	.conf.controleren .mark,
	.conf.onzeker .mark {
		background: var(--warn);
	}

	.conf.own .mark {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--accent);
	}

	.button.small {
		min-height: var(--tap);
		padding: 0 14px;
		font-size: 0.92rem;
	}

	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.match {
		display: grid;
		gap: 10px;
	}

	fieldset {
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
		overflow-wrap: anywhere;
	}

	.side {
		display: grid;
		justify-items: end;
		gap: 2px;
		white-space: nowrap;
	}

	.tag {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--muted);
	}

	.tag.waarschijnlijk {
		color: var(--accent-strong);
	}

	.row-link {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 48px;
		color: inherit;
		text-decoration: none;
	}

	.items {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.items > li + li {
		border-top: 1px solid var(--line);
	}

	.item {
		display: grid;
		gap: 6px;
		padding: 4px 0 8px;
	}

	.pick {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 52px;
		padding: 4px 6px;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.pick:has(input:checked) {
		background: var(--accent-soft);
	}

	.pick.off {
		cursor: default;
		color: var(--muted);
	}

	.pick input {
		flex: none;
		width: 20px;
		height: 20px;
		min-height: 0;
		margin: 0;
		accent-color: var(--accent);
	}

	.target {
		padding-left: 36px;
		min-width: 0;
	}

	.item .hint {
		display: flex;
		align-items: baseline;
		gap: 6px;
		margin: 0;
		padding-left: 36px;
		color: var(--muted);
	}

	.in {
		color: var(--accent-strong);
	}

	.skipped {
		color: var(--muted);
	}

	.row-link > span:first-child {
		display: grid;
		line-height: 1.3;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.again {
		justify-self: start;
	}

	.delete {
		display: grid;
		gap: 10px;
		justify-items: start;
		padding-top: 8px;
		border-top: 1px solid var(--line);
	}

	.text-button {
		min-height: var(--tap);
		padding: 0 4px;
		border: 0;
		background: none;
		color: var(--accent-strong);
		font-weight: 600;
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.text-button:active {
		transform: scale(0.96);
	}

	.danger-text {
		color: var(--danger);
	}

	/* Rustige laadstaat: grijze balken die zacht ademen (alleen opacity) */
	.bar {
		display: block;
		width: 7rem;
		height: 12px;
		border-radius: 999px;
		background: var(--line);
		animation: breathe 1.6s ease-in-out infinite alternate;
	}

	.amount-bar {
		width: 9rem;
		height: 2.2rem;
	}

	@keyframes breathe {
		from {
			opacity: 1;
		}
		to {
			opacity: 0.4;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.bar {
			animation: none;
		}
	}
</style>
