<script lang="ts">
	import TransactionItem from '#lib/components/TransactionItem.svelte';

	let { data } = $props();

	const pageHref = (p: number) => {
		const parts: [string, string][] = [
			['q', data.filter.q],
			['maand', data.filter.month],
			['categorie', data.filter.categoryId],
			['status', data.filter.status ?? ''],
			['pagina', p > 0 ? String(p) : '']
		];
		const query = parts
			.filter(([, v]) => v)
			.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
			.join('&');
		return `?${query}`;
	};
</script>

<svelte:head>
	<title>Transacties · Budget</title>
</svelte:head>

<div class="page">
	<h1>{data.filter.status ? 'Te controleren' : 'Transacties'}</h1>

	<form method="GET" class="filters" data-sveltekit-keepfocus data-sveltekit-replacestate>
		<label class="search">
			<span class="visually-hidden">Zoeken</span>
			<input
				type="search"
				name="q"
				value={data.filter.q}
				placeholder="Zoek op naam, omschrijving of notitie"
				maxlength="100"
			/>
		</label>
		<label>
			<span class="visually-hidden">Maand</span>
			<input type="month" name="maand" value={data.filter.month} />
		</label>
		<label>
			<span class="visually-hidden">Categorie</span>
			<select name="categorie" value={data.filter.categoryId}>
				<option value="">Alle categorieën</option>
				<option value="geen">Zonder categorie</option>
				{#each data.categories as c (c.id)}
					<option value={c.id}>{c.name}</option>
				{/each}
			</select>
		</label>
		{#if data.filter.status}<input type="hidden" name="status" value={data.filter.status} />{/if}
		<button class="button secondary">Zoeken</button>
	</form>

	{#if data.transactions.length === 0}
		<div class="empty">
			<p>Niets gevonden{data.filter.q ? ` voor "${data.filter.q}"` : ''}.</p>
			<a href="/transacties">Filters wissen</a>
		</div>
	{:else}
		<ul>
			{#each data.transactions as tx (tx.id)}
				<li><TransactionItem {tx} href="/transacties/{tx.id}" /></li>
			{/each}
		</ul>
	{/if}

	<nav class="pager" aria-label="Pagina's">
		{#if data.page > 0}<a href={pageHref(data.page - 1)}>Nieuwer</a>{/if}
		{#if data.hasMore}<a href={pageHref(data.page + 1)}>Ouder</a>{/if}
	</nav>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 20px;
	}

	.filters {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.search {
		grid-column: 1 / -1;
	}

	.filters input,
	.filters select {
		width: 100%;
	}

	.filters .button {
		grid-column: 1 / -1;
	}

	@container (min-width: 700px) {
		.filters {
			grid-template-columns: 2fr 1fr 1fr auto;
		}

		.search,
		.filters .button {
			grid-column: auto;
		}
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li + li {
		border-top: 1px solid var(--line);
	}

	.empty {
		display: grid;
		gap: 8px;
		justify-items: start;
	}

	.pager {
		display: flex;
		justify-content: space-between;
	}

	.pager a {
		min-height: var(--tap);
		display: inline-flex;
		align-items: center;
	}
</style>
