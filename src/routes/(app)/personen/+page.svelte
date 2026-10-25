<script lang="ts">
	import { tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import OwedTabs from '#lib/components/OwedTabs.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { formatCents } from '#lib/money.ts';

	let { data, form } = $props();

	let adding = $state(false);
	let busy = $state(false);
	let confirmDelete = $state<string | null>(null);

	const keep: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			await update({ reset: result.type === 'success' });
			busy = false;
			confirmDelete = null;
		};
	};

	async function openForm() {
		adding = true;
		await tick();
		document.querySelector<HTMLInputElement>('#person-name')?.focus();
	}

	// IBAN in groepjes van vier, alleen voor weergave
	const groups = (iban: string) => iban.replace(/(.{4})/g, '$1 ').trim();

	const feedback = $derived(
		form && 'message' in form && form.message
			? { text: form.message, error: true }
			: form && 'added' in form
				? { text: 'Persoon toegevoegd', error: false }
				: form && 'saved' in form
					? { text: 'Opgeslagen', error: false }
					: form && 'deleted' in form
						? { text: 'Persoon verwijderd', error: false }
						: form && 'ibanAdded' in form
							? { text: 'IBAN toegevoegd', error: false }
							: form && 'ibanRemoved' in form
								? { text: 'IBAN verwijderd', error: false }
								: null
	);
</script>

