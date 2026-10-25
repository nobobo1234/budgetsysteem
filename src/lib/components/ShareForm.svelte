<script lang="ts">
	// Voorschieten op de detailpagina: kies wie meedeed, en verdeel gelijk of per persoon.
	// Rekent in de browser met dezelfde functies als de server; de server controleert opnieuw.
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { centsToInput, formatCents, parseAmount } from '#lib/money.ts';
	import { splitByAmounts, splitEqually } from '#lib/owed.ts';

	let {
		totalCents,
		people,
		initial = [],
		message,
		onclose
	}: {
		/** Het totaal van de uitgave, positief */
		totalCents: number;
		people: readonly { id: string; name: string }[];
		initial?: { name: string; amountCents: number }[];
		message?: string;
		onclose: () => void;
	} = $props();

	// Bij openen overnemen wat er al stond; daarna is het formulier van jou
	const start = untrack(() => initial);
	let selected = $state<string[]>(start.map((i) => i.name));
	let mode = $state<'gelijk' | 'bedrag'>(
		start.length > 0 &&
			start.some((i, n) => i.amountCents !== splitEqually(totalCents, start.length + 1).others[n])
			? 'bedrag'
			: 'gelijk'
	);
	let amounts = $state<Record<string, string>>(
		Object.fromEntries(start.map((i) => [i.name, centsToInput(i.amountCents)]))
	);
	let other = $state('');
	let saving = $state(false);

	const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
	const choices = $derived([
		...people.map((p) => p.name),
		...selected.filter((n) => !people.some((p) => same(p.name, n)))
	]);

	function toggle(name: string) {
		selected = selected.some((n) => same(n, name))
			? selected.filter((n) => !same(n, name))
			: [...selected, name];
	}

	function addOther() {
		const name = other.trim().replace(/\s+/g, ' ').slice(0, 40);
		if (name && !selected.some((n) => same(n, name))) selected = [...selected, name];
		other = '';
	}

	const preview = $derived.by(() => {
		if (selected.length === 0) return { error: null, mine: totalCents, others: [] as number[] };
		if (mode === 'gelijk') {
			const s = splitEqually(totalCents, selected.length + 1);
			return { error: null, ...s };
		}
		const parsed = selected.map((n) => parseAmount((amounts[n] ?? '').trim()));
		if (parsed.some((c) => c === null || c === 0))
			return { error: 'Vul per persoon een bedrag in.', mine: null, others: [] };
		const result = splitByAmounts(totalCents, parsed as number[]);
		return result.ok
			? { error: null, ...result.share }
			: { error: `${result.reason}.`, mine: null, others: [] };
	});
</script>

<form
	method="POST"
	action="?/share"
	class="share"
	use:enhance={() => {
		saving = true;
		return async ({ result, update }) => {
			await update({ reset: false });
			saving = false;
			if (result.type === 'success') onclose();
		};
	}}
>
	<fieldset class="who">
		<legend>Wie deed mee?</legend>
		<div class="picks">
			{#each choices as name (name)}
				<button
					type="button"
					class="pick"
					aria-pressed={selected.some((n) => same(n, name))}
					onclick={() => toggle(name)}>{name}</button
				>
			{/each}
		</div>
		<div class="other">
			<input
				bind:value={other}
				maxlength="40"
				aria-label="Andere naam"
				placeholder="Andere naam"
				autocomplete="off"
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						addOther();
					}
				}}
			/>
			<button type="button" class="button secondary" onclick={addOther} disabled={!other.trim()}
				>Toevoegen</button
			>
		</div>
	</fieldset>

	<fieldset class="mode">
		<legend>Verdelen</legend>
		<div class="segmented">
			<label>
				<input type="radio" name="mode" value="gelijk" bind:group={mode} />
				<span>Gelijk</span>
			</label>
			<label>
				<input type="radio" name="mode" value="bedrag" bind:group={mode} />
				<span>Bedrag per persoon</span>
			</label>
		</div>
	</fieldset>

	{#if selected.length > 0}
		<ul class="lines">
			<li>
				<span>Jouw deel</span>
				<span class="num">{preview.mine === null ? '–' : formatCents(preview.mine)}</span>
			</li>
			{#each selected as name, i (name)}
				<li>
					<span>{name}</span>
					<input type="hidden" name="name" value={name} />
					{#if mode === 'bedrag'}
						<span class="money">
							<span class="prefix" aria-hidden="true">€</span>
							<input
								name="amount"
								class="num"
								inputmode="decimal"
								aria-label="Bedrag voor {name}"
								placeholder="0,00"
								bind:value={amounts[name]}
								autocomplete="off"
							/>
						</span>
					{:else}
						<span class="num">{formatCents(preview.others[i] ?? 0)}</span>
					{/if}
				</li>
			{/each}
		</ul>
		{#if mode === 'gelijk'}
			<p class="muted small">
				Gelijk over {selected.length + 1} personen, jij inbegrepen. Restcenten gaan naar de anderen.
			</p>
		{/if}
	{/if}

	{#if preview.error && mode === 'bedrag'}<p class="error-text" role="alert">
			{preview.error}
		</p>{/if}
	{#if message}<p class="error-text" role="alert">{message}</p>{/if}

	<div class="actions">
		<button class="button" disabled={saving || selected.length === 0 || preview.error !== null}
			>{saving ? 'Opslaan…' : 'Verdeling opslaan'}</button
		>
		<button type="button" class="button secondary" onclick={onclose}>Annuleren</button>
	</div>
</form>

<style>
	.share {
		display: grid;
		gap: 16px;
	}

	fieldset {
		display: grid;
		gap: 8px;
		margin: 0;
		padding: 0;
		border: 0;
		min-width: 0;
	}

	legend {
		padding: 0;
		margin-bottom: 8px;
		font-weight: 550;
		font-size: 0.95rem;
	}

	.picks {
		display: flex;
		flex-wrap: wrap;
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
		background: var(--accent-soft);
		color: var(--accent-strong);
	}

	.other {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
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
		min-height: 40px;
		border-radius: 8px;
		font-size: 0.92rem;
		font-weight: 550;
		color: var(--muted);
		pointer-events: none;
		text-align: center;
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

	.lines {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
	}

	.lines li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: var(--tap);
		border-top: 1px solid var(--line);
	}

	.lines li:first-child {
		border-top: 0;
		font-weight: 600;
	}

	.money {
		position: relative;
		display: block;
		width: 8.5rem;
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
		width: 100%;
		padding-left: 28px;
		text-align: right;
	}

	.small {
		font-size: 0.88rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
