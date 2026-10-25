<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { page } from '$app/state';
	import { refreshAll } from '$app/navigation';
	import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
	import type {
		PublicKeyCredentialCreationOptionsJSON,
		PublicKeyCredentialRequestOptionsJSON
	} from '@simplewebauthn/browser';
	import { passkeyErrorMessage, postJson } from '#lib/api.ts';

	let { data, form } = $props();
	let message = $state('');
	let busy = $state(false);
	// Passkey-knoppen werken alleen met JavaScript: pas actief na hydratatie
	let ready = $state(false);
	onMount(() => {
		ready = true;
	});

	const fromRecovery = $derived(page.url.searchParams.has('herstel'));
	const dateTime = new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
	const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : 'nooit');

	/** Gevoelige acties vragen altijd opnieuw om je passkey (spec: Beveiliging, laag 3). */
	async function reauth(): Promise<boolean> {
		// Na inloggen met de herstelcode is er nog geen passkey; die sessie is net bevestigd
		if (data.passkeys.length === 0) return data.reauthFresh;
		const options = await postJson<PublicKeyCredentialRequestOptionsJSON>(
			'/api/auth/reauth/options'
		);
		if (!options.ok) {
			message = options.message;
			return false;
		}
		try {
			const response = await startAuthentication({ optionsJSON: options.data });
			const result = await postJson('/api/auth/reauth/verify', response);
			if (!result.ok) message = result.message;
			return result.ok;
		} catch (e) {
			message = passkeyErrorMessage(e);
			return false;
		}
	}

	async function addPasskey() {
		busy = true;
		message = '';
		try {
			if (!(await reauth())) return;
			const options = await postJson<PublicKeyCredentialCreationOptionsJSON>(
				'/api/auth/passkeys/options'
			);
			if (!options.ok) {
				message = options.message;
				return;
			}
			let response;
			try {
				response = await startRegistration({ optionsJSON: options.data });
			} catch (e) {
				message = passkeyErrorMessage(e);
				return;
			}
			const result = await postJson('/api/auth/passkeys/verify', response);
			message = result.ok ? 'Passkey toegevoegd.' : result.message;
			await refreshAll();
		} finally {
			busy = false;
		}
	}

	const sensitive: SubmitFunction = async ({ cancel }) => {
		message = '';
		if (!(await reauth())) cancel();
	};
</script>

<svelte:head>
	<title>Instellingen · Budget</title>
</svelte:head>

<div class="page">
	<h1>Instellingen</h1>

	{#if fromRecovery && data.passkeys.length === 0}
		<p class="card notice" role="status">
			Je bent ingelogd met je herstelcode. Voeg nu een passkey toe en maak daarna een nieuwe
			herstelcode; de oude werkt niet meer.
		</p>
	{/if}

	{#if message}<p role="status">{message}</p>{/if}
	{#if form && 'message' in form && form.message}<p class="error-text" role="alert">
			{form.message}
		</p>{/if}

	<section>
		<h2>Passkeys</h2>
		<p class="muted">
			Zorg voor een passkey op minstens twee apparaten, plus je herstelcode op papier.
		</p>
		<ul>
			{#each data.passkeys as p (p.id)}
				<li>
					<div>
						<strong>{p.deviceName}</strong>
						<span class="muted">
							Toegevoegd {when(p.createdAt)} · laatst gebruikt {when(p.lastUsedAt)}
							{p.backedUp ? '· gesynchroniseerd' : ''}
						</span>
					</div>
					<form method="POST" action="?/revokePasskey" use:enhance={sensitive}>
						<input type="hidden" name="id" value={p.id} />
						<button class="button danger" disabled={data.passkeys.length <= 1}>Verwijderen</button>
					</form>
				</li>
			{/each}
		</ul>
		<button class="button" onclick={addPasskey} disabled={busy || !ready}>Passkey toevoegen</button>
	</section>

	<section>
		<h2>Herstelcode</h2>
		{#if form && 'recoveryCode' in form && form.recoveryCode}
			<p>
				Schrijf deze code op papier. Hij wordt maar één keer getoond; de vorige werkt niet meer.
			</p>
			<p class="code num">{form.recoveryCode}</p>
		{:else}
			<p class="muted">
				{data.hasRecoveryCode ? 'Je hebt een herstelcode.' : 'Je hebt geen geldige herstelcode.'}
			</p>
		{/if}
		<form method="POST" action="?/recoveryCode" use:enhance={sensitive}>
			<button class="button secondary">Nieuwe herstelcode maken</button>
		</form>
	</section>

	<section>
		<h2>Actieve apparaten</h2>
		<p class="muted">Telefoon kwijt? Trek die sessie hier in.</p>
		<ul>
			{#each data.sessions as s (s.idHash)}
				<li>
					<div>
						<strong
							>{s.deviceName}{s.idHash === data.currentSession ? ' (dit apparaat)' : ''}</strong
						>
						<span class="muted">Ingelogd {when(s.createdAt)} · actief {when(s.lastUsedAt)}</span>
					</div>
					{#if s.idHash !== data.currentSession}
						<form method="POST" action="?/revokeSession" use:enhance>
							<input type="hidden" name="id" value={s.idHash} />
							<button class="button danger">Intrekken</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	<section>
		<h2>Rekeningen</h2>
		<p class="muted">
			De alias gebruik je in de snelinvoer, zoals <strong>@rev</strong>. Met het IBAN worden
			overboekingen tussen je eigen rekeningen herkend.
		</p>
		{#each data.accounts as a (a.id)}
			<form method="POST" action="?/account" use:enhance class="card account">
				<input type="hidden" name="id" value={a.id} />
				<label><span>Naam</span><input name="name" value={a.name} maxlength="40" required /></label>
				<label
					><span>Alias</span><input name="alias" value={a.alias} maxlength="10" required /></label
				>
				<label><span>IBAN</span><input name="iban" value={a.iban ?? ''} maxlength="42" /></label>
				<button class="button secondary">Opslaan</button>
			</form>
		{/each}
	</section>

	<section>
		<h2>Overig</h2>
		<a href="/te-krijgen">Te krijgen</a>
		<a href="/personen">Personen</a>
		<a href="/saldocheck">Saldocheck</a>
		<a href="/categorieen">Categorieën</a>
		<a href="/regels">Regels</a>
		<form method="POST" action="?/logout">
			<button class="button secondary">Uitloggen</button>
		</form>
	</section>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 32px;
		max-width: 44rem;
	}

	section {
		display: grid;
		gap: 12px;
		justify-items: start;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0 16px;
		display: grid;
		width: 100%;
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: var(--shadow);
	}

	ul:empty {
		display: none;
	}

	li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		padding: 12px 0;
	}

	li + li {
		border-top: 1px solid var(--line);
	}

	li div {
		display: grid;
		min-width: 0;
	}

	li .muted {
		font-size: 0.9rem;
	}

	li .button {
		min-height: 40px;
		padding: 0 14px;
		font-size: 0.92rem;
	}

	.notice {
		border-left: 4px solid var(--warn);
	}

	.code {
		font-size: 1.4rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		user-select: all;
	}

	.account {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
		width: 100%;
	}

	.account label {
		display: grid;
		gap: 4px;
	}

	.account label:nth-of-type(3) {
		grid-column: 1 / -1;
	}

	.account button {
		grid-column: 1 / -1;
	}
</style>
