<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import Select from '#lib/components/Select.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatShortDate, toIsoDate } from '#lib/dates.ts';
	import { splitEqually } from '#lib/owed.ts';
	import { centsToInput, formatCents, parseAmount } from '#lib/money.ts';
	import { enqueue, type QueuedTransaction } from '#lib/offline/queue.ts';
	import { MAX_INPUT, parseQuickEntry, type SpanKind } from '#lib/quickentry/parser.ts';
	import {
		resolveEntry,
		type AccountRef,
		type CategoryRef,
		type ResolveContext
	} from '#lib/quickentry/resolve.ts';

	let {
		context,
		onsaved,
		suggestions = []
	}: {
		context: Omit<ResolveContext, 'accounts' | 'categories'> & {
			accounts: readonly (AccountRef & { name: string })[];
			categories: readonly (CategoryRef & { group?: string })[];
		};
		onsaved: (item: QueuedTransaction) => void;
		/** Tegenpartijen die je vaak zelf invoert: chips onder een leeg veld */
		suggestions?: readonly string[];
	} = $props();

	let value = $state('');
	let eurInput = $state('');
	let categoryOverride = $state<string | null | undefined>(undefined);
	let accountOverride = $state<string | undefined>(undefined);
	let literalCounterparty = $state(false);
	// `voor 3` zonder (alle) namen: wie je erbij tikt
	let picked = $state<string[]>([]);
	// Gekozen koppeling (`post:<id>` of `retour:<id>`); undefined is de voorselectie
	let chosenLink = $state<string | null | undefined>(undefined);
	let saving = $state(false);
	let input: HTMLInputElement;
	let mirror: HTMLDivElement;
	// Tokens die je met het kruisje weer gewone tekst hebt gemaakt
	const plain = new SvelteSet<number>();

	const today = $derived(toIsoDate(new Date()));
	const aliases = $derived(context.accounts.map((a) => a.alias));
	const peopleNames = $derived((context.people ?? []).map((p) => p.name));
	const parsed = $derived(
		parseQuickEntry(value, today, { accountAliases: aliases, plain, people: peopleNames })
	);
	const draft = $derived(resolveEntry(parsed, context));

	// Delen: namen uit de tekst, aangevuld met wie je aantikt, nooit meer dan er plek is
	const sharing = $derived(draft.people > 1 && draft.amountCents !== null);
	const withNames = $derived(
		sharing
			? [...draft.sharedWith, ...picked.filter((n) => !draft.sharedWith.includes(n))].slice(
					0,
					draft.people - 1
				)
			: []
	);
	const openSeats = $derived(sharing ? draft.people - 1 - withNames.length : 0);
	const pickable = $derived(
		peopleNames.filter((n) => !draft.sharedWith.some((w) => w.toLowerCase() === n.toLowerCase()))
	);
	const shareLine = $derived.by(() => {
		if (!sharing || draft.amountCents === null) return [];
		const { others } = splitEqually(-draft.amountCents, draft.people);
		return others.map((cents, i) => ({ name: withNames[i] ?? null, cents }));
	});

	const preselectLink = $derived(
		draft.preselect
			? `post:${draft.preselect}`
			: draft.refundPreselect
				? `retour:${draft.refundPreselect}`
				: null
	);
	const link = $derived(chosenLink === undefined ? preselectLink : chosenLink);
	const post = $derived(link?.startsWith('post:') ? link.slice(5) : null);
	const linking = $derived(post !== null && draft.candidates.some((c) => c.id === post));
	const refundOf = $derived(
		link?.startsWith('retour:') ? draft.refunds.find((r) => `retour:${r.id}` === link) : undefined
	);
	const hasLinks = $derived(draft.candidates.length > 0 || draft.refunds.length > 0);
	const refundId = $derived(context.categories.find((c) => c.name === 'Terugbetaling')?.id ?? null);

	const categoryId = $derived(
		categoryOverride !== undefined
			? categoryOverride
			: refundOf
				? refundOf.categoryId
				: linking && parsed.direction === 'in' && !draft.categoryId
					? refundId
					: draft.categoryId
	);
	const accountId = $derived(accountOverride ?? draft.accountId);
	const counterparty = $derived(literalCounterparty ? parsed.text.trim() : draft.counterparty);
	const eurCents = $derived(eurInput.trim() ? parseAmount(eurInput.trim()) : null);

	const segments = $derived.by(() => {
		const out: { start: number; text: string; kind: SpanKind | null }[] = [];
		let pos = 0;
		for (const span of [...parsed.spans].sort((a, b) => a.start - b.start)) {
			if (span.start > pos)
				out.push({ start: pos, text: value.slice(pos, span.start), kind: null });
			out.push({ start: span.start, text: span.text, kind: span.kind });
			pos = span.end;
		}
		if (pos < value.length) out.push({ start: pos, text: value.slice(pos), kind: null });
		return out;
	});

	const categoryOptions = $derived([
		{ value: '', label: 'Geen categorie', dot: null },
		...context.categories.map((c) => ({
			value: c.id,
			label: c.name,
			group: c.group,
			dot: groupColor(c.group)
		}))
	]);
	const accountOptions = $derived(context.accounts.map((a) => ({ value: a.id, label: a.name })));

	const spanOf = (kind: SpanKind) => parsed.spans.find((s) => s.kind === kind);
	const canSave = $derived(parsed.amountCents !== null && accountId !== null && !saving);

	function reset() {
		value = '';
		eurInput = '';
		categoryOverride = undefined;
		accountOverride = undefined;
		literalCounterparty = false;
		picked = [];
		chosenLink = undefined;
		plain.clear();
	}

	function togglePick(name: string) {
		picked = picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name];
	}

	function makePlain(kind: SpanKind) {
		const span = spanOf(kind);
		if (span) plain.add(span.start);
		input.focus();
	}

	// Een suggestie zet de naam in het veld; daarna typ je alleen het bedrag
	function suggest(name: string) {
		value = `${name} `;
		input.focus();
		requestAnimationFrame(() => input.setSelectionRange(value.length, value.length));
	}

	function syncScroll() {
		if (mirror && input) mirror.scrollLeft = input.scrollLeft;
	}

	// Na opslaan is de knop even een vinkje (spec: Beweging), tegelijk met het opslaan
	let done = $state(false);
	let doneTimer: ReturnType<typeof setTimeout> | undefined;
	function flashDone() {
		done = true;
		clearTimeout(doneTimer);
		doneTimer = setTimeout(() => (done = false), 1200);
	}

	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (!canSave || parsed.amountCents === null || !accountId) return;
		saving = true;
		const outgoing = parsed.direction === 'uit';
		let amountCents = draft.amountCents ?? 0;
		if (draft.origCurrency === 'USD' && eurCents !== null)
			amountCents = outgoing ? -eurCents : eurCents;
		const item: QueuedTransaction = {
			id: crypto.randomUUID(),
			amountCents,
			date: parsed.date,
			counterparty: counterparty.slice(0, 100),
			description: draft.description.slice(0, 300),
			categoryId,
			accountId,
			origAmountCents: draft.origAmountCents,
			origCurrency: draft.origCurrency,
			note: '',
			share:
				draft.people > 1 && amountCents < 0
					? { people: draft.people, with: withNames.slice(0, 20) }
					: null,
			settle: linking && amountCents !== 0 && post ? { owedId: post } : null,
			correct: refundOf && amountCents > 0 ? { transactionId: refundOf.id } : null
		};
		try {
			await enqueue(item);
			dispatchEvent(new CustomEvent('invoer', { detail: 'snelinvoer' }));
			flashDone();
			onsaved(item);
			reset();
		} finally {
			saving = false;
			input.focus();
		}
	}

	const kindLabel: Record<SpanKind, string> = {
		bedrag: 'Bedrag',
		datum: 'Datum',
		categorie: 'Categorie',
		rekening: 'Rekening',
		delen: 'Delen',
		persoon: 'Persoon',
		retour: 'Retour'
	};

	const labelText = {
		waarschijnlijk: 'Waarschijnlijk',
		mogelijk: 'Mogelijk',
		onwaarschijnlijk: 'Onwaarschijnlijk'
	};
