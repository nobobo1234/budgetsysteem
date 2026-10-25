<script lang="ts">
	import '../app.css';
	import { onNavigate, type OnNavigate } from '$app/navigation';
	import { morphPlan, morphSelector, type MorphPlan } from '#lib/morph.ts';
	import { nav } from '#lib/nav.svelte.ts';

	let { children } = $props();

	// Schermovergangen met View Transitions (spec: Beweging). De tabbalk blijft staan, de
	// inhoud schuift in de richting van de navigatie, en van de lijst naar een transactie
	// schuiven tegenpartij en bedrag mee naar de kop. Alleen als de browser het kan en je
	// geen verminderde beweging hebt ingesteld. Subpagina's staan direct na hun tab, zodat de
	// weg erheen vooruit is en de weg terug achteruit.
	const ORDER = [
		'/',
		'/transacties',
		'/budget',
		'/vaste-lasten',
		'/categorieen',
		'/regels',
		'/import',
		'/instellingen',
		'/te-krijgen',
		'/personen',
		'/terugbetalingen',
		'/saldocheck',
		'/instellingen/meldingen',
		'/instellingen/rekeningen',
		'/instellingen/beveiliging',
		'/instellingen/status'
	];
	const TX = /^\/transacties\/([0-9a-f-]{36})$/;
	const depth = (path: string) => path.split('/').filter(Boolean).length;

	function direction(
		navigation: OnNavigate,
		from: string,
		to: string,
		backLink: boolean
	): 'forward' | 'back' {
		if (navigation.type === 'popstate') return navigation.delta < 0 ? 'back' : 'forward';
		if (backLink) return 'back';
		if (depth(to) !== depth(from)) return depth(to) > depth(from) ? 'forward' : 'back';
		const i = ORDER.indexOf(from);
		const j = ORDER.indexOf(to);
		return i >= 0 && j >= 0 && j < i ? 'back' : 'forward';
	}

	/** De transactie die tussen lijst en detailpagina meeschuift, als die er is. */
	function sharedTransaction(from: string, to: string): string | null {
		if (from === '/transacties') return TX.exec(to)?.[1] ?? null;
		if (to === '/transacties') return TX.exec(from)?.[1] ?? null;
		return null;
	}

	// Namen alleen tijdens de overgang, zodat niet elke rij een eigen laag krijgt
	function nameShared(id: string, on: boolean) {
		for (const [attr, part] of [
			['data-tx-name', 'naam'],
			['data-tx-amount', 'bedrag']
		] as const) {
			const el = document.querySelector<HTMLElement>(`[${attr}="${id}"]`);
			if (el) el.style.viewTransitionName = on ? `tx-${part}-${id}` : '';
		}
	}

	/** Tegels en signaalkaartjes die meeschuiven naar de kop van hun pagina. */
	function nameMorphs(plan: MorphPlan | null, here: string, on: boolean) {
		if (!plan) return;
		for (const part of plan.parts) {
			const el = document.querySelector<HTMLElement>(morphSelector(plan, here, part));
			if (el) el.style.viewTransitionName = on ? `morph-${part}` : '';
		}
	}

	onNavigate((navigation) => {
		// De terugknop zegt dat dit terug is, ook als de pagina's even diep liggen
		const back = nav.back;
		nav.back = false;
		if (!document.startViewTransition) return;
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const from = navigation.from?.url.pathname;
		const to = navigation.to?.url.pathname;
		if (!from || !to || from === to) return;

		const root = document.documentElement;
		const shared = sharedTransaction(from, to);
		const morph = morphPlan(from, to);
		root.dataset.nav = direction(navigation, from, to, back);
		if (shared) nameShared(shared, true);
		nameMorphs(morph, from, true);

		return new Promise((resolve) => {
			const transition = document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
				if (shared) nameShared(shared, true);
				nameMorphs(morph, to, true);
			});
			transition.ready.catch(() => {});
			void transition.finished.finally(() => {
				if (shared) nameShared(shared, false);
				nameMorphs(morph, to, false);
				delete root.dataset.nav;
			});
		});
	});
</script>

{@render children()}
