<script lang="ts">
	import { HUE_NAMES, TAG_HUES } from '#lib/tags.ts';
	import Switch from './Switch.svelte';

	// Velden van een tag (spec: Tags), voor de sheet op Tags en het formulier op de tagpagina:
	// naam, periode met "loopt door" en een tint uit de vaste reeks.
	let {
		name = '',
		startDate,
		endDate = null,
		hue
	}: { name?: string; startDate: string; endDate?: string | null; hue: number } = $props();

	const uid = $props.id();
	// Beginwaarden uit de props; daarna houdt het formulier ze zelf bij
	// svelte-ignore state_referenced_locally
	let open = $state(endDate === null);
	// svelte-ignore state_referenced_locally
	let start = $state(startDate);
	// svelte-ignore state_referenced_locally
	let end = $state(endDate ?? startDate);
</script>

<label class="field">
	<span>Naam</span>
	<input
		id="{uid}-name"
		name="name"
		value={name}
		maxlength="40"
		required
		autocomplete="off"
		placeholder="Lissabon"
	/>
</label>

<div class="row">
	<label class="field">
		<span>Van</span>
		<input type="date" name="startDate" bind:value={start} required />
	</label>
	{#if !open}
		<label class="field">
			<span>Tot en met</span>
			<input type="date" name="endDate" bind:value={end} min={start} required />
		</label>
	{/if}
</div>

<Switch
	name="open"
	bind:checked={open}
	hint="Tot je hem afsluit; alles wat erbij komt krijgt de tag">Loopt door</Switch
>

<fieldset class="field">
	<legend>Kleur</legend>
	<div class="hues">
		{#each TAG_HUES as h (h)}
			<label class="hue-option" style:--h={h}>
				<input type="radio" name="hue" value={h} checked={h === hue} />
				<span class="swatch" aria-hidden="true"></span>
				<span class="visually-hidden">{HUE_NAMES[h]}</span>
			</label>
		{/each}
	</div>
</fieldset>

<style>
	.field {
		display: grid;
		gap: 6px;
		align-content: start;
		min-width: 0;
	}

	.field > span,
	legend {
		font-weight: 550;
		font-size: 0.95rem;
	}

	.field input:not([type='radio']) {
		width: 100%;
	}

	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 140px), 1fr));
		gap: 12px;
	}

	fieldset {
		margin: 0;
		padding: 0;
		border: 0;
	}

	legend {
		padding: 0;
		margin-bottom: 6px;
	}

	.hues {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.hue-option {
		position: relative;
		display: grid;
		place-items: center;
		width: var(--tap);
		height: var(--tap);
		cursor: pointer;
	}

	.hue-option input {
		position: absolute;
		inset: 0;
		min-height: 0;
		margin: 0;
		opacity: 0;
		cursor: pointer;
	}

	.swatch {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: oklch(var(--dot-l) var(--dot-c) var(--h));
		transition: transform 180ms var(--ease-spring);
	}

	.hue-option input:checked + .swatch {
		transform: scale(1.12);
		box-shadow:
			0 0 0 3px var(--surface),
			0 0 0 5px oklch(var(--dot-l) var(--dot-c) var(--h));
	}

	.hue-option input:focus-visible + .swatch {
		outline: 2px solid var(--focus);
		outline-offset: 6px;
	}

	@media (prefers-reduced-motion: reduce) {
		.swatch {
			transition: none;
		}
	}
</style>
