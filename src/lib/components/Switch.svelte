<script lang="ts">
	// Schakelaar (spec: Componenten): een checkbox met role="switch", zodat formulieren en het
	// toetsenbord gewoon werken.
	import type { Snippet } from 'svelte';

	let {
		name,
		checked = $bindable(false),
		children,
		hint
	}: { name: string; checked?: boolean; children: Snippet; hint?: string } = $props();
</script>

<label class="switch">
	<input type="checkbox" role="switch" {name} bind:checked />
	<span class="track" aria-hidden="true"></span>
	<span class="text">
		{@render children()}
		{#if hint}<span class="muted small">{hint}</span>{/if}
	</span>
</label>

<style>
	.switch {
		position: relative;
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: var(--tap);
		cursor: pointer;
	}

	.text {
		display: grid;
	}

	.small {
		font-size: 0.88rem;
	}

	input {
		position: absolute;
		opacity: 0;
		width: 44px;
		height: 26px;
		min-height: 0;
		margin: 0;
		cursor: pointer;
	}

	.track {
		position: relative;
		flex: none;
		width: 44px;
		height: 26px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--text) 22%, transparent);
	}

	.track::after {
		content: '';
		position: absolute;
		top: 3px;
		left: 3px;
		width: 20px;
		height: 20px;
		border-radius: 999px;
		background: #fff;
		box-shadow: 0 1px 3px oklch(0.2 0.01 85 / 0.25);
		transition: transform 220ms var(--ease-spring);
	}

	input:checked + .track {
		background: var(--accent);
	}

	input:checked + .track::after {
		transform: translateX(18px);
	}

	input:focus-visible + .track {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
</style>
