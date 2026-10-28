<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import * as icons from '#lib/icons.ts';
	import AnalysesTabs from '#lib/components/AnalysesTabs.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import HeroAmount from '#lib/components/HeroAmount.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { formatCents } from '#lib/money.ts';
	import { OUTCOME_LABEL, type QuestionResult } from '#lib/question.ts';
	import { EXAMPLE_QUESTIONS, MAX_QUESTION_CHARS } from '#lib/semantic/format.ts';

	// Vraag (spec: Vraagveld, Schermen): je vraag gaat naar Haiku, dat hem vertaalt naar het
	// vraagformaat; het getal of de lijst en de zin erbij komen uit code. Alles staat als gewone
	// tekst in beeld: geen HTML, markdown, links of afbeeldingen uit het model.

	let { data } = $props();

	let text = $state('');
	let result = $state<QuestionResult | null>(null);
	let busy = $state<string | null>(null);
	let askForm = $state<HTMLFormElement>();
	let toast = $state<{ text: string; error: boolean; key: number } | null>(null);
	const notify = (message: string, error = false) =>
		(toast = { text: message, error, key: Date.now() });

	const submit =
		(key: string, done?: string): SubmitFunction =>
		() => {
			busy = key;
			return async ({ result: r, update }) => {
				busy = null;
				if (r.type === 'success') {
					const d = r.data as { result?: QuestionResult; wrong?: string } | undefined;
					if (d?.result) result = d.result;
					if (d?.wrong && result?.kind === 'beantwoord' && result.id === d.wrong)
						result = { ...result, wrong: true };
					if (done) notify(done);
					await update({ reset: false, invalidateAll: true });
					return;
				}
				const message = r.type === 'failure' ? r.data?.message : undefined;
				notify(
					typeof message === 'string' ? message : 'Dat lukte niet. Probeer het opnieuw.',
					true
				);
			};
		};

	/** Een voorbeeld of een vraag die wel kan: in het veld zetten en meteen vragen. */
	function ask(question: string) {
		text = question;
		queueMicrotask(() => askForm?.requestSubmit());
	}

	const amount = (cents: number) => formatCents(cents);
	const rowMax = $derived(
		result?.kind === 'beantwoord'
			? Math.max(1, ...(result.answer.rows ?? []).map((r) => Math.abs(r.value)))
			: 1
	);
	const thinking = $derived(busy === 'ask' || busy === 'choose');
</script>

<svelte:head>
	<title>Vraag · Analyses · Budget</title>
</svelte:head>

