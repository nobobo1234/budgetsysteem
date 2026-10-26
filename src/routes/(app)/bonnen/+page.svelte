<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { fade } from 'svelte/transition';
	import BackLink from '#lib/components/BackLink.svelte';
	import EmptyState from '#lib/components/EmptyState.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { formatShortDate } from '#lib/dates.ts';
	import * as icons from '#lib/icons.ts';
	import { motion } from '#lib/motion.ts';
	import { UploadError, uploadReceipt } from '#lib/receipt-upload.ts';
	import { STAGE_TEXT, itemCountText, needsYou, receiptAmount } from '#lib/receipts.ts';
	import { displayName } from '#lib/text.ts';

	// Bonnen (spec: Schermen, Bonnetjes en koppelen): een foto of screenshot kiezen, en de laatste
	// bonnen met hun stand. Een nieuwe bon staat er meteen, met een rustige laadstaat die overgaat
	// in de herkende velden zodra Haiku klaar is.

	let { data } = $props();

	let input: HTMLInputElement;
	/** Bonnen die nog onderweg zijn naar de server */
	let sending = $state(0);
	let toast = $state<{ text: string; error: boolean; key: number } | null>(null);
	const notify = (text: string, error = false) => (toast = { text, error, key: Date.now() });

	async function chosen() {
		const files = [...(input.files ?? [])].slice(0, 10);
		input.value = '';
		for (const file of files) {
			sending++;
			try {
				await uploadReceipt(file);
				await invalidate('app:bonnen');
				notify(
					files.length > 1
						? 'Bonnen ontvangen; ze worden gelezen.'
						: 'Bon ontvangen; hij wordt gelezen.'
				);
			} catch (e) {
				notify(
					e instanceof UploadError ? e.message : 'Uploaden lukte niet. Probeer het opnieuw.',
					true
				);
			} finally {
				sending--;
			}
		}
	}

	// Zolang er een bon gelezen wordt, elke twee seconden kijken (hooguit drie minuten)
	const reading = $derived(data.receipts.some((r) => r.stage === 'wordt_gelezen'));
	$effect(() => {
		if (!reading) return;
		// Pas na een verversing de volgende plannen, zodat ze elkaar nooit afbreken
		const started = Date.now();
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		const next = () => {
			if (stopped || Date.now() - started > 180_000) return;
			timer = setTimeout(() => void invalidate('app:bonnen').finally(next), 2000);
		};
		next();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});
</script>

<svelte:head>
	<title>Bonnen · Budget</title>
</svelte:head>

