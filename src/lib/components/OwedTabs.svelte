<script lang="ts">
	// Te krijgen en Personen horen bij elkaar: een tab-schakelaar met het aantal per pagina
	import PageTabs from './PageTabs.svelte';

	let {
		current,
		open,
		people
	}: { current: 'te-krijgen' | 'personen'; open: number; people: number } = $props();
</script>

<PageTabs
	label="Te krijgen"
	{current}
	tabs={[
		{ id: 'te-krijgen', href: '/te-krijgen', label: 'Te krijgen', count: open },
		{ id: 'personen', href: '/personen', label: 'Personen', count: people }
	]}
/>
