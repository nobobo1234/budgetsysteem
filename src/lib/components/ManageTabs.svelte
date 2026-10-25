<script lang="ts">
	// Wisselen tussen de beheerpagina's voor categorieën en regels, elk met hun aantal
	import PageTabs from './PageTabs.svelte';

	let {
		current,
		categories,
		rules
	}: { current: 'categorieen' | 'regels'; categories: number; rules: number } = $props();
</script>

<PageTabs
	label="Beheer"
	{current}
	tabs={[
		{ id: 'categorieen', href: '/categorieen', label: 'Categorieën', count: categories },
		{ id: 'regels', href: '/regels', label: 'Regels', count: rules }
	]}
/>
