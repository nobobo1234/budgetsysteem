<script lang="ts">
	import { page } from '$app/state';
	import { refreshAll } from '$app/navigation';
	import { flush } from '#lib/offline/queue.ts';
	import { sync } from '#lib/offline/sync.svelte.ts';

	let { children } = $props();

	const links = [
		{ href: '/', label: 'Overzicht' },
		{ href: '/transacties', label: 'Transacties' },
		{ href: '/budget', label: 'Budget' },
		{ href: '/import', label: 'Import' },
		{ href: '/instellingen', label: 'Meer' }
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
			<a href={link.href} aria-current={active(link.href) ? 'page' : undefined}>{link.label}</a>
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
		min-height: var(--tap);
		border-radius: var(--radius-sm);
		padding: 0 2px;
		color: var(--muted);
		text-decoration: none;
		font-size: 0.78rem;
		font-weight: 550;
		white-space: nowrap;
	}

	nav a[aria-current='page'] {
		color: var(--text);
		background: var(--surface-2);
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
			padding: 0 16px;
			font-size: 0.95rem;
		}

		main {
			padding-bottom: 48px;
		}
	}
</style>
