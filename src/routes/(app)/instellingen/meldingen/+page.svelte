<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { postJson, sendJson } from '#lib/api.ts';
	import { currentSubscription, pushSupported, syncSubscription } from '#lib/push.ts';
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import {
		LOCKSCREEN_SETTING,
		NOTIFICATION_KINDS,
		NOTIFICATION_KIND_KEYS,
		type NotificationGroup
	} from '#lib/notifications.ts';

	let { data } = $props();

	type DeviceState = 'laden' | 'niet_ingesteld' | 'niet_ondersteund' | 'geweigerd' | 'uit' | 'aan';

	let deviceState = $state<DeviceState>('laden');
	let thisDevice = $state<string | null>(null);
	let busy = $state(false);
	let notice = $state<{ text: string; error: boolean; n: number } | null>(null);

	function say(text: string, error = false) {
		notice = { text, error, n: (notice?.n ?? 0) + 1 };
	}

	const groups: { id: NotificationGroup; title: string; intro: string }[] = [
		{ id: 'geld', title: 'Geld', intro: 'Wat er in je budget gebeurt.' },
		{ id: 'server', title: 'Server', intro: 'Als de app of de backups aandacht nodig hebben.' },
		{ id: 'beveiliging', title: 'Beveiliging', intro: 'Als er iemand bij je account komt.' }
	];
	const kindsIn = (group: NotificationGroup) =>
		NOTIFICATION_KIND_KEYS.filter((k) => NOTIFICATION_KINDS[k].group === group);

	const dateTime = new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
	const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : 'nog geen');

	function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
		const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
		const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
		return Uint8Array.from(raw, (c) => c.charCodeAt(0));
	}

	function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
		if (!a || a.byteLength !== b.length) return false;
		const x = new Uint8Array(a);
		return x.every((v, i) => v === b[i]);
	}

	onMount(async () => {
		if (!data.vapidPublicKey) return void (deviceState = 'niet_ingesteld');
		if (!pushSupported()) return void (deviceState = 'niet_ondersteund');
		try {
			const subscription = await currentSubscription();
			// Een abonnement met een oude serversleutel werkt niet meer: opnieuw aanzetten
			if (
				subscription &&
				!sameKey(subscription.options.applicationServerKey, keyBytes(data.vapidPublicKey))
			) {
				await subscription.unsubscribe();
			} else if (subscription) {
				// Opnieuw doorgeven: herstelt een apparaat dat op de server is verwijderd
				const id = await syncSubscription(subscription);
				if (id) {
					thisDevice = id;
					deviceState = 'aan';
					if (!data.devices.some((d) => d.id === thisDevice)) await invalidateAll();
					return;
				}
			}
		} catch {
			// Valt terug op "uit"; aanzetten probeert het opnieuw
		}
		deviceState = Notification.permission === 'denied' ? 'geweigerd' : 'uit';
	});

	async function enable() {
		if (!data.vapidPublicKey) return;
		busy = true;
		try {
			// Eerst toestemming, direct vanuit de tik: Safari vraagt het anders niet
			const permission = await Notification.requestPermission();
			if (permission !== 'granted') {
				deviceState = permission === 'denied' ? 'geweigerd' : 'uit';
				return;
			}
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: keyBytes(data.vapidPublicKey)
			});
			const result = await postJson<{ id: string | null }>(
				'/api/push/subscription',
				subscription.toJSON()
			);
			if (!result.ok) {
				await subscription.unsubscribe();
				say(result.message, true);
				return;
			}
			thisDevice = result.data.id;
			deviceState = 'aan';
			say('Meldingen staan aan op dit apparaat.');
			await invalidateAll();
		} catch {
			say('Meldingen aanzetten lukte niet. Probeer het opnieuw.', true);
		} finally {
			busy = false;
		}
	}

	async function disable() {
		busy = true;
		try {
			const subscription = await currentSubscription();
			if (subscription) {
				const result = await sendJson('DELETE', '/api/push/subscription', {
					endpoint: subscription.endpoint
				});
				if (!result.ok) {
					say(result.message, true);
					return;
				}
				await subscription.unsubscribe();
			}
			thisDevice = null;
			deviceState = 'uit';
			say('Meldingen staan uit op dit apparaat.');
			await invalidateAll();
		} catch {
			say('Meldingen uitzetten lukte niet. Probeer het opnieuw.', true);
		} finally {
			busy = false;
		}
	}

	/** Schakelaar: direct opslaan. Lukt het niet, dan springt hij terug. */
	const toggle: SubmitFunction = ({ formElement }) => {
		return async ({ result, update }) => {
			if (result.type !== 'success') {
				const input = formElement.querySelector<HTMLInputElement>('input[role="switch"]');
				if (input) input.checked = !input.checked;
				say('Opslaan lukte niet. Probeer het opnieuw.', true);
			}
			await update({ reset: false });
		};
	};

	const submitOnChange = (event: Event) =>
		(event.currentTarget as HTMLInputElement).form?.requestSubmit();

	/** Formulier met een toast als bevestiging, of de fout van de server. */
	const withToast =
		(done: string): SubmitFunction =>
		() =>
		async ({ result, update }) => {
			if (result.type === 'failure') {
				const message = (result.data as { message?: unknown } | undefined)?.message;
				say(typeof message === 'string' ? message : 'Er ging iets mis.', true);
			} else if (result.type === 'success') {
				say(done);
			}
			await update();
		};
