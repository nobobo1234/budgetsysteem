<script lang="ts">
	// Wisselen tussen de drie pagina's van Analyses: de maand, de trend en het jaar
	import PageTabs from './PageTabs.svelte';

	let { current }: { current: 'maand' | 'trend' | 'jaar' } = $props();
</script>

<PageTabs
	label="Analyses"
	{current}
	tabs={[
		{ id: 'maand', href: '/analyses', label: 'Maand' },
		{ id: 'trend', href: '/analyses/trend', label: 'Trend' },
		{ id: 'jaar', href: '/analyses/jaar', label: 'Jaar' }
	]}
/>
