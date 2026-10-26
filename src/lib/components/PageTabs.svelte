<script lang="ts">
	// Wisselen tussen pagina's binnen één onderwerp, elk met hun aantal als dat iets zegt (spec:
	// Componenten, Tabs)
	let {
		label,
		current,
		tabs
	}: {
		label: string;
		current: string;
		tabs: { id: string; href: string; label: string; count?: number }[];
	} = $props();
</script>

<nav aria-label={label} style:--tabs={tabs.length}>
	{#each tabs as tab (tab.id)}
		<a href={tab.href} aria-current={tab.id === current ? 'page' : undefined}>
			{tab.label}
			{#if tab.count !== undefined}<span class="num">{tab.count}</span>{/if}
		</a>
	{/each}
</nav>

<style>
	nav {
		display: grid;
		grid-template-columns: repeat(var(--tabs), minmax(0, 1fr));
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
		min-height: var(--tap);
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
