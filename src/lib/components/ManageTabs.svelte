<script lang="ts">
	// Wisselen tussen de beheerpagina's voor categorieën en regels, elk met hun aantal
	let {
		current,
		categories,
		rules
	}: { current: 'categorieen' | 'regels'; categories: number; rules: number } = $props();

	const tabs = $derived([
		{ id: 'categorieen', href: '/categorieen', label: 'Categorieën', count: categories },
		{ id: 'regels', href: '/regels', label: 'Regels', count: rules }
	]);
</script>

<nav aria-label="Beheer">
	{#each tabs as tab (tab.id)}
		<a href={tab.href} aria-current={tab.id === current ? 'page' : undefined}>
			{tab.label}
			<span class="num">{tab.count}</span>
		</a>
	{/each}
</nav>

<style>
	nav {
		display: grid;
		grid-template-columns: 1fr 1fr;
		padding: 4px;
		border-radius: 999px;
		background: var(--surface-2);
		max-width: 22rem;
	}

	a {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 40px;
		border-radius: 999px;
		color: var(--muted);
		font-weight: 550;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	a:active {
		transform: scale(0.97);
	}

	a[aria-current='page'] {
		background: var(--surface);
		color: var(--text);
		box-shadow: 0 1px 3px oklch(0.2 0.01 85 / 0.14);
	}

	.num {
		font-size: 0.9rem;
		color: var(--muted);
	}
</style>
