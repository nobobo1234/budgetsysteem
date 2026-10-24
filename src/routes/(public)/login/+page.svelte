<script lang="ts">
	import { onMount } from 'svelte';
	import { startAuthentication } from '@simplewebauthn/browser';
	import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
	import { passkeyErrorMessage, postJson } from '#lib/api.ts';

	let busy = $state(false);
	let message = $state('');
	let useCode = $state(false);
	let code = $state('');
	// De passkey-knop werkt alleen met JavaScript: pas actief na hydratatie
	let ready = $state(false);

	onMount(() => {
		ready = true;
		// Na uitloggen: offline-caches met persoonlijke gegevens weg
		if (new URL(location.href).searchParams.has('uitgelogd') && 'caches' in window) {
			void caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
		}
	});

	async function login() {
		busy = true;
		message = '';
		try {
			const options =
				await postJson<PublicKeyCredentialRequestOptionsJSON>('/api/auth/login/options');
			if (!options.ok) {
				message = options.message;
				return;
			}
			let response;
			try {
				response = await startAuthentication({ optionsJSON: options.data });
			} catch (e) {
				message = passkeyErrorMessage(e);
				return;
			}
			const result = await postJson('/api/auth/login/verify', response);
			if (!result.ok) {
				message = result.message;
				return;
			}
			location.assign('/');
		} finally {
			busy = false;
		}
	}

	async function recover(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = '';
		const result = await postJson('/api/auth/recover', { code });
		busy = false;
		if (!result.ok) {
			message = result.message;
			return;
		}
		location.assign('/instellingen?herstel=1');
	}
</script>

<svelte:head>
	<title>Inloggen · Budget</title>
</svelte:head>

<main>
	<div class="intro">
		<h1>Budget</h1>
		<p class="muted">Log in met de passkey op dit apparaat.</p>
	</div>

	{#if useCode}
		<form onsubmit={recover} class="stack">
			<label for="code">Herstelcode</label>
			<input
				id="code"
				name="code"
				bind:value={code}
				autocomplete="one-time-code"
				autocapitalize="characters"
				spellcheck="false"
				maxlength="40"
				required
			/>
			<button class="button" disabled={busy || !ready}>Inloggen met herstelcode</button>
			<button type="button" class="button secondary" onclick={() => (useCode = false)}>
				Terug naar passkey
			</button>
		</form>
	{:else}
		<div class="stack">
			<button class="button" onclick={login} disabled={busy || !ready}>
				{busy ? 'Even geduld…' : 'Inloggen met passkey'}
			</button>
			<button type="button" class="link" onclick={() => (useCode = true)}>
				Passkey kwijt? Gebruik je herstelcode
			</button>
		</div>
	{/if}

	<p class="error-text" role="alert" aria-live="polite">{message}</p>
</main>

<style>
	main {
		min-height: 100dvh;
		max-width: 26rem;
		margin: 0 auto;
		padding: 18vh 16px 32px;
		display: grid;
		align-content: start;
		gap: 32px;
	}

	.intro {
		display: grid;
		gap: 8px;
	}

	h1 {
		font-size: clamp(3rem, 14vw, 4.5rem);
	}

	.stack {
		display: grid;
		gap: 12px;
	}

	label {
		font-weight: 600;
	}

	.link {
		min-height: var(--tap);
		background: none;
		border: 0;
		color: var(--accent-strong);
		text-decoration: underline;
		text-underline-offset: 0.2em;
		cursor: pointer;
	}
</style>
