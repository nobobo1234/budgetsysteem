<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import Toast from '#lib/components/Toast.svelte';
	import { formatShortDate } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';

	let { data, form } = $props();

	// Welke formulieren open staan, per rekening. Zonder JavaScript werkt <details> gewoon.
	let checkOpen = $state<Record<string, boolean>>({});
	let anchorOpen = $state<Record<string, boolean>>({});

	const day = (iso: string) =>
		iso.slice(0, 4) === data.today.slice(0, 4)
			? formatShortDate(iso)
			: `${formatShortDate(iso)} ${iso.slice(0, 4)}`;

	const failed = (accountId: string, kind: 'check' | 'anchor') =>
		form && 'message' in form && form.accountId === accountId && form.kind === kind
			? form.message
			: null;

	const transactionsHref = (accountId: string, period: { from: string; to: string }) =>
		`/transacties?rekening=${accountId}&van=${period.from}&tot=${period.to}`;

	/** Na opslaan gaat het formulier dicht; het resultaat staat dan bovenaan de kaart. */
	const close =
		(accountId: string, kind: 'check' | 'anchor'): SubmitFunction =>
		() =>
		async ({ result, update }) => {
			await update();
			if (result.type !== 'success') return;
			if (kind === 'check') checkOpen[accountId] = false;
			else anchorOpen[accountId] = false;
		};
</script>

