<script lang="ts">
	import { enhance } from '$app/forms';
	import Select from './Select.svelte';
	import type { TagChip } from '#lib/tags.ts';

	// Tags op een transactie (spec: Tags, Transactie): de tags rond de datum en die erop staan
	// als chips in hun tint; één tik zet een tag aan of uit. Een retour volgt de tags van zijn
	// uitgave en heeft geen eigen chips.
	let {
		chips,
		others,
		follows,
		message
	}: {
		chips: TagChip[];
		others: { id: string; name: string; hue: number }[];
		follows: { id: string; name: string; hue: number }[];
		message?: string;
	} = $props();

	let busy = $state(false);
	let picked = $state('');
	let pickForm = $state<HTMLFormElement>();

	const names = (list: { name: string }[]) =>
		list.length <= 1
			? (list[0]?.name ?? '')
			: `${list
					.slice(0, -1)
					.map((t) => t.name)
					.join(', ')} en ${list.at(-1)!.name}`;

	const submit = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = false;
			picked = '';
		};
	};
</script>

<section class="card tags" aria-labelledby="tags-title">
	<h2 id="tags-title">Tags</h2>
	{#if follows.length > 0}
		<p class="muted small">
			Telt mee bij {names(follows)}, via de uitgave waar deze retour bij hoort.
		</p>
	{:else}
		{#if chips.length > 0}
			<ul class="chips">
				{#each chips as chip (chip.id)}
					<li>
						<form method="POST" action="?/tag" use:enhance={submit}>
							<input type="hidden" name="tagId" value={chip.id} />
							<input type="hidden" name="on" value={chip.on ? '0' : '1'} />
							<button
								class={['chip', 'hue', chip.on && 'on']}
								style:--h={chip.hue}
								aria-pressed={chip.on}
								disabled={busy}
							>
								<svg viewBox="0 0 16 16" aria-hidden="true">
									{#if chip.on}
										<path d="M3.5 8.5l3 3 6-7" />
									{:else}
										<path d="M8 3.5v9M3.5 8h9" />
									{/if}
								</svg>
								{chip.name}
								{#if chip.manual}<span class="visually-hidden">(zelf gekozen)</span>{/if}
							</button>
						</form>
					</li>
				{/each}
			</ul>
			<p class="muted small">
				Een tik zet een tag aan of uit; uit blijft uit, ook als de periode verandert.
			</p>
		{:else}
			<p class="muted small">Geen tag rond deze datum.</p>
		{/if}
		{#if others.length > 0}
			<form method="POST" action="?/tag" use:enhance={submit} bind:this={pickForm} class="pick">
				<input type="hidden" name="tagId" value={picked} />
				<input type="hidden" name="on" value="1" />
				<Select
					variant="chip"
					label="Andere tag"
					placeholder="Andere tag"
					bind:value={picked}
					disabled={busy}
					options={others.map((t) => ({
						value: t.id,
						label: t.name,
						dot: `oklch(var(--dot-l) var(--dot-c) ${t.hue})`
					}))}
					onchange={() => pickForm?.requestSubmit()}
				/>
			</form>
		{/if}
	{/if}
	{#if message}<p class="error-text" role="alert">{message}</p>{/if}
</section>

<style>
	.tags {
		display: grid;
		gap: 12px;
		padding: 20px;
	}

	.small {
		font-size: 0.88rem;
	}

	.chips {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: var(--tap);
		padding: 0 14px 0 10px;
		border: 1.5px dashed color-mix(in oklch, var(--ink) 55%, transparent);
		border-radius: 999px;
		background: transparent;
		color: var(--muted);
		font-weight: 550;
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.chip.on {
		border: 1.5px solid transparent;
		background: var(--wash);
		color: var(--ink);
	}

	.chip:active {
		transform: scale(0.96);
	}

	.chip svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.pick {
		justify-self: start;
	}

	@media (prefers-reduced-motion: reduce) {
		.chip:active {
			transform: none;
		}
	}
</style>
