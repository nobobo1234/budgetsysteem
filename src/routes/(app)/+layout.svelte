<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { afterNavigate, onNavigate, refreshAll } from '$app/navigation';
	import { ICONS } from '#lib/icons.ts';
	import { activeTab } from '#lib/nav.ts';
	import { nav } from '#lib/nav.svelte.ts';
	import { flush } from '#lib/offline/queue.ts';
	import { sync } from '#lib/offline/sync.svelte.ts';
	import { refreshSubscription } from '#lib/push.ts';

	let { children, data } = $props();

	// Lijn-iconen uit icons.ts, zodat je de tabs ook herkent zonder te lezen; de actieve tab
	// krijgt de gevulde vorm (spec: Navigatie)
	const links = [
		{ href: '/', label: 'Overzicht', icon: ICONS.overzicht },
		{ href: '/transacties', label: 'Transacties', icon: ICONS.transacties },
		{ href: '/budget', label: 'Budget', icon: ICONS.budget },
		{ href: '/import', label: 'Import', icon: ICONS.import },
		{ href: '/instellingen', label: 'Meer', icon: ICONS.meer }
	] as const;

	// Een subpagina laat de tab van haar ouder actief, zoals Budget bij vaste lasten
	const current = $derived(activeTab(page.url.pathname));

	// Een indicator die tussen de tabs schuift: gemeten op het icoon van de actieve tab, zodat
	// hij op een telefoon (onderin) en op desktop (bovenin) op de goede plek staat
	let navEl = $state<HTMLElement>();
	let indicator = $state<{ x: number; y: number; w: number } | null>(null);
	let ready = $state(false);
	function measure() {
		const link = navEl?.querySelector<HTMLElement>('a[aria-current="page"]');
		const icon = link?.querySelector<HTMLElement>('.icon');
		if (!navEl || !link || !icon) return (indicator = null);
		const n = navEl.getBoundingClientRect();
		const l = link.getBoundingClientRect();
		const i = icon.getBoundingClientRect();
		indicator = { x: i.left + i.width / 2 - n.left, y: i.top + i.height / 2 - n.top, w: l.width };
	}
	$effect(() => {
		void current;
		void tick().then(measure);
	});
	onMount(() => {
		measure();
		// Pas na de eerste meting bewegen, anders schuift hij bij het laden vanaf links in
		requestAnimationFrame(() => (ready = true));
		const observer = new ResizeObserver(measure);
		if (navEl) observer.observe(navEl);
		return () => observer.disconnect();
	});

	// De compacte kop toont de titel van de pagina zodra de grote titel uit beeld schuift
	let title = $state('');
	const readTitle = () =>
		(title = document.querySelector('main h1')?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
	afterNavigate(() => void tick().then(readTitle));
	function toTop() {
		const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
		window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
	}

	// Voor de terugknop: de pagina waar je vandaan komt, met haar zoekopdracht
	onNavigate(({ from }) => {
		nav.previous = from ? from.url.pathname + from.url.search : null;
	});

	async function trySync() {
		const result = await flush();
		sync.offline = result.offline;
		sync.loggedOut = result.loggedOut;
		await sync.refreshPending();
		if (result.sent > 0) await refreshAll();
	}

	$effect(() => {
		void trySync();
		// Pushabonnement aan de huidige sessie koppelen (na opnieuw inloggen)
		void refreshSubscription();
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

	{#if title}
		<button type="button" class="compact" tabindex="-1" aria-hidden="true" onclick={toTop}>
			<span>{title}</span>
		</button>
	{/if}

	<main>
		{@render children()}
	</main>

	<nav aria-label="Hoofdmenu" bind:this={navEl} class:ready>
		{#if indicator}
			<span
				class="indicator"
				aria-hidden="true"
				style:--x="{indicator.x}px"
				style:--y="{indicator.y}px"
				style:--w={indicator.w}
			></span>
		{/if}
		{#each links as link (link.href)}
			{@const on = current === link.href}
			<a href={link.href} aria-current={on ? 'page' : undefined}>
				<span class="icon">
					<svg viewBox="0 0 24 24" aria-hidden="true">
						{#if on}
							<path d={link.icon.fill} fill="currentColor" class="filled" />
						{:else}
							<path
								d={link.icon.path}
								fill="none"
								stroke="currentColor"
								stroke-width={link.href === '/instellingen' ? 3 : 1.7}
								stroke-linecap="round"
								stroke-linejoin="round"
							/>
						{/if}
					</svg>
					{#if link.href === '/instellingen' && data.meerAttention}
						<span class="dot" aria-hidden="true"></span>
					{/if}
				</span>
				<span
					>{link.label}{#if link.href === '/instellingen' && data.meerAttention}<span
							class="visually-hidden">, vraagt aandacht</span
						>{/if}</span
				>
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

	/* Compacte kop (spec: Beweging): verschijnt als de grote titel uit beeld schuift. Alleen
	   waar scroll-driven animations werken; anders blijft hij weg en verandert er niets. */
	.compact {
		display: none;
	}

	@supports (animation-timeline: view()) and (timeline-scope: --a) {
		.shell {
			timeline-scope: --page-title;
		}

		.compact {
			position: fixed;
			inset: 0 0 auto 0;
			z-index: 9;
			display: flex;
			align-items: center;
			justify-content: center;
			height: calc(48px + env(safe-area-inset-top));
			padding: env(safe-area-inset-top) 56px 0;
			border: 0;
			border-bottom: 1px solid var(--line);
			background: color-mix(in oklch, var(--bg) 95%, transparent);
			backdrop-filter: blur(14px);
			color: var(--text);
			font-family: var(--font-display);
			font-size: 1.05rem;
			font-weight: 600;
			font-variation-settings: 'opsz' 30;
			cursor: pointer;
			animation: compact-in linear both;
			animation-timeline: --page-title;
			animation-range: exit 40% exit 100%;
		}

		.compact span {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		main {
			--sticky-top: calc(48px + env(safe-area-inset-top));
		}
	}

	@keyframes compact-in {
		from {
			opacity: 0;
			transform: translateY(-100%);
			visibility: hidden;
		}
		to {
			opacity: 1;
			transform: none;
			visibility: visible;
		}
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

	.icon {
		position: relative;
		display: grid;
	}

	/* Stip op Meer: daar vraagt iets aandacht */
	.dot {
		position: absolute;
		top: -1px;
		right: -3px;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--warn);
		box-shadow: 0 0 0 2px var(--bg);
		animation: dot-in 400ms var(--ease-spring) both;
	}

	@keyframes dot-in {
		from {
			opacity: 0;
			transform: scale(0.3);
		}
	}

	nav a[aria-current='page'] {
		color: var(--accent-strong);
	}

	/* De gevulde vorm van de actieve tab veert in */
	.filled {
		transform-origin: center;
		transform-box: fill-box;
		animation: fill-in 300ms var(--ease-spring);
	}

	@keyframes fill-in {
		from {
			opacity: 0.4;
			transform: scale(0.82);
		}
	}

	/* Telefoon: een pil achter het icoon van de actieve tab, die naar de volgende tab schuift */
	.indicator {
		position: absolute;
		left: 0;
		top: 0;
		width: 56px;
		height: 30px;
		margin: -15px 0 0 -28px;
		border-radius: 999px;
		background: var(--accent-soft);
		transform: translate(var(--x), var(--y));
		pointer-events: none;
	}

	nav.ready .indicator {
		transition: transform 360ms var(--ease-spring);
	}

	nav a {
		position: relative;
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
		}

		/* Desktop: een streep onder de actieve tab, zo breed als de tab */
		.indicator {
			top: auto;
			bottom: -1px;
			width: 1px;
			height: 2px;
			margin: 0;
			border-radius: 0;
			background: var(--accent);
			transform: translateX(calc(var(--x) - var(--w) * 0.5px)) scaleX(var(--w));
			transform-origin: left;
		}

		main {
			padding-bottom: 48px;
			--sticky-top: 57px;
		}

		.compact {
			display: none;
		}
	}
</style>