<svelte:head>
	<title>Saldocheck · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<h1>Saldocheck</h1>
		<p class="muted">
			Vul eens per maand het saldo van je rekeningen in. Wijkt het af van wat de app verwacht, dan
			mist er waarschijnlijk een boeking.
		</p>
	</div>

	{#each data.accounts as a (a.account.id)}
		{@const latest = a.checks[0]}
		<section class="card account" aria-labelledby="account-{a.account.id}">
			<header>
				<h2 id="account-{a.account.id}">{a.account.name}</h2>
				{#if a.expectedTodayCents !== null}
					<p class="expected">
						<span class="muted">Verwacht vandaag</span>
						<strong class="num">{formatCents(a.expectedTodayCents)}</strong>
					</p>
				{/if}
			</header>

			{#if !a.anchor}
				<p class="muted">
					Nog geen startsaldo. <a href="/import">Importeer een export</a> van de bank, dan haalt de app
					het eruit, of vul het saldo van een dag hieronder in.
				</p>
				<form
					method="POST"
					action="?/anchor"
					class="enter"
					use:enhance={close(a.account.id, 'anchor')}
				>
					<input type="hidden" name="accountId" value={a.account.id} />
					{@render fields(a.account.id, 'anchor', a.account.kind)}
					<button class="button">Startsaldo opslaan</button>
				</form>
			{:else}
				{#if !latest}
					<p class="muted">Nog geen check gedaan.</p>
				{:else if latest.differenceCents === 0}
					<p class="verdict ok">
						<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8" /></svg>
						<span>
							Klopt op {day(latest.date)}:
							<span class="num">{formatCents(latest.amountCents)}</span>
						</span>
					</p>
				{:else}
					<div class="verdict off">
						<p>
							<strong class="num">{formatCents(latest.differenceCents, { sign: true })}</strong>
							verschil op {day(latest.date)}
						</p>
						<p class="muted">
							De bank heeft {formatCents(Math.abs(latest.differenceCents))}
							{latest.differenceCents < 0 ? 'minder' : 'meer'} dan de app verwacht ({formatCents(
								latest.expectedCents
							)}).
							{latest.differenceCents < 0
								? 'Waarschijnlijk een vergeten uitgave.'
								: 'Misschien een vergeten inkomst, of een uitgave die dubbel staat.'}
						</p>
						{#if a.reviewCount > 0}
							<p class="muted">
								<a href="/transacties?status=te_controleren">{a.reviewCount} te controleren</a>
								{a.reviewCount === 1 ? 'telt' : 'tellen'} al mee met een bedrag dat nog kan veranderen.
							</p>
						{/if}
						<div class="links">
							<a href={transactionsHref(a.account.id, latest.period)}>
								Transacties {day(latest.period.from)} – {day(latest.period.to)}
							</a>
							<a href="/import">Export importeren</a>
						</div>
					</div>
				{/if}

				<details class="enter" bind:open={checkOpen[a.account.id]}>
					<summary class="button">
						<span class="when-closed">Saldo invullen</span>
						<span class="when-open">Sluiten</span>
					</summary>
					<form method="POST" action="?/check" use:enhance={close(a.account.id, 'check')}>
						<input type="hidden" name="accountId" value={a.account.id} />
						{@render fields(a.account.id, 'check', a.account.kind)}
						<button class="button">Vergelijken</button>
					</form>
				</details>

				{#if a.checks.length > 1}
					<div class="history">
						<h3>Eerdere checks</h3>
						<ul>
							{#each a.checks.slice(1) as c (c.date)}
								<li>
									<span>{day(c.date)}</span>
									<span class="num">{formatCents(c.amountCents)}</span>
									<span class={['num', 'diff', c.differenceCents !== 0 && 'off']}>
										{c.differenceCents === 0
											? 'klopt'
											: formatCents(c.differenceCents, { sign: true })}
									</span>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<details class="anchor" bind:open={anchorOpen[a.account.id]}>
					<summary>
						<span class="muted">
							Startsaldo <span class="num">{formatCents(a.anchor.amountCents)}</span> eind {day(
								a.anchor.date
							)}, {a.anchor.source === 'import' ? 'uit de import' : 'zelf ingevuld'}
						</span>
						<span class="edit">Aanpassen</span>
					</summary>
					<form method="POST" action="?/anchor" use:enhance={close(a.account.id, 'anchor')}>
						<input type="hidden" name="accountId" value={a.account.id} />
						{@render fields(a.account.id, 'anchor', a.account.kind)}
						<button class="button secondary">Startsaldo opslaan</button>
					</form>
				</details>
			{/if}
		</section>
	{:else}
		<div class="card empty">
			<h2>Nog geen rekeningen</h2>
			<p class="muted">Importeer een export van de bank; de rekening komt er dan vanzelf bij.</p>
			<a class="button" href="/import">Export importeren</a>
		</div>
	{/each}

	{#if form && 'saved' in form}
		{#key form}
			<Toast text={form.saved === 'check' ? 'Saldo opgeslagen.' : 'Startsaldo opgeslagen.'} />
		{/key}
	{/if}
</div>

{#snippet fields(accountId: string, kind: 'check' | 'anchor', accountKind: string)}
	{@const error = failed(accountId, kind)}
	<div class="fields">
		<label class="field">
			<span>{kind === 'check' ? 'Saldo volgens de bank' : 'Saldo aan het eind van de dag'}</span>
			<span class="money">
				<span class="prefix" aria-hidden="true">€</span>
				<input
					name="amount"
					class="num"
					inputmode="decimal"
					autocomplete="off"
					placeholder="0,00"
					maxlength="20"
					required
					aria-invalid={error ? 'true' : undefined}
					aria-describedby={error ? `error-${kind}-${accountId}` : undefined}
				/>
			</span>
		</label>
		<label class="field">
			<span>Datum</span>
			<input type="date" name="date" value={data.today} max={data.today} required />
		</label>
	</div>
	{#if accountKind === 'revolut'}
		<p class="hint muted">
			Het totaal in euro. Andere valuta telt de app tegen de koers die je betaalde.
		</p>
	{/if}
	{#if error}
		<p class="error-text" id="error-{kind}-{accountId}" role="alert">{error}</p>
	{/if}
{/snippet}

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 44rem;
	}

	.intro {
		display: grid;
		gap: 8px;
	}

	.account {
		display: grid;
		gap: 16px;
		padding: 20px;
	}

	header {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: baseline;
		gap: 4px 16px;
	}

	.expected {
		display: grid;
		justify-items: end;
		text-align: right;
	}

	.expected .muted {
		font-size: 0.9rem;
	}

	.expected strong {
		font-size: 1.5rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.verdict {
		display: grid;
		gap: 6px;
	}

	.verdict.ok {
		display: flex;
		align-items: center;
		gap: 10px;
		font-weight: 550;
	}

	.verdict.ok svg {
		flex: none;
		width: 28px;
		height: 28px;
		padding: 5px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-strong);
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.verdict.off {
		padding: 12px 14px;
		border-left: 4px solid var(--warn);
		border-radius: var(--radius-sm);
		background: color-mix(in oklch, var(--warn) 10%, transparent);
	}

	.verdict.off strong {
		font-size: 1.25rem;
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 0 20px;
	}

	.links a {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
	}

	details > summary {
		list-style: none;
		cursor: pointer;
	}

	details > summary::-webkit-details-marker {
		display: none;
	}

	.enter > summary {
		justify-self: start;
		width: fit-content;
	}

	.enter[open] > summary {
		background: var(--surface-2);
		color: var(--text);
	}

	.when-open,
	.enter[open] .when-closed {
		display: none;
	}

	.enter[open] .when-open {
		display: inline;
	}

	form,
	details {
		display: grid;
		gap: 12px;
	}

	details form {
		margin-top: 12px;
	}

	/* Het formulier schuift kort in als het opengaat (spec: Beweging, alleen transform en opacity) */
	details[open] form {
		transition:
			opacity 180ms var(--ease-out),
			transform 180ms var(--ease-out);
	}

	@starting-style {
		details[open] form {
			opacity: 0;
			transform: translateY(-6px);
		}
	}

	.fields {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: end;
		gap: 10px;
	}

	.field {
		display: grid;
		gap: 4px;
		font-size: 0.92rem;
	}

	.field input {
		width: 100%;
		font-size: 1rem;
	}

	.money {
		position: relative;
		display: grid;
	}

	.money input {
		padding-left: 28px;
	}

	.prefix {
		position: absolute;
		left: 12px;
		top: 50%;
		translate: 0 -50%;
		color: var(--muted);
		pointer-events: none;
	}

	.hint {
		font-size: 0.9rem;
	}

	form > .button {
		justify-self: start;
	}

	.history {
		display: grid;
		gap: 6px;
	}

	.history ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.history li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto minmax(5.5rem, auto);
		gap: 12px;
		padding: 8px 0;
		font-size: 0.95rem;
	}

	.history li + li {
		border-top: 1px solid var(--line);
	}

	.diff {
		text-align: right;
		color: var(--muted);
	}

	.diff.off {
		color: var(--text);
		font-weight: 600;
	}

	.anchor {
		padding-top: 12px;
		border-top: 1px solid var(--line);
	}

	.anchor > summary {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 4px 12px;
		min-height: var(--tap);
		font-size: 0.92rem;
	}

	.edit {
		color: var(--accent-strong);
		font-weight: 550;
	}

	.empty {
		display: grid;
		gap: 10px;
		justify-items: start;
		padding: 24px;
	}
</style>