<div class="page">
	<div class="head">
		<h1>Analyses</h1>
		<AnalysesTabs current="vraag" />
	</div>

	{#if data.unavailable}
		<EmptyState
			icon={icons.analyses}
			text={data.unavailable === 'budget'
				? 'Het AI-budget van deze maand is op. Vanaf de eerste van de volgende maand kun je weer vragen stellen; je eerdere antwoorden reken ik wel opnieuw uit.'
				: 'Het vraagveld is nog niet ingesteld: er is geen sleutel voor Claude. Je eerdere antwoorden reken ik wel opnieuw uit.'}
		>
			<a class="more-link" href="/instellingen/status">Status</a>
		</EmptyState>
	{:else}
		<form
			class="card ask"
			method="POST"
			action="?/ask"
			bind:this={askForm}
			use:enhance={submit('ask')}
		>
			<label for="vraag">Wat wil je weten?</label>
			<div class="field">
				<input
					id="vraag"
					name="vraag"
					type="text"
					bind:value={text}
					maxlength={MAX_QUESTION_CHARS}
					autocomplete="off"
					enterkeyhint="send"
					placeholder="Hoeveel gaf ik dit jaar uit aan uit eten?"
				/>
				<button class="button" disabled={busy !== null || text.trim() === ''}>Vragen</button>
			</div>
			<ul class="chips" aria-label="Voorbeeldvragen">
				{#each EXAMPLE_QUESTIONS as example (example)}
					<li>
						<button type="button" class="chip" disabled={busy !== null} onclick={() => ask(example)}
							>{example}</button
						>
					</li>
				{/each}
			</ul>
		</form>
	{/if}

	<div class="result" aria-live="polite">
		{#if thinking}
			<section class="card waiting" aria-busy="true" aria-label="Antwoord">
				<p class="muted">Haiku vertaalt je vraag; daarna rekent de app.</p>
				<span class="line" aria-hidden="true"></span>
				<span class="line short" aria-hidden="true"></span>
			</section>
		{:else if result?.kind === 'beantwoord'}
			{@const a = result.answer}
			<section class="card answer" aria-labelledby="answer-title">
				<h2 id="answer-title" class="visually-hidden">Antwoord</h2>
				{#if a.rows === null}
					{#if a.unit === 'cent'}
						<HeroAmount cents={a.value} label={result.question} />
					{:else}
						<div class="count">
							<p class="muted">{result.question}</p>
							<p class="big num">{a.value}</p>
						</div>
					{/if}
				{:else}
					<p class="muted">{result.question}</p>
				{/if}
				<p class="sentence">{a.sentence}</p>

				{#if a.rows !== null}
					{#if a.rows.length === 0}
						<p class="muted">Geen rijen in deze periode.</p>
					{:else}
						<ol class="rows">
							{#each a.rows as row (row.key)}
								<li>
									<span class="label">{row.label}</span>
									<span class="num amount">{a.unit === 'cent' ? amount(row.value) : row.value}</span
									>
									<span class="meter" aria-hidden="true">
										<span
											class={['fill', row.value < 0 && 'negative']}
											style:--len={Math.abs(row.value) / rowMax}
										></span>
									</span>
								</li>
							{/each}
						</ol>
						{#if a.rowCount > a.rows.length}
							<p class="muted note">
								Nog {a.rowCount - a.rows.length} rijen niet getoond.
							</p>
						{/if}
					{/if}
				{/if}

				{#if a.assumptions.length > 0}
					<div class="assumptions">
						<h3>Aannames</h3>
						<ul>
							{#each a.assumptions as line, i (i)}<li>{line}</li>{/each}
						</ul>
					</div>
				{/if}

				<details>
					<summary>Gegenereerde vraag</summary>
					<ul class="query">
						{#each a.query as line, i (i)}<li>{line}</li>{/each}
					</ul>
				</details>

				<div class="foot">
					<p class="muted note">Uitgerekend door de app; Haiku vertaalde alleen je vraag.</p>
					{#if result.wrong}
						<span class="flag marked">Gemeld als niet kloppend</span>
					{:else}
						<form
							method="POST"
							action="?/wrong"
							use:enhance={submit('wrong', 'Gemeld: dit antwoord klopt niet.')}
						>
							<input type="hidden" name="id" value={result.id} />
							<button class="button secondary" disabled={busy !== null}>Klopt niet</button>
						</form>
					{/if}
				</div>
			</section>
		{:else if result?.kind === 'verduidelijken'}
			<section class="card answer" aria-labelledby="clarify-title">
				<p class="muted">{result.question}</p>
				<h2 id="clarify-title" class="tell">{result.clarification.text}</h2>
				<ul class="chips" aria-label="Keuzes">
					{#each result.clarification.choices as choice, i (i)}
						<li>
							<form method="POST" action="?/choose" use:enhance={submit('choose')}>
								<input type="hidden" name="id" value={result.id} />
								<input type="hidden" name="keuze" value={i} />
								<button class="chip" disabled={busy !== null}>{choice}</button>
							</form>
						</li>
					{/each}
				</ul>
			</section>
		{:else if result?.kind === 'kan_niet'}
			{@const example = result.example}
			<section class="card answer" aria-labelledby="refused-title">
				<p class="muted">{result.question}</p>
				<h2 id="refused-title" class="tell">Dit kan ik niet uitrekenen.</h2>
				<p>{result.reason}</p>
				{#if !data.unavailable}
					<p class="muted">Dit kan wel:</p>
					<button type="button" class="chip" disabled={busy !== null} onclick={() => ask(example)}
						>{example}</button
					>
				{/if}
			</section>
		{/if}
	</div>

	{#if data.history.length > 0}
		<section class="card" aria-labelledby="history-title">
			<h2 id="history-title">Eerdere vragen</h2>
			<ul class="history">
				{#each data.history as item (item.id)}
					<li>
						<form method="POST" action="?/again" use:enhance={submit('again')}>
							<input type="hidden" name="id" value={item.id} />
							<button class="again" disabled={busy !== null}>
								<span class="question">{item.question}</span>
								<span class="muted kind">{OUTCOME_LABEL[item.kind]}</span>
								{#if item.assumptions.length > 0}
									<span class="muted small">{item.assumptions.join('; ')}</span>
								{/if}
							</button>
						</form>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

{#if toast}
	{#key toast.key}<Toast text={toast.text} error={toast.error} />{/key}
{/if}

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 56rem;
	}

	.head {
		display: grid;
		gap: 12px;
	}

	.card {
		display: grid;
		/* Anders maakt WebKit de kolom zo breed als het veld met de knop en de chips */
		grid-template-columns: minmax(0, 1fr);
		gap: 14px;
		min-width: 0;
	}

	section h2 {
		font-size: 1.3rem;
	}

	.ask label {
		font-weight: 600;
	}

	.field {
		display: flex;
		gap: 8px;
	}

	.field input {
		flex: 1;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.chip {
		max-width: 100%;
		min-height: var(--tap);
		padding: 6px 14px;
		border: 0;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text);
		text-align: start;
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.chip:active {
		transform: scale(0.96);
	}

	.chip[disabled] {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.result:empty {
		display: none;
	}

	.waiting .line {
		display: block;
		height: 12px;
		border-radius: 999px;
		background: var(--surface-2);
		animation: pulse 1.2s var(--ease-out) infinite alternate;
	}

	.waiting .line.short {
		width: 60%;
	}

	@keyframes pulse {
		to {
			opacity: 0.5;
		}
	}

	.count {
		display: grid;
		gap: 4px;
	}

	.big {
		font-size: clamp(3.25rem, 16vw, 5.5rem);
		font-weight: 650;
		letter-spacing: -0.035em;
		line-height: 1;
	}

	.sentence {
		font-weight: 550;
		overflow-wrap: anywhere;
	}

	.rows {
		display: grid;
		gap: 14px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.rows li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: baseline;
		gap: 6px 12px;
	}

	.label {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.amount {
		font-weight: 600;
		white-space: nowrap;
	}

	.meter {
		grid-column: 1 / -1;
		position: relative;
		height: 6px;
		border-radius: 999px;
		overflow: hidden;
		background: var(--surface-2);
	}

	.fill {
		position: absolute;
		inset: 0;
		background: var(--accent);
		transform-origin: left center;
		transform: scaleX(var(--len));
		transition: transform 700ms var(--ease-spring);
	}

	.fill.negative {
		background: var(--muted);
	}

	@starting-style {
		.fill {
			transform: scaleX(0);
		}
	}

	.assumptions {
		display: grid;
		gap: 6px;
	}

	.assumptions h3 {
		font-size: 1rem;
	}

	.assumptions ul,
	.query {
		display: grid;
		gap: 4px;
		margin: 0;
		padding-left: 1.1rem;
		color: var(--muted);
		overflow-wrap: anywhere;
	}

	details summary {
		min-height: var(--tap);
		display: flex;
		align-items: center;
		color: var(--accent-strong);
		font-weight: 600;
		cursor: pointer;
	}

	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px 12px;
	}

	.note {
		font-size: 0.88rem;
	}

	.flag.marked {
		color: var(--danger);
		font-weight: 600;
	}

	.history {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.again {
		display: grid;
		gap: 2px;
		width: 100%;
		min-height: var(--tap);
		padding: 8px 0;
		border: 0;
		background: none;
		color: var(--text);
		text-align: start;
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.again:active {
		transform: scale(0.99);
	}

	.again .question {
		font-weight: 550;
		overflow-wrap: anywhere;
	}

	.kind,
	.small {
		font-size: 0.88rem;
		overflow-wrap: anywhere;
	}

	@media (prefers-reduced-motion: reduce) {
		.fill,
		.waiting .line {
			transition: none;
			animation: none;
		}
	}
</style>