{#snippet skeleton(label: string)}
	<span class="who reading" role="status">
		<span class="bar wide"></span>
		<span class="bar narrow"></span>
		<span class="visually-hidden">{label}</span>
	</span>
	<span class="bar amount-bar" aria-hidden="true"></span>
{/snippet}

<div class="page">
	<div class="intro">
		<BackLink parents={['/instellingen', '/te-controleren', '/']} />
		<h1 data-morph-head="titel">Bonnen</h1>
		<p class="tell">
			Haiku leest hem op de achtergrond; wat niet zeker is, komt bij Te controleren.
		</p>
	</div>

	<section class="card upload" aria-label="Bon toevoegen">
		<input
			bind:this={input}
			type="file"
			accept="image/*"
			multiple
			hidden
			data-testid="bon-bestand"
			onchange={chosen}
		/>
		<button class="button" onclick={() => input.click()} disabled={sending > 0}>
			{sending > 0 ? 'Versturen…' : 'Foto of screenshot kiezen'}
		</button>
		<p class="muted small">
			Je browser verkleint hem tot 2576 pixels en haalt de gegevens van de foto eraf.
		</p>
		<a class="more-link" href="/instellingen/apparaten">Via het deelmenu</a>
	</section>

	{#if data.receipts.length > 0 || sending > 0}
		<section class="group" aria-labelledby="recent-title">
			<h2 id="recent-title">Recent</h2>
			<ul class="card list">
				{#each { length: sending }, i (i)}
					<li>
						<div class="row">
							<span class="thumb" aria-hidden="true"></span>
							{@render skeleton('Wordt verstuurd')}
						</div>
					</li>
				{/each}
				{#each data.receipts as r (r.id)}
					{@const name =
						r.kind === 'lijst' ? 'Screenshot' : r.store ? displayName(r.store) || r.store : 'Bon'}
					<li>
						<a class="row" href="/bonnen/{r.id}">
							<img
								class="thumb"
								src="/api/receipts/{r.id}/image?formaat=klein"
								alt=""
								width="48"
								height="48"
								loading="lazy"
								decoding="async"
							/>
							{#if r.stage === 'wordt_gelezen'}
								{@render skeleton('Wordt gelezen')}
							{:else}
								<span class="who" in:fade={{ duration: motion(240) }}>
									<span class="name">{name}</span>
									<span class="muted small">
										<span class={['state', needsYou(r.stage) && 'warn']} aria-hidden="true"></span>
										{r.kind === 'lijst'
											? `Ontvangen ${formatShortDate(r.createdAt.slice(0, 10))}`
											: r.date
												? formatShortDate(r.date)
												: 'Zonder datum'} · {STAGE_TEXT[r.stage]}
										{#if r.source === 'deelmenu'}· via deelmenu{/if}
									</span>
								</span>
								<span class="num amount" in:fade={{ duration: motion(240) }}
									>{r.kind === 'lijst'
										? itemCountText(r.itemCount)
										: receiptAmount(r.totalCents, r.currency)}</span
								>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{:else}
		<div class="card">
			<EmptyState
				icon={icons.bonnen}
				text="Nog geen bonnen. Kies een foto of screenshot, of stuur er een via het deelmenu."
				compact
			/>
		</div>
	{/if}

	{#if toast}
		{#key toast.key}<Toast text={toast.text} error={toast.error} />{/key}
	{/if}
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
		gap: 8px;
		justify-items: start;
	}

	.upload {
		display: grid;
		gap: 10px;
		justify-items: start;
	}

	.small {
		font-size: 0.88rem;
	}

	.group {
		display: grid;
		gap: 8px;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0 16px;
		display: grid;
	}

	.list > li + li {
		border-top: 1px solid var(--line);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 64px;
		padding: 8px 0;
		color: inherit;
		text-decoration: none;
		transition: transform 160ms var(--ease-spring);
	}

	a.row:active {
		transform: scale(0.99);
	}

	.thumb {
		flex: none;
		width: 48px;
		height: 48px;
		border-radius: var(--radius-sm);
		object-fit: cover;
		background: var(--surface-2);
	}

	.who {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
		overflow-wrap: anywhere;
	}

	.name {
		font-weight: 560;
	}

	.amount {
		font-weight: 600;
		white-space: nowrap;
	}

	/* Stip voor de stand: oranje als de bon iets van je vraagt */
	.state {
		display: inline-block;
		margin-right: 4px;
		vertical-align: 1px;
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--accent);
	}

	.state.warn {
		background: var(--warn);
	}

	/* Rustige laadstaat: grijze balken die zacht ademen (alleen opacity) */
	.reading {
		gap: 6px;
	}

	.bar {
		display: block;
		height: 12px;
		border-radius: 999px;
		background: var(--line);
		animation: breathe 1.6s ease-in-out infinite alternate;
	}

	.wide {
		width: min(60%, 14rem);
	}

	.narrow {
		width: min(40%, 9rem);
		animation-delay: 200ms;
	}

	.amount-bar {
		flex: none;
		width: 4rem;
		animation-delay: 400ms;
	}

	@keyframes breathe {
		from {
			opacity: 1;
		}
		to {
			opacity: 0.4;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.bar {
			animation: none;
		}
	}
</style>
