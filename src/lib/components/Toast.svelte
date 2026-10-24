<script lang="ts">
	// Korte melding na een actie: zweeft boven de navigatie, zodat je hem ziet waar je ook
	// op de pagina bent, en verdwijnt vanzelf. Een fout blijft staan.
	let { text, error = false }: { text: string; error?: boolean } = $props();
</script>

<p class={['toast', error && 'error']} role={error ? 'alert' : 'status'}>{text}</p>

<style>
	.toast {
		position: fixed;
		left: 50%;
		bottom: calc(76px + env(safe-area-inset-bottom));
		z-index: 20;
		width: min(28rem, calc(100% - 32px));
		padding: 12px 16px;
		border-radius: var(--radius-sm);
		background: var(--text);
		color: var(--bg);
		box-shadow: 0 8px 28px oklch(0.2 0.01 85 / 0.25);
		font-weight: 550;
		translate: -50% 0;
		pointer-events: none;
		animation:
			toast-in 260ms var(--ease-out),
			toast-out 300ms var(--ease-out) 4s forwards;
	}

	.toast.error {
		background: var(--danger);
		color: var(--on-accent);
		pointer-events: auto;
		animation: toast-in 260ms var(--ease-out);
	}

	@container (min-width: 900px) {
		.toast {
			bottom: 24px;
		}
	}

	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(12px);
		}
	}

	@keyframes toast-out {
		to {
			opacity: 0;
			transform: translateY(8px);
			visibility: hidden;
		}
	}
</style>
