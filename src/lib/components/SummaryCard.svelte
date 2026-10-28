<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import {
		amount,
		NOTHING_NOTABLE,
		reasonText,
		sinceText,
		type MonthSummary
	} from '#lib/summary.ts';

	// Wat opviel (spec: Maandsamenvatting, Tonen): de zinnen als gewone tekst, nooit als HTML. Een
	// tik op een zin toont zijn cijfers; per zin met één tik "klopt niet"; "Opnieuw" zolang het mag.

	let {
		summary,
		busy,
		act
	}: {
		summary: MonthSummary;
		busy: string | null;
		act: (key: string, done: string) => SubmitFunction;
	} = $props();

	let open = $state<number | null>(null);
	const byId = $derived(new Map(summary.facts.map((f) => [f.id, f])));
	const canAgain = $derived(
		summary.source !== 'leeg' && summary.callsLeft > 0 && summary.reason !== 'geen_sleutel'
	);
</script>

<section class="card summary" aria-labelledby="summary-title">
	<div class="section-head">
		<h2 id="summary-title">Wat opviel</h2>
		{#if canAgain}
			<form
				method="POST"
				action="?/summaryAgain"
				use:enhance={act('summary-again', 'Opnieuw geschreven.')}
			>
				<button class="button secondary" disabled={busy !== null}>
					{busy === 'summary-again' ? 'Schrijft…' : 'Opnieuw'}
				</button>
			</form>
		{/if}
	</div>

	{#if summary.source === 'leeg'}
		<p class="tell">{NOTHING_NOTABLE}</p>
	{:else}
		<ul class="sentences" class:dim={busy === 'summary-again'}>
			{#each summary.sentences as s, i (i)}
				<li>
					<div class="row">
						<button
							type="button"
							class="sentence tell"
							aria-expanded={open === i}
							aria-controls="feiten-{i}"
							onclick={() => (open = open === i ? null : i)}
						>
							{#each s.delen as d, j (j)}{#if d.num}<span class="num">{d.text}</span
									>{:else}{d.text}{/if}{/each}
						</button>
						{#if s.wrong}
							<span class="flag marked" title="Gemeld als niet kloppend">
								<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4h11l-2 4 2 4H6" /></svg>
								<span class="visually-hidden">Gemeld als niet kloppend</span>
							</span>
						{:else}
							<form
								method="POST"
								action="?/summaryWrong"
								use:enhance={act(`wrong-${i}`, 'Gemeld: deze zin klopt niet.')}
							>
								<input type="hidden" name="index" value={i} />
								<button
									class="flag"
									disabled={busy !== null}
									aria-label="Zin {i + 1} klopt niet"
									title="Klopt niet"
								>
									<svg viewBox="0 0 24 24" aria-hidden="true"
										><path d="M6 21V4h11l-2 4 2 4H6" /></svg
									>
								</button>
							</form>
						{/if}
					</div>
					{#if open === i}
						<dl class="facts" id="feiten-{i}">
							{#each s.feiten as id (id)}
								{@const f = byId.get(id)}
								{#if f}
									<div>
										<dt>{f.naam}</dt>
										<dd>
											<span class="num">{amount(f.nu)}</span> deze maand, gemiddeld
											<span class="num">{amount(f.gem3)}</span> over drie en
											<span class="num">{amount(f.gem6)}</span> over zes maanden{#if f.sinds},
												{f.richting === 'hoger' ? 'stijgend' : 'dalend'} sinds {sinceText(
													f.sinds,
													summary.month
												)}{/if}.
										</dd>
									</div>
								{/if}
							{/each}
						</dl>
					{/if}
				</li>
			{/each}
		</ul>
		<p class="muted note">
			{summary.source === 'haiku'
				? 'Geschreven door Haiku uit de cijfers hieronder.'
				: reasonText(summary.reason)}
		</p>
	{/if}
</section>

<style>
	.summary {
		display: grid;
		align-content: start;
		gap: 14px;
		padding: 20px;
	}

	.section-head {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		align-items: center;
		gap: 4px 12px;
	}

	.sentences {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
		transition: opacity 160ms var(--ease-out);
	}

	.sentences.dim {
		opacity: 0.55;
	}

	.row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}

	.sentence {
		flex: 1;
		min-width: 0;
		min-height: var(--tap);
		padding: 8px 0;
		border: 0;
		background: none;
		color: var(--text);
		text-align: start;
		overflow-wrap: anywhere;
		cursor: pointer;
	}

	.sentence[aria-expanded='true'] {
		color: var(--accent-strong);
	}

	.flag {
		display: grid;
		place-items: center;
		flex: none;
		width: var(--tap);
		height: var(--tap);
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: none;
		color: var(--muted);
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.flag:active {
		transform: scale(0.9);
	}

	.flag[disabled] {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.flag.marked {
		color: var(--danger);
		cursor: default;
	}

	.flag svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.flag.marked svg {
		fill: currentColor;
	}

	.facts {
		display: grid;
		gap: 8px;
		margin: 0 0 8px;
		padding: 12px 14px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		font-size: 0.92rem;
	}

	.facts dt {
		font-weight: 600;
	}

	.facts dd {
		margin: 0;
	}

	.note {
		font-size: 0.88rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.sentences {
			transition: none;
		}
	}
</style>
