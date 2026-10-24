<script lang="ts">
	import '../app.css';
	import { onNavigate, type OnNavigate } from '$app/navigation';

	let { children } = $props();

	// Schermovergangen met View Transitions (spec: Beweging). De tabbalk blijft staan, de
	// inhoud schuift in de richting van de navigatie, en van de lijst naar een transactie
	// schuiven tegenpartij en bedrag mee naar de kop. Alleen als de browser het kan en je
	// geen verminderde beweging hebt ingesteld.
	const ORDER = [
		'/',
		'/transacties',
		'/budget',
		'/categorieen',
		'/regels',
		'/import',
		'/instellingen'
	];
	const TX = /^\/transacties\/([0-9a-f-]{36})$/;
	const depth = (path: string) => path.split('/').filter(Boolean).length;

	function direction(navigation: OnNavigate, from: string, to: string): 'forward' | 'back' {
		if (navigation.type === 'popstate') return navigation.delta < 0 ? 'back' : 'forward';
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

	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const from = navigation.from?.url.pathname;
		const to = navigation.to?.url.pathname;
		if (!from || !to || from === to) return;

		const root = document.documentElement;
		const shared = sharedTransaction(from, to);
		root.dataset.nav = direction(navigation, from, to);
		if (shared) nameShared(shared, true);

		return new Promise((resolve) => {
			const transition = document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
				if (shared) nameShared(shared, true);
			});
			transition.ready.catch(() => {});
			void transition.finished.finally(() => {
				if (shared) nameShared(shared, false);
				delete root.dataset.nav;
			});
		});
	});
</script>

{@render children()}
