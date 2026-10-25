<script lang="ts">
	import { backTarget } from '#lib/nav.ts';
	import { nav } from '#lib/nav.svelte.ts';

	// Terugknop voor een pagina zonder eigen tab (spec: Navigatie). De eerste ouder is de vaste
	// terugval; kwam je van een andere ouder, dan gaat hij daarheen.
	let { parents, labels }: { parents: readonly string[]; labels?: Record<string, string> } =
		$props();

	const target = $derived(backTarget(nav.previous, parents, labels));
</script>

<a class="back" href={target.href} onclick={() => (nav.back = true)}>
	<svg viewBox="0 0 20 20" aria-hidden="true">
		<path
			d="M12.5 4.5L7 10l5.5 5.5"
			fill="none"
			stroke="currentColor"
			stroke-width="1.8"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
	{target.label}
</a>

<style>
	.back {
		display: inline-flex;
		align-items: center;
		align-self: start;
		justify-self: start;
		gap: 2px;
		min-height: var(--tap);
		margin-left: -6px;
		padding-right: 8px;
		border-radius: 999px;
		text-decoration: none;
		font-weight: 550;
		transition: transform 160ms var(--ease-spring);
	}

	.back:active {
		transform: scale(0.96);
	}

	svg {
		width: 20px;
		height: 20px;
		transition: transform 160ms var(--ease-out);
	}

	.back:hover svg {
		transform: translateX(-2px);
	}
</style>
