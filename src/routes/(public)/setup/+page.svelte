<script lang="ts">
	import { onMount } from 'svelte';
	import { startRegistration } from '@simplewebauthn/browser';
	import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
	import { passkeyErrorMessage, postJson } from '#lib/api.ts';

	let token = $state('');
	let busy = $state(false);
	let message = $state('');
	let recoveryCode = $state('');
	let ready = $state(false);
	onMount(() => {
		ready = true;
	});

	async function register(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = '';
		try {
			const options = await postJson<PublicKeyCredentialCreationOptionsJSON>(
				'/api/auth/setup/options',
				{ token: token.trim() }
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
			const result = await postJson<{ recoveryCode: string }>('/api/auth/setup/verify', response);
			if (!result.ok) {
				message = result.message;
				return;
			}
			recoveryCode = result.data.recoveryCode;
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Eerste passkey · Budget</title>
</svelte:head>

<main>
	{#if recoveryCode}
		<h1>Schrijf je herstelcode op</h1>
		<p>
			Met deze code kom je erin als je geen enkele passkey meer hebt. Hij wordt maar één keer
			getoond en werkt één keer. Bewaar hem op papier, niet op dit apparaat.
		</p>
		<p class="code num">{recoveryCode}</p>
		<p class="muted">Voeg daarna een passkey toe op een tweede apparaat, onder Instellingen.</p>
		<a class="button" href="/" data-sveltekit-reload>Ik heb hem opgeschreven</a>
	{:else}
		<h1>Eerste passkey</h1>
		<p class="muted">
			Maak op de server een setup-token aan met <code>pnpm setup-token</code> en plak het hier.
		</p>
		<form onsubmit={register}>
			<label for="token">Setup-token</label>
			<input
				id="token"
				bind:value={token}
				autocomplete="off"
				spellcheck="false"
				maxlength="100"
				required
			/>
			<button class="button" disabled={busy || !ready}
				>{busy ? 'Even geduld…' : 'Passkey aanmaken'}</button
			>
		</form>
		<p class="error-text" role="alert" aria-live="polite">{message}</p>
	{/if}
</main>

<style>
	main {
		max-width: 30rem;
		margin: 0 auto;
		padding: 14vh 16px 32px;
		display: grid;
		gap: 20px;
	}

	form {
		display: grid;
		gap: 12px;
	}

	label {
		font-weight: 600;
	}

	.code {
		font-size: 1.5rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		padding: 16px;
		border-radius: var(--radius);
		background: var(--surface);
		text-align: center;
		user-select: all;
	}

	code {
		font-family: inherit;
		font-weight: 600;
	}
</style>
