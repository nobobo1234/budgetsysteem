<script lang="ts">
	import { applyAction, enhance, type SubmitFunction } from '$app/forms';

	// Garantie bijhouden op een transactie of bon (spec: Garantie → Zelf): de producten die er al
	// bij horen als Meer-link, en anders een knop die om de naam van het product vraagt. Na
	// bijhouden ga je naar de pagina van het product, waar je de afleverdatum en de rest invult.

	let {
		warranties,
		canStart,
		fields
	}: {
		warranties: { id: string; product: string; status: 'actief' | 'afgedankt' }[];
		/** Alleen bij een uitgave die niet zelf een retour is */
		canStart: boolean;
		/** Verborgen velden voor de actie, zoals de transactie of de bon */
		fields: Record<string, string>;
	} = $props();

	let open = $state(false);
	let busy = $state(false);
	let message = $state<string | null>(null);

	const start: SubmitFunction = () => {
		busy = true;
		message = null;
		return async ({ result }) => {
			busy = false;
			if (result.type === 'failure') {
				const m = result.data?.message;
				message = typeof m === 'string' ? m : 'Dat lukte niet. Probeer het opnieuw.';
				return;
			}
			await applyAction(result);
		};
	};
</script>

{#if warranties.length > 0 || canStart}
	<section class="card warranty" aria-labelledby="warranty-title">
		<h2 id="warranty-title">Garantie</h2>
		{#if warranties.length > 0}
			<div class="links">
				{#each warranties as w (w.id)}
					<a class="more-link" href="/garantie/{w.id}"
						>{w.product}{w.status === 'afgedankt' ? ' (afgedankt)' : ''}</a
					>
				{/each}
			</div>
		{/if}
		{#if canStart}
			{#if open}
				<form method="POST" action="?/warranty" class="start" use:enhance={start}>
					{#each Object.entries(fields) as [name, value] (name)}
						<input type="hidden" {name} {value} />
					{/each}
					<label class="field">
						<span>Welk product?</span>
						<input
							name="product"
							maxlength="60"
							required
							autocomplete="off"
							placeholder="Bijvoorbeeld laptop"
						/>
					</label>
					<div class="actions">
						<button class="button" disabled={busy}>{busy ? 'Bijhouden…' : 'Bijhouden'}</button>
						<button type="button" class="button secondary" onclick={() => (open = false)}
							>Annuleren</button
						>
					</div>
					{#if message}<p class="error-text" role="alert">{message}</p>{/if}
				</form>
			{:else}
				<p class="muted small">
					De app bewaart het bewijs en meldt zich 30 dagen voor het einde van het eerste jaar.
				</p>
				<button type="button" class="button secondary small" onclick={() => (open = true)}
					>{warranties.length > 0 ? 'Nog een product bijhouden' : 'Garantie bijhouden'}</button
				>
			{/if}
		{/if}
	</section>
{/if}

<style>
	.warranty {
		display: grid;
		gap: 10px;
		justify-items: start;
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.start {
		display: grid;
		gap: 12px;
		width: 100%;
	}

	.field {
		display: grid;
		gap: 6px;
	}

	.field > span {
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

	.small {
		font-size: 0.9rem;
	}

	.button.small {
		min-height: var(--tap);
		padding: 0 14px;
		font-size: 0.92rem;
	}
</style>
