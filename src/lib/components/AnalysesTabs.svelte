<script lang="ts">
	// Wisselen tussen de vier pagina's van Analyses: de maand, de trend, het jaar en het vraagveld
	import PageTabs from './PageTabs.svelte';

	let { current }: { current: 'maand' | 'trend' | 'jaar' | 'vraag' } = $props();
</script>

<PageTabs
	label="Analyses"
	{current}
	tabs={[
		{ id: 'maand', href: '/analyses', label: 'Maand' },
		{ id: 'trend', href: '/analyses/trend', label: 'Trend' },
		{ id: 'jaar', href: '/analyses/jaar', label: 'Jaar' },
		{ id: 'vraag', href: '/analyses/vraag', label: 'Vraag' }
	]}
/>
