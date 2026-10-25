<script lang="ts">
	import * as icons from '#lib/icons-extra.ts';
	import { enhance } from '$app/forms';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import Tile from '#lib/components/Tile.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatShortDate } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';
	import { monthsBetween } from '#lib/recurring.ts';
	import { displayName } from '#lib/text.ts';

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
	const categoryName = (id: string) => data.categories.find((c) => c.id === id);
	// Voorgestelde categorieën als chips: het voorstel, dan wat je het vaakst gebruikt
	const chipsFor = (g: { suggestedCategoryId: string | null; totalCents: number }) =>
		[
			...new Set([
				...(g.suggestedCategoryId ? [g.suggestedCategoryId] : []),
				...(g.totalCents < 0 ? data.topCategories : [])
			])
		]
			.map(categoryName)
			.filter((c) => !!c)
			.slice(0, 3);

	// De periode van de import als tijdlijn, met een streepje per maand
	const timeline = $derived.by(() => {
		if (!summary?.periodStart || !summary.periodEnd) return null;
		const start = summary.periodStart.slice(0, 7);
		const months = monthsBetween(start, summary.periodEnd.slice(0, 7)) + 1;
		return {
			months,
			ticks: Array.from({ length: Math.max(0, months - 1) }, (_, i) => (i + 1) / months)
		};
	});
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
			<dl class="counters">
				<div>
					<dt>Nieuw</dt>
					<dd class="num">
						<span class="visually-hidden">{summary.newCount}</span><span
							class="count-up"
							style:--to={summary.newCount}
							aria-hidden="true"
						></span>
					</dd>
				</div>
				<div>
					<dt>Al bekend</dt>
					<dd class="num">
						<span class="visually-hidden">{summary.duplicateCount}</span><span
							class="count-up"
							style:--to={summary.duplicateCount}
							style:--delay="120ms"
							aria-hidden="true"
						></span>
					</dd>
				</div>
				{#if summary.earlierCount > 0}
					<div>
						<dt>Van vóór de begindatum</dt>
						<dd class="num">
							<span class="visually-hidden">{summary.earlierCount}</span><span
								class="count-up"
								style:--to={summary.earlierCount}
								style:--delay="240ms"
								aria-hidden="true"
							></span>
						</dd>
					</div>
				{/if}
			</dl>
			{#if summary.periodStart && summary.periodEnd && timeline}
				<div class="timeline">
					<p class="tell">
						{timeline.months === 1 ? 'Eén maand' : `${timeline.months} maanden`} historie
					</p>
					<div class="track" aria-hidden="true">
						<span class="fill"></span>
						{#each timeline.ticks as t (t)}<span class="tick" style:--at={t}></span>{/each}
					</div>
					<p class="ends muted num">
						<span>{fullDate(summary.periodStart)}</span>
						<span>{fullDate(summary.periodEnd)}</span>
					</p>
				</div>
			{/if}
			<ul class="found">
				{#if form && 'proposals' in form && form.proposals}
					<li>
						<Tile
							href="/vaste-lasten"
							icon={icons.vasteLasten}
							title={form.proposals === 1
								? '1 vaste last gevonden'
								: `${form.proposals} vaste lasten gevonden`}
							value={form.proposals === 1 ? 'Bevestig of hij het is' : 'Bevestig welke het zijn'}
						/>
					</li>
				{/if}
				{#if summary.linkedCount > 0}
					<li>
						<Tile
							href="/terugbetalingen"
							icon={icons.terugbetalingen}
							title={summary.linkedCount === 1
								? '1 terugbetaling gekoppeld'
								: `${summary.linkedCount} terugbetalingen gekoppeld`}
							value="Automatisch; los te koppelen bij de transactie"
						/>
					</li>
				{/if}
				{#if summary.reversals.reviewCount > 0}
					<li>
						<Tile
							href="/te-controleren"
							icon={icons.controleren}
							title={summary.reversals.reviewCount === 1
								? '1 storno te controleren'
								: `${summary.reversals.reviewCount} storno's te controleren`}
							value="Kies bij welke boeking hij hoort"
							warn
						/>
					</li>
				{/if}
			</ul>
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
								<a class="reversal" href="/transacties/{r.id}">
									<span class="rname">{displayName(r.counterparty) || 'Zonder naam'}</span>
									<span class="num">{formatCents(r.amountCents, { sign: true })}</span>
									<span class="muted">bij {fullDate(r.originalDate)}</span>
								</a>
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
					{@const chips = chipsFor(g)}
					<li class="card">
						<div class="who">
							<strong>{displayName(g.example)}</strong>
							<span class="muted num"
								>{g.count}× · {formatCents(g.totalCents, {
									whole: true
								})}{#if displayName(g.example) !== g.example}
									· {g.example}{/if}</span
							>
						</div>
						{#if chips.length > 0}
							<form method="POST" action="?/rule" use:enhance class="chips">
								<input type="hidden" name="pattern" value={g.pattern} />
								<span class="visually-hidden">Voorgesteld voor {g.example}:</span>
								{#each chips as c (c.id)}
									<button
										class={['chip', c.id === g.suggestedCategoryId && 'suggested']}
										name="categoryId"
										value={c.id}
										style:--dot={groupColor(c.group)}
										aria-label="Regel: {g.example} wordt {c.name}"
									>
										<span class="dot" aria-hidden="true"></span>{c.name}
									</button>
								{/each}
							</form>
						{/if}
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
		<div class="card">
			<EmptyState
				icon={icons.categorieen}
				text="Alle geïmporteerde transacties hebben een categorie."
				compact
			/>
		</div>
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

	.reversal {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 10px;
		min-height: var(--tap);
		color: inherit;
		text-decoration: none;
	}

	.reversal .rname {
		font-weight: 550;
	}

	.result {
		display: grid;
		gap: 16px;
	}

	.counters {
		margin: 0;
	}

	.timeline {
		display: grid;
		gap: 6px;
	}

	.track {
		position: relative;
		height: 12px;
		border-radius: 999px;
		background: var(--surface-2);
		overflow: hidden;
	}

	.fill {
		position: absolute;
		inset: 0;
		border-radius: 999px;
		background: var(--accent);
		transform-origin: left;
		animation: grow 900ms var(--ease-out) 200ms both;
	}

	.tick {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: 2px;
		background: var(--surface);
		opacity: 0.7;
		transform: translateX(calc(var(--at) * 100cqw));
	}

	.timeline {
		container-type: inline-size;
	}

	.ends {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-size: 0.88rem;
	}

	@keyframes grow {
		from {
			transform: scaleX(0);
		}
	}

	.found {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
		gap: 10px;
	}

	.found:empty {
		display: none;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 36px;
		padding: 0 14px 0 10px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--surface);
		color: var(--text);
		font-weight: 550;
		font-size: 0.92rem;
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.chip:active {
		transform: scale(0.95);
	}

	.chip.suggested {
		border-color: color-mix(in oklch, var(--accent) 50%, transparent);
		background: var(--accent-soft);
	}

	.chip .dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--dot);
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

	.groups form.chips {
		display: flex;
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
