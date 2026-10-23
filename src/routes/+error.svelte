<script lang="ts">
	import { page } from '$app/state';
</script>

<main>
	{#if page.status === 401}
		<h1>Je bent uitgelogd</h1>
		<p class="muted">Je sessie is verlopen of ingetrokken.</p>
		<a class="button" href="/login" data-sveltekit-reload>Opnieuw inloggen</a>
	{:else if page.status === 404}
		<h1>Deze pagina bestaat niet</h1>
		<p class="muted">Misschien is de link oud.</p>
		<a class="button" href="/">Naar het overzicht</a>
	{:else}
		<h1>Er ging iets mis</h1>
		<p class="muted">
			{page.error?.message ?? 'Onbekende fout.'}
			{#if page.error?.errorId}
				Foutcode <span class="num">{page.error.errorId.slice(0, 8)}</span>.
			{/if}
		</p>
		<a class="button" href="/" data-sveltekit-reload>Opnieuw proberen</a>
	{/if}
</main>

<style>
	main {
		max-width: 32rem;
		margin: 0 auto;
		padding: 15vh 16px 32px;
		display: grid;
		gap: 16px;
		justify-items: start;
	}
</style>