</script>

<form class="entry" onsubmit={save} autocomplete="off">
	<label for="quick" class="visually-hidden">Snel invoeren</label>
	<div class="field">
		<div class="mirror" bind:this={mirror} aria-hidden="true">
			{#each segments as seg (seg.start)}<span class={seg.kind ? `tok ${seg.kind}` : undefined}
					>{seg.text}</span
				>{/each}
		</div>
		<input
			id="quick"
			bind:this={input}
			bind:value
			oninput={syncScroll}
			onscroll={syncScroll}
			onkeyup={syncScroll}
			maxlength={MAX_INPUT}
			placeholder="12,50 ah"
			enterkeyhint="done"
			autocapitalize="off"
			autocorrect="off"
			spellcheck="false"
			aria-describedby="quick-chips"
		/>
		<button
			class={['button', 'save', done && 'done']}
			disabled={!canSave && !done}
			aria-label="Opslaan"
		>
			<span class="label">Opslaan</span>
			<svg class="tick" viewBox="0 0 24 24" aria-hidden="true"
				><path d="M5.5 12.5l4.5 4.5 8.5-9.5" /></svg
			>
		</button>
		<span class="visually-hidden" role="status">{done ? 'Opgeslagen' : ''}</span>
	</div>

	<div id="quick-chips" class="chips" aria-live="polite">
		{#if value === '' && suggestions.length > 0}
			<span class="visually-hidden">Vaak ingevoerd:</span>
			{#each suggestions as name, i (name)}
				<button
					type="button"
					class="chip suggestion"
					style:--i={i}
					aria-label="{name} invoeren"
					onclick={() => suggest(name)}>{name}</button
				>
			{/each}
		{/if}
		{#if parsed.amountCents !== null}
			<span class="chip bedrag">
				<span class="visually-hidden">{kindLabel.bedrag}:</span>
				<span class="num"
					>{parsed.direction === 'in' ? '+' : ''}{parsed.currency === 'USD'
						? `$${centsToInput(parsed.amountCents)}`
						: formatCents(parsed.amountCents)}</span
				>
				<button
					type="button"
					class="x"
					aria-label="Bedrag weer tekst maken"
					onclick={() => makePlain('bedrag')}>×</button
				>
			</span>
		{/if}

		{#if counterparty && !parsed.person}
			<button
				type="button"
				class="chip naam"
				title={literalCounterparty ? 'Gebruik bekende naam' : 'Gebruik precies wat je typte'}
				onclick={() => (literalCounterparty = !literalCounterparty)}
			>
				{counterparty}
			</button>
		{/if}

		{#if parsed.amountCents !== null || parsed.category}
			<span class="chip categorie">
				<Select
					variant="chip"
					label="Categorie"
					value={categoryId ?? ''}
					options={categoryOptions}
					onchange={(v) => (categoryOverride = v || null)}
				/>
			</span>

			<span class="chip rekening">
				<Select
					variant="chip"
					label="Rekening"
					value={accountId ?? ''}
					options={accountOptions}
					onchange={(v) => (accountOverride = v)}
				/>
			</span>
		{/if}

		{#if parsed.person}
			<span class="chip persoon">
				<span class="visually-hidden">{kindLabel.persoon}:</span>
				{parsed.person}
				<button
					type="button"
					class="x"
					aria-label="Persoon weer tekst maken"
					onclick={() => makePlain('persoon')}>×</button
				>
			</span>
		{/if}

		{#if parsed.refund}
			<span class="chip retour">
				Retour
				<button
					type="button"
					class="x"
					aria-label="Retour weer tekst maken"
					onclick={() => makePlain('retour')}>×</button
				>
			</span>
		{/if}

		{#if parsed.dateExplicit}
			<span class="chip datum">
				{formatShortDate(parsed.date)}
				<button
					type="button"
					class="x"
					aria-label="Datum weer tekst maken"
					onclick={() => makePlain('datum')}>×</button
				>
			</span>
		{/if}

		{#if sharing && draft.myShareCents !== null}
			<span class="chip delen">
				Jouw deel <span class="num">{formatCents(-draft.myShareCents)}</span>
				{#if withNames.length}· met {withNames.join(', ')}{:else}· {draft.people} personen{/if}
				<button type="button" class="x" aria-label="Niet delen" onclick={() => makePlain('delen')}
					>×</button
				>
			</span>
		{/if}
	</div>

	{#if sharing}
		<div class="share" role="group" aria-label="Voorgeschoten">
			<p class="share-line">
				{#each shareLine as s, i (i)}
					<span>
						{s.name ?? 'Nog onbekend'} <span class="num">{formatCents(s.cents)}</span>
					</span>
				{/each}
			</p>
			{#if openSeats > 0 || picked.length > 0}
				<div class="who">
					<span class="muted"
						>{openSeats > 0
							? `Wie nog meer? ${openSeats === 1 ? 'Eén plek' : `${openSeats} plekken`} over`
							: 'Met'}</span
					>
					{#each pickable as name (name)}
						{@const on = picked.includes(name)}
						<button
							type="button"
							class="pick"
							aria-pressed={on}
							disabled={!on && openSeats === 0}
							onclick={() => togglePick(name)}>{name}</button
						>
					{/each}
					{#if pickable.length === 0}
						<span class="muted">Typ <strong>met sanne</strong>, of kies later bij Te krijgen.</span>
					{/if}
				</div>
			{/if}
		</div>
	{/if}

	{#if hasLinks}
		<fieldset class="match">
			<legend>
				{draft.candidates.length === 0
					? 'Retour van'
					: draft.refunds.length > 0
						? 'Koppelen aan'
						: parsed.direction === 'in'
							? 'Ontvangen voor'
							: 'Terugbetaald voor'}
			</legend>
			{#each draft.candidates as c (c.id)}
				<label class="option">
					<input
						type="radio"
						name="quick-post"
						value={`post:${c.id}`}
						checked={link === `post:${c.id}`}
						onchange={() => (chosenLink = `post:${c.id}`)}
					/>
					<span class="who-what">
						<strong>{c.personName}</strong>
						<span class="muted">{c.description || 'Post'} · {formatShortDate(c.date)}</span>
					</span>
					<span class="side">
						<span class="num">{formatCents(c.outstandingCents)}</span>
						<span class={['tag', c.label]}>{labelText[c.label]}</span>
					</span>
				</label>
			{/each}
			{#each draft.refunds as r (r.id)}
				<label class="option">
					<input
						type="radio"
						name="quick-post"
						value={`retour:${r.id}`}
						checked={link === `retour:${r.id}`}
						onchange={() => (chosenLink = `retour:${r.id}`)}
					/>
					<span class="who-what">
						<strong>{r.counterparty}</strong>
						<span class="muted">Uitgave · {formatShortDate(r.date)}</span>
					</span>
					<span class="side">
						<span class="num">{formatCents(r.amountCents)}</span>
						<span class={['tag', r.label]}>{labelText[r.label]}</span>
					</span>
				</label>
			{/each}
			<label class="option">
				<input
					type="radio"
					name="quick-post"
					value=""
					checked={!linking && !refundOf}
					onchange={() => (chosenLink = null)}
				/>
				<span class="who-what"><strong>Niet koppelen</strong></span>
			</label>
		</fieldset>
	{/if}

	{#if draft.origCurrency === 'USD'}
		<label class="eur">
			<span>Eurobedrag dat Revolut afschreef</span>
			<input
				bind:value={eurInput}
				inputmode="decimal"
				placeholder="Later invullen"
				aria-invalid={eurInput.trim() !== '' && eurCents === null}
			/>
		</label>
	{/if}
</form>

<style>
	.entry {
		display: grid;
		gap: 10px;
	}

	.field {
		position: relative;
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 8px;
		align-items: center;
	}

	input#quick,
	.mirror {
		grid-column: 1;
		grid-row: 1;
		height: 56px;
		padding: 0 16px;
		font-size: 1.25rem;
		letter-spacing: normal;
		white-space: pre;
		line-height: 56px;
	}

	input#quick {
		border-radius: var(--radius);
		border: 1px solid var(--line);
		background: transparent;
		color: transparent;
		caret-color: var(--text);
		position: relative;
		z-index: 1;
	}

	input#quick::placeholder {
		color: var(--muted);
	}

	input#quick::selection {
		color: transparent;
		background: var(--accent-soft);
	}

	.mirror {
		overflow: hidden;
		border-radius: var(--radius);
		background: var(--surface);
		border: 1px solid transparent;
		color: var(--text);
	}

	.tok {
		border-radius: 6px;
		box-shadow: 0 0 0 2px var(--chip-bg);
		background: var(--chip-bg);
	}

	.bedrag {
		--chip-bg: var(--chip-bedrag);
	}
	.datum {
		--chip-bg: var(--chip-datum);
	}
	.categorie {
		--chip-bg: var(--chip-categorie);
	}
	.rekening {
		--chip-bg: var(--chip-rekening);
	}
	.delen {
		--chip-bg: var(--chip-delen);
	}
	.persoon {
		--chip-bg: var(--chip-persoon);
	}
	.retour {
		--chip-bg: var(--chip-retour);
	}
	.naam {
		--chip-bg: var(--surface-2);
	}

	.save {
		position: relative;
		height: 56px;
		padding: 0 20px;
		transition: transform 160ms var(--ease-spring);
	}

	/* Uit: rustig en scherp, geen troebele doorschijnende accentkleur */
	.save[disabled] {
		opacity: 1;
		background: var(--surface-2);
		color: var(--muted);
		box-shadow: inset 0 0 0 1px var(--line);
	}

	.save .label,
	.save .tick {
		transition:
			opacity 160ms var(--ease-out),
			transform 260ms var(--ease-spring);
	}

	.save .tick {
		position: absolute;
		inset: 0;
		margin: auto;
		width: 26px;
		height: 26px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.6;
		stroke-linecap: round;
		stroke-linejoin: round;
		opacity: 0;
		transform: scale(0.4);
	}

	.save.done {
		background: var(--accent);
		color: var(--on-accent);
		box-shadow: none;
	}

	.save.done .label {
		opacity: 0;
		transform: scale(0.8);
	}

	.save.done .tick {
		opacity: 1;
		transform: scale(1);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		min-height: var(--tap);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: var(--tap);
		padding: 0 4px 0 12px;
		border: 0;
		border-radius: 999px;
		background: var(--chip-bg);
		font-size: 0.95rem;
		animation: chip-in 160ms var(--ease-out);
	}

	.suggestion {
		max-width: 14rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border: 1px dashed var(--line);
		background: transparent;
		color: var(--muted);
		animation-delay: calc(var(--i) * 40ms);
		animation-fill-mode: both;
		transition: transform 160ms var(--ease-spring);
	}

	.suggestion:active {
		transform: scale(0.95);
	}

	button.chip {
		padding-right: 12px;
		cursor: pointer;
	}

	.x {
		display: inline-grid;
		place-items: center;
		width: var(--tap);
		height: var(--tap);
		border: 0;
		border-radius: 999px;
		background: transparent;
		font-size: 1.1rem;
		cursor: pointer;
	}

	.share {
		display: grid;
		gap: 8px;
		font-size: 0.95rem;
	}

	.share-line {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
	}

	.who {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.pick {
		min-height: var(--tap);
		padding: 0 14px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--surface);
		font-weight: 550;
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.pick:active {
		transform: scale(0.96);
	}

	.pick[aria-pressed='true'] {
		border-color: transparent;
		background: var(--chip-delen);
	}

	.pick:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.match {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 12px;
		border: 0;
		border-radius: var(--radius);
		background: var(--surface);
		animation: chip-in 160ms var(--ease-out);
	}

	.match legend {
		float: left;
		width: 100%;
		margin-bottom: 4px;
		padding: 0;
		font-weight: 600;
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

	.who-what .muted {
		font-size: 0.88rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

	.eur {
		display: grid;
		gap: 4px;
		font-size: 0.95rem;
	}

	@keyframes chip-in {
		from {
			opacity: 0;
			transform: translateY(4px) scale(0.96);
		}
	}
</style>
