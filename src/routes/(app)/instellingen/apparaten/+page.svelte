<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Sheet from '#lib/components/Sheet.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import * as icons from '#lib/icons-extra.ts';
	import { reauth } from '#lib/reauth.ts';

	let { data, form } = $props();

	let adding = $state(false);
	let busy = $state(false);
	let message = $state('');
	let copied = $state(false);
	// Het nieuwe token één keer tonen; na "Klaar" is het weg
	let dismissed = $state<string | null>(null);
	// Aanmaken vraagt een passkey en werkt dus alleen met JavaScript
	let ready = $state(false);
	onMount(() => {
		ready = true;
	});

	const created = $derived(
		form && 'created' in form && form.created && form.created.id !== dismissed ? form.created : null
	);

	const dateTime = new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
	const time = new Intl.DateTimeFormat('nl-NL', { timeStyle: 'short' });
	const when = (iso: string) => dateTime.format(new Date(iso));

	const create: SubmitFunction = async ({ cancel }) => {
		message = '';
		busy = true;
		const confirmed = await reauth({ passkeys: data.passkeys, reauthFresh: data.reauthFresh });
		if (!confirmed.ok) {
			message = confirmed.message;
			busy = false;
			cancel();
			return;
		}
		return async ({ result, update }) => {
			await update();
			busy = false;
			copied = false;
			if (result.type === 'success') adding = false;
		};
	};

	const revoke: SubmitFunction = () => {
		busy = true;
		return async ({ update }) => {
			await update();
			busy = false;
		};
	};

	async function copy(token: string) {
		try {
			await navigator.clipboard.writeText(token);
			copied = true;
		} catch {
			message = 'Kopiëren lukte niet. Selecteer het token en kopieer het zelf.';
		}
	}

	const feedback = $derived(
		message
			? { text: message, error: true }
			: form && 'message' in form && form.message
				? { text: form.message, error: true }
				: form && 'revoked' in form
					? { text: 'Token ingetrokken', error: false }
					: null
	);
</script>

<svelte:head>
	<title>Apparaten · Budget</title>
</svelte:head>

