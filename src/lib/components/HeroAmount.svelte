<script lang="ts">
	import { untrack } from 'svelte';
	import { formatCents } from '#lib/money.ts';

	let {
		cents,
		label,
		morph
	}: {
		cents: number;
		label: string;
		/** Kop voor een meeschuivend bedrag (zie morph.ts) */
		morph?: 'bedrag';
	} = $props();

	// Het getal telt vloeiend mee bij elke wijziging. GSAP wordt pas geladen na de eerste
	// weergave, zodat het niet in de eerste bundel zit.
	let shown = $state<number | null>(null);
	let tween: { kill(): void } | undefined;

	$effect(() => {
		const target = cents;
		const from = untrack(() => shown);
		if (
			from === null ||
			from === target ||
			matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			shown = target;
			return;
		}
		let cancelled = false;
		void import('gsap').then(({ gsap }) => {
			if (cancelled) return;
			tween?.kill();
			const state = { value: from };
			tween = gsap.to(state, {
				value: target,
				duration: 0.6,
				ease: 'power3.out',
				onUpdate: () => {
					shown = Math.round(state.value);
				}
			});
		});
		return () => {
			cancelled = true;
		};
	});

	const display = $derived(
		formatCents(shown ?? cents, { whole: Math.abs(shown ?? cents) >= 100_000 })
	);
	// De centen kleiner en rustiger, zodat de euro's het verhaal vertellen
	const parts = $derived(/^(.*?)(,\d{2})$/.exec(display));
</script>

<section aria-label={label}>
	<p class="label">{label}</p>
	<p class="amount num" class:negative={cents < 0} aria-live="polite" data-morph-head={morph}>
		{#if parts}{parts[1]}<span class="cents">{parts[2]}</span>{:else}{display}{/if}
	</p>
</section>

<style>
	section {
		display: grid;
		gap: 4px;
	}

	.label {
		color: var(--muted);
		font-size: 1rem;
	}

	.amount {
		font-size: clamp(3.25rem, 16vw, 5.5rem);
		font-weight: 650;
		letter-spacing: -0.035em;
		line-height: 1;
	}

	.cents {
		font-size: 0.5em;
		font-weight: 600;
		letter-spacing: -0.01em;
		vertical-align: 0.72em;
		opacity: 0.55;
	}

	.negative {
		color: var(--danger);
	}
</style>