</script>

<svelte:head>
	<title>Meldingen · Budget</title>
</svelte:head>

{#snippet setting(key: string, label: string, hint: string, checked: boolean, locked = false)}
	<form method="POST" action="?/toggle" use:enhance={toggle}>
		<input type="hidden" name="key" value={key} />
		<label class="switch">
			<input
				type="checkbox"
				role="switch"
				name="enabled"
				{checked}
				disabled={locked}
				onchange={submitOnChange}
			/>
			<span class="track" aria-hidden="true"></span>
			<span class="text">
				{label}
				<span class="muted small">{hint}</span>
			</span>
		</label>
	</form>
{/snippet}

<div class="page">
	<div class="intro">
		<BackLink parents={['/instellingen']} />
		<h1 data-morph-head="titel">Meldingen</h1>
		<p class="muted">
			Pushmeldingen via de app op je beginscherm. Elke soort staat apart aan of uit.
		</p>
	</div>

	{#if notice}
		{#key notice.n}<Toast text={notice.text} error={notice.error} />{/key}
	{/if}

	<section
		class={['card device', deviceState === 'laden' && 'loading']}
		aria-labelledby="dit-apparaat"
	>
		<h2 id="dit-apparaat">Dit apparaat</h2>
		{#if deviceState === 'aan'}
			<p>Dit apparaat krijgt meldingen.</p>
			<div class="actions">
				<form method="POST" action="?/test" use:enhance={withToast('Testmelding verstuurd.')}>
					<button class="button secondary" disabled={busy}>Testmelding sturen</button>
				</form>
				<button class="button danger" onclick={disable} disabled={busy}>Uitzetten</button>
			</div>
		{:else if deviceState === 'uit' || deviceState === 'laden'}
			<p class="muted">
				Zet meldingen aan om te horen wanneer er iets op je wacht. De schakelaars hieronder gelden
				voor al je apparaten.
			</p>
			<button class="button" onclick={enable} disabled={busy || deviceState === 'laden'}
				>Meldingen aanzetten</button
			>
		{:else if deviceState === 'geweigerd'}
			<p>
				Je hebt meldingen voor deze app geweigerd. Zet ze aan in de instellingen van je telefoon
				(Instellingen → Meldingen → Budget) en kom dan hier terug.
			</p>
		{:else if deviceState === 'niet_ondersteund'}
			<p>
				Deze browser kan geen pushmeldingen ontvangen. Op een iPhone werkt het alleen vanuit de app
				op je beginscherm: tik in Safari op Deel en kies Zet op beginscherm.
			</p>
		{:else}
			<p>
				Pushmeldingen zijn op de server nog niet ingesteld. Zodra de VAPID-sleutels in de omgeving
				staan, kun je ze hier aanzetten.
			</p>
		{/if}
	</section>

	{#each groups as group (group.id)}
		<section aria-labelledby="groep-{group.id}">
			<div class="heading">
				<h2 id="groep-{group.id}">{group.title}</h2>
				<p class="muted">{group.intro}</p>
			</div>
			<div class="card list">
				{#each kindsIn(group.id) as kind (kind)}
					{@const info = NOTIFICATION_KINDS[kind]}
					{@render setting(kind, info.label, info.hint, data.settings[kind], !info.switchable)}
				{/each}
			</div>
		</section>
	{/each}

	<section aria-labelledby="vergrendelscherm">
		<div class="heading">
			<h2 id="vergrendelscherm">Vergrendelscherm</h2>
			<p class="muted">
				Een melding is ook te lezen als je telefoon op slot zit. Standaard staat er alleen wat er
				gebeurde, zonder bedragen of namen.
			</p>
		</div>
		<div class="card list">
			{@render setting(
				LOCKSCREEN_SETTING,
				'Bedragen en namen tonen',
				'Bijvoorbeeld "Vattenfall: € 84,20" in plaats van "Een vaste last"',
				data.settings[LOCKSCREEN_SETTING]
			)}
		</div>
	</section>

	<section aria-labelledby="apparaten">
		<div class="heading">
			<h2 id="apparaten">Apparaten met meldingen</h2>
			<p class="muted">Telefoon kwijt of weg? Haal hem hier weg.</p>
		</div>
		{#if data.devices.length === 0}
			<div class="card">
				<EmptyState
					icon="meldingen"
					text="Nog geen apparaten. Zet meldingen aan op je telefoon."
					compact
				/>
			</div>
		{:else}
			<ul class="card list">
				{#each data.devices as d (d.id)}
					<li>
						<div>
							<strong>{d.deviceName}{d.id === thisDevice ? ' (dit apparaat)' : ''}</strong>
							<span class="muted small"
								>Aangezet {when(d.createdAt)} · laatste melding {when(d.lastSentAt)}</span
							>
						</div>
						{#if d.id !== thisDevice}
							<form
								method="POST"
								action="?/removeDevice"
								use:enhance={withToast('Apparaat verwijderd.')}
							>
								<input type="hidden" name="id" value={d.id} />
								<button class="button danger">Verwijderen</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 32px;
		max-width: 44rem;
	}

	.intro,
	.heading {
		display: grid;
		gap: 6px;
	}

	section {
		display: grid;
		gap: 12px;
	}

	.device {
		display: grid;
		gap: 12px;
		justify-items: start;
		transition: opacity 200ms var(--ease-out);
	}

	.device.loading {
		opacity: 0.6;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
	}

	.list {
		display: grid;
		padding: 4px 16px;
	}

	.list > :global(* + *) {
		border-top: 1px solid var(--line);
	}

	ul.list {
		list-style: none;
		margin: 0;
	}

	li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		padding: 12px 0;
	}

	li div {
		display: grid;
		min-width: 0;
	}

	li .button {
		min-height: 40px;
		padding: 0 14px;
		font-size: 0.92rem;
	}

	.small {
		font-size: 0.88rem;
	}

	.switch {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: var(--tap);
		padding: 10px 0;
		cursor: pointer;
	}

	.switch .text {
		display: grid;
		gap: 2px;
		min-width: 0;
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

	.switch input:disabled {
		cursor: default;
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

	.switch input:disabled + .track {
		opacity: 0.55;
	}

	.switch input:focus-visible + .track {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
</style>
