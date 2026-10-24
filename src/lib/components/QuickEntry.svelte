<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { formatShortDate, toIsoDate } from '#lib/dates.ts';
	import { centsToInput, formatCents, parseAmount } from '#lib/money.ts';
	import { enqueue, type QueuedTransaction } from '#lib/offline/queue.ts';
	import { MAX_INPUT, parseQuickEntry, type SpanKind } from '#lib/quickentry/parser.ts';
	import { resolveEntry, type ResolveContext } from '#lib/quickentry/resolve.ts';

	let {
		context,
		onsaved
	}: {
		context: ResolveContext & {
			accounts: (ResolveContext['accounts'][number] & { name: string })[];
		};
		onsaved: (item: QueuedTransaction) => void;
	} = $props();

	let value = $state('');
	let eurInput = $state('');
	let categoryOverride = $state<string | null | undefined>(undefined);
	let accountOverride = $state<string | undefined>(undefined);
	let literalCounterparty = $state(false);
	let saving = $state(false);
	let input: HTMLInputElement;
	let mirror: HTMLDivElement;
	// Tokens die je met het kruisje weer gewone tekst hebt gemaakt
	const plain = new SvelteSet<number>();

	const today = $derived(toIsoDate(new Date()));
	const aliases = $derived(context.accounts.map((a) => a.alias));
	const parsed = $derived(parseQuickEntry(value, today, { accountAliases: aliases, plain }));
	const draft = $derived(resolveEntry(parsed, context));

	const categoryId = $derived(categoryOverride !== undefined ? categoryOverride : draft.categoryId);
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

	const spanOf = (kind: SpanKind) => parsed.spans.find((s) => s.kind === kind);
	const canSave = $derived(parsed.amountCents !== null && accountId !== null && !saving);

	function reset() {
		value = '';
		eurInput = '';
		categoryOverride = undefined;
		accountOverride = undefined;
		literalCounterparty = false;
		plain.clear();
	}

	function makePlain(kind: SpanKind) {
		const span = spanOf(kind);
		if (span) plain.add(span.start);
		input.focus();
	}

	function syncScroll() {
		if (mirror && input) mirror.scrollLeft = input.scrollLeft;
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
			description: '',
			categoryId,
			accountId,
			origAmountCents: draft.origAmountCents,
			origCurrency: draft.origCurrency,
			note: '',
			share:
				draft.people > 1 && amountCents < 0
					? { people: draft.people, with: draft.sharedWith.slice(0, 20) }
					: null
		};
		try {
			await enqueue(item);
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
		delen: 'Delen'
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
		<button class="button save" disabled={!canSave} aria-label="Opslaan">Opslaan</button>
	</div>

	<div id="quick-chips" class="chips" aria-live="polite">
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

		{#if counterparty}
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
			<label class="chip categorie">
				<span class="visually-hidden">Categorie</span>
				<select
					value={categoryId ?? ''}
					onchange={(e) => (categoryOverride = e.currentTarget.value || null)}
				>
					<option value="">Geen categorie</option>
					{#each context.categories as c (c.id)}
						<option value={c.id}>{c.name}</option>
					{/each}
				</select>
			</label>

			<label class="chip rekening">
				<span class="visually-hidden">Rekening</span>
				<select value={accountId ?? ''} onchange={(e) => (accountOverride = e.currentTarget.value)}>
					{#each context.accounts as a (a.id)}
						<option value={a.id}>{a.name}</option>
					{/each}
				</select>
			</label>
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

		{#if draft.people > 1 && draft.myShareCents !== null}
			<span class="chip delen">
				Jouw deel <span class="num">{formatCents(-draft.myShareCents)}</span>
				{#if draft.sharedWith.length}· met {draft.sharedWith.join(', ')}{:else}· {draft.people} personen{/if}
				<button type="button" class="x" aria-label="Niet delen" onclick={() => makePlain('delen')}
					>×</button
				>
			</span>
		{/if}
	</div>

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
	.naam {
		--chip-bg: var(--surface-2);
	}

	.save {
		height: 56px;
		padding: 0 20px;
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

	button.chip {
		padding-right: 12px;
		cursor: pointer;
	}

	.chip select {
		min-height: var(--tap);
		border: 0;
		background: transparent;
		padding: 0 8px 0 0;
		font-size: 0.95rem;
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
