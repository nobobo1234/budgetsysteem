<script lang="ts">
	import { enhance } from '$app/forms';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatShortDate } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';

	let { data, form } = $props();
	let uploading = $state(false);
	let dragging = $state(false);
	let file = $state<{ name: string; size: number } | null>(null);
	// Storno's die je na de import weer losmaakte
	let undone = $state<string[]>([]);
	let fileInput: HTMLInputElement;
	const summary = $derived(form && 'summary' in form ? form.summary : null);

	const categoryOptions = $derived<SelectOption[]>(
		data.categories.map((c) => ({
			value: c.id,
			label: c.name,
			group: c.group,
			dot: groupColor(c.group)
		}))
	);

	const fullDate = (iso: string) => `${formatShortDate(iso)} ${iso.slice(0, 4)}`;
	const kb = (bytes: number) =>
		bytes < 1024 * 1024
			? `${Math.max(1, Math.round(bytes / 1024))} kB`
			: `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

	function picked() {
		const f = fileInput.files?.[0];
		file = f ? { name: f.name, size: f.size } : null;
	}

	function drop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (!e.dataTransfer?.files.length) return;
		fileInput.files = e.dataTransfer.files;
		picked();
	}
</script>

<svelte:head>
	<title>Import · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<h1>Importeren</h1>
		<p class="muted">
			Download in Mijn SNS je transacties als CAMT.053 (of CSV), of in Revolut een CSV-afschrift in
			het Nederlands met alle valuta, en kies het bestand hier. Dezelfde export twee keer importeren
			levert niets dubbel op.
		</p>
	</div>

	<form
		method="POST"
		action="?/upload"
		enctype="multipart/form-data"
		class="upload"
		use:enhance={() => {
			uploading = true;
			return async ({ update }) => {
				await update();
				uploading = false;
				file = null;
			};
		}}
	>
		<label
			class={['drop', dragging && 'dragging', file && 'chosen']}
			ondragover={(e) => {
				e.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			ondrop={drop}
		>
			<input
				bind:this={fileInput}
				class="visually-hidden"
				type="file"
				name="file"
				aria-label="Bankbestand"
				accept=".xml,.csv,application/xml,text/xml,text/csv"
				required
				onchange={picked}
			/>
			<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
				{#if file}
					<path
						d="M7 3h7l5 5v13H7z M14 3v5h5 M10 14.5l2 2 4-4.5"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linejoin="round"
						stroke-linecap="round"
					/>
				{:else}
					<path
						d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 15v4h14v-4"
						fill="none"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linejoin="round"
						stroke-linecap="round"
					/>
				{/if}
			</svg>
			{#if file}
				<span class="title">{file.name}</span>
				<span class="muted num">{kb(file.size)} · tik om een ander bestand te kiezen</span>
			{:else}
				<span class="title">Kies een bankbestand</span>
				<span class="muted"
					>Of sleep het hierheen. CAMT.053 (.xml) of CSV van SNS of Revolut, tot 20 MB.</span
				>
			{/if}
		</label>
		<label class="field">
			<span>Importeren vanaf <span class="muted">(optioneel)</span></span>
			<input type="date" name="from" />
			<span class="muted hint"
				>Het hele bestand wordt gelezen, maar alleen boekingen vanaf deze datum komen erin. Handig
				bij een Revolut-export vanaf het begin, voor de juiste wisselkoersen.</span
			>
		</label>
		<button class="button" disabled={uploading}
			>{uploading ? 'Bezig met importeren…' : 'Importeren'}</button
		>
		{#if form && 'message' in form && form.message}<p class="error-text" role="alert">
				{form.message}
			</p>{/if}
	</form>

	{#if summary}
		<section class="card result" role="status">
			<h2>Import klaar</h2>
			<dl>
				<div>
					<dt>Nieuw</dt>
					<dd class="num">{summary.newCount}</dd>
				</div>
				<div>
					<dt>Al bekend</dt>
					<dd class="num">{summary.duplicateCount}</dd>
				</div>
				{#if summary.earlierCount > 0}
					<div>
						<dt>Van vóór de begindatum</dt>
						<dd class="num">{summary.earlierCount}</dd>
					</div>
				{/if}
				{#if summary.periodStart && summary.periodEnd}
					<div class="period">
						<dt>Periode</dt>
						<dd>{fullDate(summary.periodStart)} tot {fullDate(summary.periodEnd)}</dd>
					</div>
				{/if}
			</dl>
			{#if summary.linkedCount > 0}
				<p>
					<a href="/terugbetalingen"
						>{summary.linkedCount}
						{summary.linkedCount === 1 ? 'terugbetaling' : 'terugbetalingen'} automatisch gekoppeld</a
					>; los te koppelen bij de transactie.
				</p>
			{/if}
			{#if form && 'proposals' in form && form.proposals}
				<p>
					<a href="/vaste-lasten"
						>{form.proposals}
						{form.proposals === 1 ? 'mogelijke vaste last' : 'mogelijke vaste lasten'} gevonden</a
					>; bevestig welke het zijn.
				</p>
			{/if}
			{#if summary.reversals.linked.length > 0}
				<div class="reversals">
					<p>
						{summary.reversals.linked.length === 1
							? 'Eén storno automatisch verrekend'
							: `${summary.reversals.linked.length} storno's automatisch verrekend`} met de boeking waar
						{summary.reversals.linked.length === 1 ? 'hij' : 'ze'} bij hoort, in die maand.
					</p>
					<ul>
						{#each summary.reversals.linked as r (r.id)}
							<li>
								<a href="/transacties/{r.id}">{r.counterparty || 'Zonder naam'}</a>
								<span class="num">{formatCents(r.amountCents, { sign: true })}</span>
								<span class="muted">bij {fullDate(r.originalDate)}</span>
								{#if undone.includes(r.id)}
									<span class="muted">Losgemaakt</span>
								{:else}
									<form
										method="POST"
										action="?/undoReversal"
										use:enhance={() =>
											async ({ result }) => {
												if (result.type === 'success') undone = [...undone, r.id];
											}}
									>
										<input type="hidden" name="id" value={r.id} />
										<button class="button secondary">Ongedaan maken</button>
									</form>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if summary.reversals.reviewCount > 0}
				<p>
					<a href="/transacties?status=te_controleren"
						>{summary.reversals.reviewCount}
						{summary.reversals.reviewCount === 1 ? 'storno' : "storno's"} te controleren</a
					>: kies bij welke boeking {summary.reversals.reviewCount === 1 ? 'hij' : 'ze'} horen.
				</p>
			{/if}
			{#each summary.anchors as anchor (anchor.accountName)}
				<p class="muted">
					Startsaldo {anchor.accountName}:
					<span class="num">{formatCents(anchor.amountCents)}</span>
					aan het eind van {fullDate(anchor.date)}. Daarmee vergelijkt de
					<a href="/saldocheck">saldocheck</a> je saldo.
				</p>
			{/each}
		</section>
	{/if}

	{#if data.repairable > 0}
		<form method="POST" action="?/repair" class="card repair" use:enhance>
			<h2>Pinbetalingen zonder naam</h2>
			<p class="muted">
				{data.repairable}
				{data.repairable === 1 ? 'pinbetaling' : 'pinbetalingen'} uit een eerdere import
				{data.repairable === 1 ? 'heeft' : 'hebben'} geen tegenpartij. De winkel staat wel in de omschrijving;
				die nemen we over als tegenpartij.
			</p>
			<button class="button secondary">Winkelnamen invullen</button>
		</form>
	{/if}

	{#if form && 'repaired' in form && form.repaired}
		{#key form}
			<Toast
				text="{form.repaired.updated} tegenpartijen ingevuld; {form.repaired
					.categorized} transacties kregen een categorie via je regels."
			/>
		{/key}
	{/if}

	{#if form && 'applied' in form}
		{#key form}
			<Toast
				text="Regel voor &quot;{form.pattern}&quot; gemaakt; {form.applied} {form.applied === 1
					? 'transactie'
					: 'transacties'} bijgewerkt."
			/>
		{/key}
	{/if}

	{#if data.uncategorized.length > 0}
		<section class="groups" aria-labelledby="uncat-title">
			<div class="intro">
				<h2 id="uncat-title">Nog zonder categorie</h2>
				<p class="muted">
					Kies een categorie en maak een regel: die geldt voor deze en alle volgende transacties van
					die tegenpartij.
				</p>
			</div>
			<ul>
				{#each data.uncategorized as g (g.pattern)}
					<li class="card">
						<div class="who">
							<strong>{g.example}</strong>
							<span class="muted num"
								>{g.count}× · {formatCents(g.totalCents, { whole: true })}</span
							>
						</div>
						<form method="POST" action="?/rule" use:enhance>
							<input type="hidden" name="pattern" value={g.pattern} />
							<Select
								name="categoryId"
								label="Categorie voor {g.example}"
								placeholder="Kies categorie"
								value={g.suggestedCategoryId ?? ''}
								options={categoryOptions}
								required
							/>
							<button class="button secondary">Regel maken</button>
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{:else if data.batches.length > 0}
		<p class="card done">Alle geïmporteerde transacties hebben een categorie.</p>
	{/if}

	{#if data.batches.length > 0}
		<section class="history" aria-labelledby="history-title">
			<h2 id="history-title">Eerdere imports</h2>
			<ul>
				{#each data.batches as b (b.id)}
					<li>
						<div>
							<strong>{fullDate(b.createdAt.slice(0, 10))}</strong>
							<span class="muted">
								{b.format === 'camt053' ? 'CAMT.053' : b.format === 'revolut' ? 'Revolut' : 'CSV'}
								{#if b.periodStart && b.periodEnd}
									· {fullDate(b.periodStart)} tot {fullDate(b.periodEnd)}{/if}
							</span>
						</div>
						<span class="num counts"
							>{b.newCount} nieuw<span class="muted"> · {b.duplicateCount} bekend</span></span
						>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

<style>
	.reversals {
		display: grid;
		gap: 6px;
	}

	.reversals ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 4px;
	}

	.reversals li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 10px;
		min-height: var(--tap);
	}

	.reversals form {
		margin-left: auto;
	}

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

	.upload {
		display: grid;
		gap: 12px;
	}

	.field {
		display: grid;
		gap: 6px;
		justify-items: start;
	}

	.field > span:first-child {
		font-weight: 550;
		font-size: 0.95rem;
	}

	.hint {
		font-size: 0.88rem;
	}

	.repair {
		display: grid;
		gap: 8px;
		justify-items: start;
	}

	.drop {
		display: grid;
		justify-items: center;
		gap: 4px;
		padding: 28px 20px;
		border: 1.5px dashed color-mix(in oklch, var(--text) 24%, transparent);
		border-radius: var(--radius);
		background: var(--surface);
		text-align: center;
		cursor: pointer;
		transition: transform 200ms var(--ease-spring);
	}

	.drop:hover {
		border-color: var(--accent);
	}

	.drop:focus-within {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	.drop.dragging {
		border-color: var(--accent);
		background: var(--accent-soft);
		transform: scale(1.01);
	}

	.drop.chosen {
		border-style: solid;
		border-color: var(--accent);
	}

	.icon {
		width: 32px;
		height: 32px;
		margin-bottom: 6px;
		color: var(--accent-strong);
	}

	.title {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.drop .muted {
		font-size: 0.92rem;
	}

	dl {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		margin: 14px 0 0;
	}

	.period {
		grid-column: 1 / -1;
	}

	.result p {
		margin-top: 12px;
	}

	dt {
		color: var(--muted);
		font-size: 0.92rem;
	}

	dd {
		margin: 0;
		font-weight: 600;
	}

	dd.num {
		font-size: 2rem;
		letter-spacing: -0.02em;
		line-height: 1.1;
	}

	.groups,
	.history {
		display: grid;
		gap: 14px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
	}

	.groups li {
		display: grid;
		gap: 10px;
	}

	.who {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
	}

	.who strong {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.groups form {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
	}

	.done {
		color: var(--accent-strong);
		font-weight: 550;
	}

	.history li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		padding: 10px 0;
		border-top: 1px solid var(--line);
	}

	.history li div {
		display: grid;
	}

	.history .muted {
		font-size: 0.92rem;
	}

	.counts {
		font-weight: 550;
	}
</style>
