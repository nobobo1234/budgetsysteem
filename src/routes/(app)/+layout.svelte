<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { refreshAll } from '$app/navigation';
	import { flush } from '#lib/offline/queue.ts';
	import { sync } from '#lib/offline/sync.svelte.ts';

	let { children } = $props();

	// Eenvoudige lijn-iconen (24×24), zodat je de tabs ook herkent zonder te lezen
	const links = [
		{ href: '/', label: 'Overzicht', icon: 'M4 10.5L12 4l8 6.5V20h-5v-6H9v6H4z' },
		{
			href: '/transacties',
			label: 'Transacties',
			icon: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01'
		},
		{
			href: '/budget',
			label: 'Budget',
			icon: 'M12 3a9 9 0 1 0 9 9h-9z M15 3.5A9 9 0 0 1 20.5 9H15z'
		},
		{ href: '/import', label: 'Import', icon: 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M4 15v5h16v-5' },
		{
			href: '/instellingen',
			label: 'Meer',
			icon: 'M5 12h.01M12 12h.01M19 12h.01'
		}
	] as const;

	const active = (href: string) =>
		href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);

	async function trySync() {
		const result = await flush();
		sync.offline = result.offline;
		sync.loggedOut = result.loggedOut;
		await sync.refreshPending();
		if (result.sent > 0) await refreshAll();
	}

	$effect(() => {
		void trySync();
	});

	// Web-vitals pas laden als de browser even niets te doen heeft, buiten de eerste bundel
	onMount(() => {
		const start = () => void import('#lib/vitals.ts').then((m) => m.startVitals());
		if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 3000 });
		else setTimeout(start, 1000);
	});
</script>

<svelte:window ononline={trySync} />
<svelte:document onvisibilitychange={() => document.visibilityState === 'visible' && trySync()} />

<div class="shell">
	{#if sync.loggedOut}
		<p class="banner" role="status">
			Je sessie is verlopen. <a href="/login" data-sveltekit-reload>Log opnieuw in</a> om je invoer te
			versturen.
		</p>
	{:else if sync.offline && sync.pending.length > 0}
		<p class="banner" role="status">
			Offline: {sync.pending.length}
			{sync.pending.length === 1 ? 'post wacht' : 'posten wachten'} op verbinding.
		</p>
	{/if}

	<main>
		{@render children()}
	</main>

	<nav aria-label="Hoofdmenu">
		{#each links as link (link.href)}
			<a href={link.href} aria-current={active(link.href) ? 'page' : undefined}>
				<svg viewBox="0 0 24 24" aria-hidden="true">
					<path
						d={link.icon}
						fill="none"
						stroke="currentColor"
						stroke-width={link.href === '/instellingen' ? 3 : 1.7}
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				<span>{link.label}</span>
			</a>
		{/each}
	</nav>
</div>

<style>
	.shell {
		min-height: 100dvh;
		display: grid;
		grid-template-rows: auto 1fr auto;
		container-type: inline-size;
	}

	main {
		view-transition-name: page;
		width: 100%;
		max-width: 64rem;
		margin: 0 auto;
		padding: 24px 16px calc(96px + env(safe-area-inset-bottom));
	}

	.banner {
		margin: 0;
		padding: 10px 16px;
		background: var(--surface-2);
		text-align: center;
		font-size: 0.95rem;
	}

	/* Mobiel eerst: de navigatie onderin, binnen bereik van je duim */
	nav {
		view-transition-name: nav;
		position: fixed;
		inset: auto 0 0 0;
		z-index: 10;
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 2px;
		padding: 6px 6px calc(6px + env(safe-area-inset-bottom));
		background: color-mix(in oklch, var(--bg) 88%, transparent);
		backdrop-filter: blur(14px);
		border-top: 1px solid var(--line);
	}

	nav a {
		display: grid;
		place-items: center;
		align-content: center;
		gap: 2px;
		min-height: 52px;
		border-radius: var(--radius-sm);
		padding: 4px 2px;
		color: var(--muted);
		text-decoration: none;
		font-size: 0.74rem;
		font-weight: 550;
		white-space: nowrap;
		transition: transform 160ms var(--ease-spring);
	}

	nav a:active {
		transform: scale(0.94);
	}

	nav svg {
		width: 22px;
		height: 22px;
	}

	nav a[aria-current='page'] {
		color: var(--accent-strong);
	}

	@container (min-width: 900px) {
		nav {
			position: sticky;
			top: 0;
			inset: 0 0 auto 0;
			grid-row: 1;
			display: flex;
			justify-content: center;
			gap: 8px;
			border-top: 0;
			border-bottom: 1px solid var(--line);
		}

		nav a {
			display: flex;
			gap: 8px;
			min-height: var(--tap);
			padding: 0 16px;
			font-size: 0.95rem;
		}

		nav svg {
			width: 18px;
			height: 18px;
		}

		nav a[aria-current='page'] {
			color: var(--text);
			background: var(--surface-2);
		}

		main {
			padding-bottom: 48px;
		}
	}
</style>
