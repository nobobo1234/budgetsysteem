<script lang="ts">
	// Een verwachte vaste last op het startscherm. Eén tik bevestigt; bij een wisselende last
	// vul je eerst het echte bedrag in. Een week na de verwachte dag: gemist of opgezegd?
	import { enhance, type SubmitFunction } from '$app/forms';
	import { groupColor } from '#lib/categoryColor.ts';
	import { formatShortDate } from '#lib/dates.ts';
	import { centsToInput, formatCents } from '#lib/money.ts';

	interface Item {
		id: string;
		recurringId: string;
		date: string;
		amountCents: number;
		counterparty: string;
		kind: 'vast' | 'wisselend';
		categoryName: string | null;
		categoryGroup: string | null;
		missed: boolean;
	}

	let {
		item,
		ondone,
		grouped = false
	}: {
		item: Item;
		ondone: (text: string, error?: boolean) => void;
		/** In de groep "gemist of opgezegd?": dan zegt de kop het al */
		grouped?: boolean;
	} = $props();

	let editing = $state(false);
	let done = $state(false);
	let busy = $state(false);
	let askMissed = $state(false);
	let input = $state<HTMLInputElement>();

	const color = $derived(item.categoryGroup ? groupColor(item.categoryGroup) : null);

	const submitting: SubmitFunction = ({ formData }) => {
		busy = true;
		const reason = formData.get('reason');
		// De vink verschijnt meteen, tegelijk met het opslaan
		if (reason === null) done = true;
		return async ({ result, update }) => {
			busy = false;
			if (result.type === 'success') {
				ondone(
					reason === null
						? `${item.counterparty} bevestigd.`
						: reason === 'opgezegd'
							? `${item.counterparty} gestopt.`
							: `${item.counterparty} deze keer overgeslagen.`
				);
				await update();
				return;
			}
			done = false;
			const message = result.type === 'failure' ? result.data?.message : undefined;
			ondone(typeof message === 'string' ? message : 'Dat lukte niet. Probeer het opnieuw.', true);
		};
	};

	async function startEdit() {
		editing = true;
		await Promise.resolve();
		input?.focus();
		input?.select();
	}
</script>

<div class={['item', done && 'done']}>
	<div class="row">
		<a class="main" href="/vaste-lasten/{item.recurringId}">
			<span class="who">{item.counterparty}</span>
			<span class="meta">
				<span>verwacht {formatShortDate(item.date)}</span>
				<span class="category">
					<span class={['dot', !color && 'none']} style:--dot={color} aria-hidden="true"></span>
					<span class="cat">{item.categoryName ?? 'Geen categorie'}</span>
				</span>
			</span>
		</a>
		<span class="amount num">{formatCents(item.amountCents)}</span>
		{#if item.kind === 'wisselend' && !editing}
			<button
				type="button"
				class="check"
				aria-label="Bedrag van {item.counterparty} invullen en bevestigen"
				onclick={startEdit}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
			</button>
		{:else if item.kind === 'vast'}
			<form method="POST" action="?/confirmExpected" use:enhance={submitting}>
				<input type="hidden" name="id" value={item.id} />
				<button class="check" aria-label="Bevestig {item.counterparty}" disabled={busy || done}>
					<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
				</button>
			</form>
		{/if}
	</div>

	{#if editing}
		<form method="POST" action="?/confirmExpected" use:enhance={submitting} class="edit">
			<input type="hidden" name="id" value={item.id} />
			<label class="money">
				<span class="visually-hidden">Bedrag {item.counterparty}</span>
				<span class="prefix" aria-hidden="true">€</span>
				<input
					bind:this={input}
					name="amount"
					inputmode="decimal"
					class="num"
					value={centsToInput(item.amountCents)}
					autocomplete="off"
					required
				/>
			</label>
			<button class="button" disabled={busy || done}>Bevestigen</button>
			<button type="button" class="button secondary" onclick={() => (editing = false)}
				>Annuleren</button
			>
		</form>
	{/if}

	{#if item.missed}
		<div class="missed">
			{#if askMissed}
				<form method="POST" action="?/skipExpected" use:enhance={submitting} class="choices">
					<input type="hidden" name="id" value={item.id} />
					<button class="text-button" name="reason" value="gemist" disabled={busy}
						>Deze keer niet</button
					>
					<button class="text-button danger-text" name="reason" value="opgezegd" disabled={busy}
						>Opgezegd</button
					>
					<button type="button" class="text-button muted" onclick={() => (askMissed = false)}
						>Annuleren</button
					>
				</form>
			{:else}
				{#if !grouped}<span class="badge">Gemist of opgezegd?</span>{/if}
				<button type="button" class="text-button" onclick={() => (askMissed = true)}
					>Niet afgeschreven</button
				>
			{/if}
		</div>
	{/if}
</div>

<style>
	.item {
		display: grid;
		gap: 8px;
		padding: 10px 0;
		transition: opacity 220ms var(--ease-out);
	}

	.item.done {
		opacity: 0.6;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 48px;
	}

	.main {
		display: grid;
		gap: 3px;
		min-width: 0;
		flex: 1;
		color: inherit;
		text-decoration: none;
	}

	.who {
		font-weight: 560;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Datum en categorie; op een smal scherm komt de categorie op een eigen regel */
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 12px;
		min-width: 0;
		color: var(--muted);
		font-size: 0.9rem;
	}

	.meta > span {
		white-space: nowrap;
	}

	.category {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		max-width: 100%;
	}

	.cat {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--dot);
	}

	.dot.none {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--muted);
	}

	.amount {
		white-space: nowrap;
		font-weight: 600;
		font-size: 1.02rem;
	}

	/* Ronde vinkknop: secundair, zodat de kaart geen tweede primaire knop krijgt */
	.check {
		display: grid;
		place-items: center;
		flex: none;
		width: var(--tap);
		height: var(--tap);
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--accent-strong);
		box-shadow: inset 0 0 0 1.5px color-mix(in oklch, var(--accent) 45%, transparent);
		cursor: pointer;
		transition:
			transform 160ms var(--ease-spring),
			opacity 160ms var(--ease-out);
	}

	.check:active {
		transform: scale(0.94);
	}

	.check svg {
		width: 22px;
		height: 22px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	/* Vink-animatie bij afvinken: de knop vult zich en de vink veert in */
	.done .check {
		background: var(--accent);
		color: var(--on-accent);
		box-shadow: none;
		opacity: 1;
	}

	.done .check svg {
		animation: tick 320ms var(--ease-spring);
	}

	@keyframes tick {
		from {
			opacity: 0;
			transform: scale(0.4);
		}
	}

	.edit {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.money {
		position: relative;
		flex: 1 1 8rem;
	}

	.money input {
		width: 100%;
		padding-left: 28px;
		font-weight: 600;
	}

	.prefix {
		position: absolute;
		left: 12px;
		top: 50%;
		translate: 0 -50%;
		color: var(--muted);
		pointer-events: none;
	}

	.missed,
	.choices {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
	}

	.badge {
		padding: 1px 8px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--warn) 22%, transparent);
		font-size: 0.8rem;
		font-weight: 600;
	}

	.text-button {
		min-height: var(--tap);
		padding: 0 4px;
		border: 0;
		background: none;
		color: var(--accent-strong);
		font-weight: 600;
		cursor: pointer;
	}

	.text-button.muted {
		color: var(--muted);
	}

	.danger-text {
		color: var(--danger);
	}
</style>