<svelte:head>
	<title>Personen · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<h1>Personen</h1>
		<OwedTabs current="personen" open={data.openCount} people={data.people.length} />
		<p class="muted">
			Met wie je voorschiet of deelt. Met een IBAN herkent de koppellijst hun betalingen.
		</p>
	</div>

	{#if feedback}
		{#key form}<Toast text={feedback.text} error={feedback.error} />{/key}
	{/if}

	<ul class="list" aria-label="Personen">
		{#each data.people as p (p.id)}
			<li class={[!p.active && 'inactive']}>
				<details>
					<summary>
						<span class="name">
							<strong>{p.name}</strong>
							<span class="muted small">
								{p.ibans.length === 0
									? 'Geen IBAN'
									: p.ibans.length === 1
										? '1 IBAN'
										: `${p.ibans.length} IBANs`}{p.active ? '' : ' · niet actief'}
							</span>
						</span>
						<span class="sum">
							{#if p.toReceive > 0}<span class="num in">+{formatCents(p.toReceive)}</span>{/if}
							{#if p.toPay > 0}<span class="num">{formatCents(-p.toPay)}</span>{/if}
						</span>
					</summary>
					<div class="body">
						<form method="POST" action="?/edit" use:enhance={keep} class="edit">
							<input type="hidden" name="id" value={p.id} />
							<label class="field">
								<span>Naam</span>
								<input name="name" value={p.name} maxlength="40" required autocomplete="off" />
							</label>
							<label class="switch">
								<input type="checkbox" role="switch" name="active" checked={p.active} />
								<span class="track" aria-hidden="true"></span>
								<span>
									Actief
									<span class="muted small">Uit: niet meer in de snelinvoer, posten blijven</span>
								</span>
							</label>
							<div class="actions">
								<button class="button" disabled={busy}>Opslaan</button>
							</div>
						</form>

						<div class="ibans">
							<h3>IBANs</h3>
							{#if p.ibans.length > 0}
								<ul>
									{#each p.ibans as iban (iban)}
										<li>
											<span class="num">{groups(iban)}</span>
											<form method="POST" action="?/removeIban" use:enhance={keep}>
												<input type="hidden" name="id" value={p.id} />
												<input type="hidden" name="iban" value={iban} />
												<button class="text-button" aria-label="IBAN {groups(iban)} verwijderen"
													>Verwijderen</button
												>
											</form>
										</li>
									{/each}
								</ul>
							{/if}
							<form method="POST" action="?/addIban" use:enhance={keep} class="iban-form">
								<input type="hidden" name="id" value={p.id} />
								<input
									name="iban"
									aria-label="IBAN van {p.name}"
									placeholder="NL00 BANK 0123 4567 89"
									maxlength="42"
									autocomplete="off"
									autocapitalize="characters"
									spellcheck="false"
									required
								/>
								<button class="button secondary" disabled={busy}>Toevoegen</button>
							</form>
						</div>

						<div class="remove">
							{#if confirmDelete === p.id}
								<p>{p.name} verwijderen? Dat kan alleen zonder posten.</p>
								<div class="actions">
									<form method="POST" action="?/delete" use:enhance={keep}>
										<input type="hidden" name="id" value={p.id} />
										<button class="button danger" disabled={busy}>Ja, verwijderen</button>
									</form>
									<button
										type="button"
										class="button secondary"
										onclick={() => (confirmDelete = null)}>Annuleren</button
									>
								</div>
							{:else}
								<button type="button" class="button danger" onclick={() => (confirmDelete = p.id)}
									>Verwijderen</button
								>
							{/if}
						</div>
					</div>
				</details>
			</li>
		{:else}
			<li class="empty muted">
				Nog niemand. Typ in de snelinvoer <strong>met sanne</strong>, dan komt Sanne hier vanzelf
				bij, of voeg hieronder iemand toe.
			</li>
		{/each}
	</ul>

	<section aria-label="Nieuwe persoon" class="new">
		{#if !adding}
			<button class="button secondary" onclick={openForm}>Nieuwe persoon</button>
		{:else}
			<form method="POST" action="?/add" use:enhance={keep} class="card add">
				<label class="field">
					<span>Naam</span>
					<input id="person-name" name="name" maxlength="40" required autocomplete="off" />
				</label>
				<div class="actions">
					<button class="button" disabled={busy}>Toevoegen</button>
					<button type="button" class="button secondary" onclick={() => (adding = false)}
						>Sluiten</button
					>
				</div>
			</form>
		{/if}
	</section>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 28px;
		max-width: 44rem;
	}

	.intro {
		display: grid;
		gap: 14px;
	}

	.small {
		font-size: 0.88rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list > li {
		border-top: 1px solid var(--line);
	}

	.list > li:last-child {
		border-bottom: 1px solid var(--line);
	}

	.inactive .name strong {
		color: var(--muted);
	}

	summary {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 60px;
		padding: 8px 0;
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary:active {
		transform: scale(0.99);
	}

	.name {
		flex: 1;
		min-width: 0;
		display: grid;
		overflow-wrap: anywhere;
	}

	.sum {
		display: grid;
		justify-items: end;
		font-weight: 600;
	}

	.in {
		color: var(--accent-strong);
	}

	.body {
		display: grid;
		gap: 20px;
		padding: 4px 0 20px;
	}

	.edit,
	.add {
		display: grid;
		gap: 14px;
	}

	.add {
		padding: 18px;
	}

	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.field > span:first-child {
		font-weight: 550;
		font-size: 0.95rem;
	}

	.field input {
		width: 100%;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.ibans {
		display: grid;
		gap: 8px;
	}

	.ibans li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		min-height: var(--tap);
	}

	.iban-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
	}

	.text-button {
		min-height: var(--tap);
		padding: 0 4px;
		border: 0;
		background: transparent;
		color: var(--danger);
		font-weight: 550;
		cursor: pointer;
	}

	.remove {
		display: grid;
		gap: 8px;
		justify-items: start;
	}

	.new {
		display: grid;
		justify-items: start;
	}

	.new .add {
		justify-self: stretch;
	}

	.empty {
		padding: 16px 0;
	}

	.switch {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: var(--tap);
		cursor: pointer;
	}

	.switch > span:last-child {
		display: grid;
	}

	.switch input {
		position: absolute;
		opacity: 0;
		width: 44px;
		height: 26px;
		min-height: 0;
		margin: 0;
		cursor: pointer;
	}

	.track {
		position: relative;
		flex: none;
		width: 44px;
		height: 26px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--text) 22%, transparent);
	}

	.track::after {
		content: '';
		position: absolute;
		top: 3px;
		left: 3px;
		width: 20px;
		height: 20px;
		border-radius: 999px;
		background: #fff;
		box-shadow: 0 1px 3px oklch(0.2 0.01 85 / 0.25);
		transition: transform 220ms var(--ease-spring);
	}

	.switch input:checked + .track {
		background: var(--accent);
	}

	.switch input:checked + .track::after {
		transform: translateX(18px);
	}

	.switch input:focus-visible + .track {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
</style>
