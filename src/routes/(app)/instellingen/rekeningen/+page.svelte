<script lang="ts">
	import { enhance } from '$app/forms';
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Toast from '#lib/components/Toast.svelte';

	let { data, form } = $props();
</script>

<svelte:head>
	<title>Rekeningen · Budget</title>
</svelte:head>

<div class="page">
	<header>
		<BackLink parents={['/instellingen']} />
		<h1 data-morph-head="titel">Rekeningen</h1>
		<p class="muted">
			De alias gebruik je in de snelinvoer, zoals <strong>@rev</strong>. Met het IBAN worden
			overboekingen tussen je eigen rekeningen herkend.
		</p>
	</header>

	{#if form && 'message' in form && form.message}<p class="error-text" role="alert">
			{form.message}
		</p>{/if}

	{#each data.accounts as a (a.id)}
		<form method="POST" action="?/account" use:enhance class="card account">
			<input type="hidden" name="id" value={a.id} />
			<label><span>Naam</span><input name="name" value={a.name} maxlength="40" required /></label>
			<label><span>Alias</span><input name="alias" value={a.alias} maxlength="10" required /></label
			>
			<label><span>IBAN</span><input name="iban" value={a.iban ?? ''} maxlength="42" /></label>
			<button class="button secondary">Opslaan</button>
		</form>
	{:else}
		<div class="card">
			<EmptyState
				icon="rekeningen"
				text="Nog geen rekeningen. Ze komen erbij met je eerste import."
			>
				<a class="button secondary" href="/import">Naar de import</a>
			</EmptyState>
		</div>
	{/each}

	{#if form && 'ok' in form && form.ok}
		{#key form}<Toast text="Rekening opgeslagen." />{/key}
	{/if}
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
		max-width: 44rem;
	}

	header {
		display: grid;
		gap: 8px;
	}

	.account {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.account label {
		display: grid;
		gap: 4px;
	}

	.account label:nth-of-type(3),
	.account button {
		grid-column: 1 / -1;
	}
</style>
