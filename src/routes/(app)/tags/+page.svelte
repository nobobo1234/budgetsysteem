<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { page } from '$app/state';
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import IconBadge from '#lib/components/IconBadge.svelte';
	import Sheet from '#lib/components/Sheet.svelte';
	import StackedBar from '#lib/components/StackedBar.svelte';
	import TagFields from '#lib/components/TagFields.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { groupColor } from '#lib/categoryColor.ts';
	import * as icons from '#lib/icons.ts';
	import { formatCents } from '#lib/money.ts';
	import { formatPeriod, tagSegments, type TagState } from '#lib/tags.ts';

	let { data, form } = $props();

	let adding = $state(false);
	let busy = $state(false);

	const create: SubmitFunction = () => {
		busy = true;
		return async ({ update }) => {
			await update({ reset: false });
			busy = false;
		};
	};

	const STATE: Record<TagState, string> = { loopt: 'loopt', komt: 'komt nog', voorbij: '' };
	const plural = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;
	const NONE = 'color-mix(in oklch, var(--text) 28%, transparent)';
</script>

<svelte:head>
	<title>Tags · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<BackLink parents={['/instellingen', '/analyses']} />
		<h1 data-morph-head="titel">Tags</h1>
	</div>

	{#if form?.message}
		{#key form}<Toast text={form.message} error />{/key}
	{:else if page.url.searchParams.has('verwijderd')}
		<Toast text="Tag verwijderd" />
	{/if}

	{#if data.tags.length > 0}
		<ul class="tags" aria-label="Tags">
			{#each data.tags as t (t.id)}
				{@const segments = tagSegments(t.byCategory)}
				<li>
					<article class="card tag" aria-labelledby="tag-{t.id}">
						<div class="head">
							<IconBadge icon={icons.tags} hue={t.hue} />
							<h2 id="tag-{t.id}">
								<a href="/tags/{t.id}" class="stretch">{t.name}</a>
							</h2>
							<p class="total num">
								<span class="visually-hidden">Totaal </span>{formatCents(t.totalCents)}
							</p>
						</div>
						<p class="meta">
							{formatPeriod(t, data.today)}{#if STATE[t.state]}<span class="state"
									>{STATE[t.state]}</span
								>{/if}
							{#if t.count > 0}<span class="muted"
									>· {plural(t.count, 'transactie', 'transacties')}</span
								>{/if}
						</p>
						{#if segments.length > 0}
							<StackedBar
								label="Verdeling van {t.name} per categorie"
								segments={segments.map((s) => ({
									key: s.key,
									label: s.label,
									cents: s.cents,
									color: s.group ? (groupColor(s.group) ?? NONE) : NONE
								}))}
							/>
						{/if}
					</article>
				</li>
			{/each}
		</ul>
	{:else}
		<EmptyState
			icon={icons.tags}
			text="Nog geen tags. Maak er een voor een reis, zoals Lissabon van 12 tot 19 oktober, en alles wat je in die dagen uitgeeft telt vanzelf mee."
		/>
	{/if}

	<section aria-label="Nieuwe tag" class="new">
		<button class="button" onclick={() => (adding = true)}>
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
			Nieuwe tag
		</button>
	</section>

	<Sheet bind:open={adding} title="Nieuwe tag">
		<form method="POST" action="?/create" use:enhance={create} class="add">
			<p class="muted small">
				Elke transactie in deze dagen krijgt de tag vanzelf, ook wat je later invoert of importeert.
				Op een transactie zet je hem aan of uit.
			</p>
			<TagFields startDate={data.today} hue={data.hue} />
			<div class="actions">
				<button class="button" disabled={busy}>{busy ? 'Aanmaken…' : 'Aanmaken'}</button>
			</div>
		</form>
	</Sheet>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		max-width: 44rem;
	}

	.intro {
		display: grid;
		gap: 14px;
	}

	.tags {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 12px;
	}

	.tag {
		position: relative;
		display: grid;
		gap: 12px;
		transition: transform 220ms var(--ease-spring);
	}

	.tag:has(.stretch:active) {
		transform: scale(0.985);
	}

	.head {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
	}

	h2 {
		font-size: 1.25rem;
		overflow-wrap: anywhere;
	}

	.stretch {
		color: inherit;
		text-decoration: none;
	}

	/* De hele kaart is de link; de balk en de legenda blijven gewone inhoud */
	.stretch::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: var(--radius);
	}

	.stretch:focus-visible {
		outline: none;
	}

	.stretch:focus-visible::after {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	.total {
		font-size: 1.25rem;
		font-weight: 650;
		letter-spacing: -0.01em;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 8px;
	}

	.state {
		padding: 1px 8px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-strong);
		font-size: 0.85rem;
		font-weight: 600;
	}

	.new {
		display: grid;
		justify-items: start;
	}

	.new svg {
		width: 20px;
		height: 20px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}

	.add {
		display: grid;
		gap: 16px;
	}

	.small {
		font-size: 0.88rem;
	}

	.actions {
		display: flex;
		gap: 8px;
	}

	@media (prefers-reduced-motion: reduce) {
		.tag:has(.stretch:active) {
			transform: none;
		}
	}
</style>