<div class="page">
	<header>
		<BackLink parents={['/instellingen']} />
		<h1 data-morph-head="titel">Apparaten</h1>
		<p class="muted">
			Telefoons die bonnetjes sturen via het deelmenu. Hun token kan alleen uploaden, niets lezen.
		</p>
	</header>

	{#if feedback}
		{#key feedback}<Toast text={feedback.text} error={feedback.error} />{/key}
	{/if}

	{#if created}
		<section class="card created" aria-labelledby="created-title">
			<h2 id="created-title">Token voor {created.name}</h2>
			<p>Je ziet het maar één keer. Kopieer het en zet de opdracht op je iPhone.</p>
			<label class="field">
				<span>Upload-token</span>
				<textarea
					class="token"
					readonly
					rows="2"
					spellcheck="false"
					autocomplete="off"
					value={created.token}
					onfocus={(e) => e.currentTarget.select()}></textarea>
			</label>
			<div class="actions">
				<button type="button" class="button secondary" onclick={() => copy(created.token)}>
					{copied ? 'Gekopieerd' : 'Kopiëren'}
				</button>
			</div>
			<div class="install" role="group" aria-labelledby="install-title">
				<h3 id="install-title">Opdracht voor het deelmenu</h3>
				<ol class="steps">
					<li>Download de opdracht op je iPhone en open hem in Opdrachten.</li>
					<li>Tik op Voeg opdracht toe en plak het token als erom gevraagd wordt.</li>
					<li>Deel een bon vanuit Foto's en kies Bon naar Budget.</li>
				</ol>
				<a class="button download" href="/instellingen/apparaten/opdracht" download>
					<svg viewBox="0 0 24 24" aria-hidden="true"
						><path d="M12 4v11m-5-5 5 5 5-5M5 20h14" /></svg
					>
					Opdracht downloaden
				</a>
				<p class="warning small">
					Deel de opdracht nooit met het token erin. Voor een nieuw apparaat maak je een nieuw token
					aan.
				</p>
			</div>
			<div class="actions">
				<button type="button" class="button secondary" onclick={() => (dismissed = created.id)}>
					Klaar
				</button>
			</div>
		</section>
	{/if}

	{#if data.tokens.length > 0}
		<ul class="list" aria-label="Upload-tokens">
			{#each data.tokens as t (t.id)}
				<li>
					<span class="icon-badge hue" style:--h={icons.apparaten.hue} aria-hidden="true">
						<svg viewBox="0 0 24 24"><path d={icons.apparaten.path} /></svg>
					</span>
					<div class="name">
						<strong>{t.name}</strong>
						<span class="muted small">
							{t.lastUsedAt ? `Laatst gebruikt ${when(t.lastUsedAt)}` : 'Nog niet gebruikt'}
							· aangemaakt {when(t.createdAt)}
						</span>
						{#if t.blockedUntil}
							<span class="blocked small">
								Geblokkeerd tot {time.format(new Date(t.blockedUntil))}: meer dan 30 bonnen in een
								uur
							</span>
						{/if}
					</div>
					<form method="POST" action="?/revoke" use:enhance={revoke}>
						<input type="hidden" name="id" value={t.id} />
						<button class="text-button" disabled={busy} aria-label="Token van {t.name} intrekken"
							>Intrekken</button
						>
					</form>
				</li>
			{/each}
		</ul>
		<div class="new">
			<button class="button" onclick={() => (adding = true)} disabled={!ready}>
				<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
				Upload-token aanmaken
			</button>
		</div>
	{:else}
		<div class="card">
			<EmptyState
				icon={icons.apparaten}
				text="Nog geen telefoon die bonnetjes stuurt. Met een upload-token deel je een bon zo vanuit Foto's."
			>
				<button class="button" onclick={() => (adding = true)} disabled={!ready}>
					Upload-token aanmaken
				</button>
			</EmptyState>
		</div>
	{/if}

	<Sheet bind:open={adding} title="Upload-token aanmaken">
		<form method="POST" action="?/create" use:enhance={create} class="add">
			<p class="muted small">
				Eén token per apparaat. Het kan alleen bonnetjes sturen, hooguit 30 per uur. Je bevestigt
				met je passkey.
			</p>
			<label class="field">
				<span>Apparaat</span>
				<input name="name" maxlength="40" required autocomplete="off" placeholder="iPhone" />
			</label>
			<div class="actions">
				<button class="button" disabled={busy}>Aanmaken</button>
			</div>
		</form>
	</Sheet>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		max-width: 44rem;
	}

	header {
		display: grid;
		gap: 4px;
	}

	.small {
		font-size: 0.88rem;
	}

	.created {
		display: grid;
		gap: 12px;
		border-left: 4px solid var(--accent);
	}

	.created h2,
	.created p {
		margin: 0;
	}

	.install {
		display: grid;
		gap: 10px;
		justify-items: start;
		padding-top: 12px;
		border-top: 1px solid var(--line);
	}

	.install h3 {
		margin: 0;
		font-size: 1rem;
	}

	.steps {
		display: grid;
		gap: 6px;
		margin: 0;
		padding-left: 1.4em;
	}

	.download svg {
		width: 20px;
		height: 20px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.warning {
		margin: 0;
		padding-left: 10px;
		border-left: 3px solid var(--warn);
		font-weight: 550;
	}

	.token {
		width: 100%;
		resize: none;
		font-size: 1.05rem;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list > li {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		padding: 8px 0;
		border-top: 1px solid var(--line);
	}

	.list > li:last-child {
		border-bottom: 1px solid var(--line);
	}

	.name {
		display: grid;
		flex: 1;
		min-width: 0;
	}

	.blocked {
		color: var(--warn);
		font-weight: 550;
	}

	.icon-badge svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
		stroke-linejoin: round;
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

	.new {
		display: grid;
		justify-items: start;
	}

	.new svg {
		width: 20px;
		height: 20px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}

	.add {
		display: grid;
		gap: 14px;
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
</style>
