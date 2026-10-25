<script lang="ts">
	import { tick } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { fly } from 'svelte/transition';
	import BackLink from '#lib/components/BackLink.svelte';
	import HeroAmount from '#lib/components/HeroAmount.svelte';
	import OwedTabs from '#lib/components/OwedTabs.svelte';
	import Select, { type SelectOption } from '#lib/components/Select.svelte';
	import Toast from '#lib/components/Toast.svelte';
	import { formatShortDate } from '#lib/dates.ts';
	import { formatCents } from '#lib/money.ts';
	import { formatOpenFor } from '#lib/owed.ts';

	let { data, form } = $props();
	const o = $derived(data.overview);

	let adding = $state(false);
	let direction = $state<'te_krijgen' | 'te_betalen'>('te_krijgen');
	let newPerson = $state('');
	let busy = $state(false);
	let confirm = $state<string | null>(null);

	const peopleOptions = $derived<SelectOption[]>([
		{ value: '', label: 'Nieuwe persoon' },
		...data.people.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name }))
	]);
	const assignOptions = $derived<SelectOption[]>(
		data.people.filter((p) => p.active).map((p) => ({ value: p.id, label: p.name }))
	);

	const openCount = $derived(o.people.reduce((n, p) => n + p.posts.length, 0));
	const subtitle = $derived.by(() => {
		const parts: string[] = [];
		const owing = o.people.filter((p) => p.toReceiveCents > 0).length;
		if (owing > 0) parts.push(`van ${owing} ${owing === 1 ? 'persoon' : 'personen'}`);
		if (o.toPayCents > 0) parts.push(`jij moet nog ${formatCents(o.toPayCents)} betalen`);
		if (o.creditCents > 0) parts.push(`${formatCents(o.creditCents)} tegoed`);
		return parts.join(' · ');
	});

	const keep: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			await update({ reset: result.type === 'success' });
			busy = false;
			confirm = null;
			if (result.type === 'success' && result.data && 'added' in result.data) adding = false;
		};
	};

	async function openForm() {
		adding = true;
		if (!matchMedia('(pointer: fine)').matches) return;
		await tick();
		document.querySelector<HTMLInputElement>('#owed-amount')?.focus();
	}

	const feedback = $derived(
		form && 'message' in form && form.message
			? { text: form.message, error: true }
			: form && 'added' in form
				? { text: 'Post toegevoegd', error: false }
				: form && 'saved' in form
					? { text: 'Opgeslagen', error: false }
					: form && 'deleted' in form
						? { text: 'Post verwijderd', error: false }
						: form && 'restored' in form
							? { text: 'Kwijtschelden ongedaan gemaakt', error: false }
							: null
	);
	const statusText = { open: 'Open', deels: 'Deels betaald' };
</script>

<svelte:head>
	<title>Te krijgen · Budget</title>
</svelte:head>

<div class="page">
	<div class="intro">
		<BackLink parents={['/instellingen', '/']} />
		<h1 data-morph-head="titel">Te krijgen</h1>
		<OwedTabs current="te-krijgen" open={openCount} people={data.people.length} />
	</div>

	<div class="total">
		<HeroAmount cents={o.toReceiveCents} label="Nog te krijgen" morph="bedrag" />
		{#if subtitle}<p class="muted">{subtitle}</p>{/if}
		<p>
			<a href="/terugbetalingen"
				>Terugbetalingen van gedeelde vaste lasten{#if data.openShares > 0}: {data.openShares} open{/if}</a
			>
		</p>
	</div>

	{#if feedback}
		{#key form}<Toast text={feedback.text} error={feedback.error} />{/key}
	{/if}

	{#if form && 'forgiven' in form && form.forgiven}
		<form method="POST" action="?/unforgive" use:enhance={keep} class="card undo" role="status">
			<input type="hidden" name="id" value={form.forgiven} />
			<span>Kwijtgescholden; dat deel telt nu als jouw uitgave.</span>
			<button class="button secondary small" disabled={busy}>Ongedaan maken</button>
		</form>
	{/if}

	<section aria-label="Per persoon" class="people">
		{#each o.people as p (p.personId ?? 'onbekend')}
			<article class="card person" in:fly={{ y: 8, duration: 220 }}>
				<header>
					<h2>{p.name ?? 'Nog niet gekozen'}</h2>
					<div class="sum">
						{#if p.toReceiveCents > 0}
							<span class="num in">+{formatCents(p.toReceiveCents)}</span>
						{/if}
						{#if p.toPayCents > 0}
							<span class="num">{formatCents(-p.toPayCents)}</span>
						{/if}
					</div>
				</header>
				{#if p.personId === null}
					<p class="muted small">Je typte een aantal zonder namen. Kies per post wie het is.</p>
				{:else}
					{#if p.creditCents > 0}
						<p class="muted small">
							<span class="num">{formatCents(p.creditCents)}</span> tegoed; gaat naar de volgende post.
						</p>
					{/if}
					{#if p.paidAheadCents > 0}
						<p class="muted small">
							<span class="num">{formatCents(p.paidAheadCents)}</span> vooruitbetaald; gaat naar wat je
							nog moet betalen.
						</p>
					{/if}
				{/if}

				<ul class="posts">
					{#each p.posts as post (post.id)}
						<li>
							<div class="row">
								<div class="what">
									<span class="desc">
										{post.description ||
											(post.direction === 'te_krijgen' ? 'Voorgeschoten' : 'Te betalen')}
									</span>
									<span class="muted small">
										{post.direction === 'te_betalen' ? 'Jij betaalt · ' : ''}{formatShortDate(
											post.date
										)}
										· {post.daysOpen === 0 ? 'vandaag' : `${formatOpenFor(post.daysOpen)} open`}
										{#if post.status === 'deels'}· {statusText.deels}{/if}
									</span>
									{#if post.remind}
										<span class="remind"
											>Al {formatOpenFor(post.daysOpen)} open; tijd voor een herinnering</span
										>
									{/if}
								</div>
								<span class={['num', 'amount', post.direction === 'te_krijgen' && 'in']}>
									{post.direction === 'te_krijgen'
										? `+${formatCents(post.outstandingCents)}`
										: formatCents(-post.outstandingCents)}
								</span>
							</div>
							{#if post.tikkieUrl || post.note}
								<p class="extra">
									{#if post.tikkieUrl}
										<a href={post.tikkieUrl} target="_blank" rel="noopener noreferrer"
											>Tikkie openen</a
										>
									{/if}
									{#if post.note}<span class="muted">{post.note}</span>{/if}
								</p>
							{/if}
							<details class="more">
								<summary>Aanpassen</summary>
								<form method="POST" action="?/edit" use:enhance={keep} class="edit">
									<input type="hidden" name="id" value={post.id} />
									{#if post.personId === null}
										<div class="field">
											<label for="assign-{post.id}">Wie</label>
											<Select
												id="assign-{post.id}"
												name="personId"
												label="Wie"
												placeholder="Kies persoon"
												options={assignOptions}
												required
											/>
											{#if assignOptions.length === 0}
												<p class="muted small">
													Voeg eerst iemand toe bij <a href="/personen">Personen</a>.
												</p>
											{/if}
										</div>
									{/if}
									<label class="field">
										<span>Tikkie-link</span>
										<input
											name="tikkieUrl"
											type="url"
											inputmode="url"
											value={post.tikkieUrl ?? ''}
											placeholder="https://tikkie.me/…"
											maxlength="300"
											autocomplete="off"
										/>
									</label>
									<label class="field">
										<span>Notitie</span>
										<input name="note" value={post.note} maxlength="500" autocomplete="off" />
									</label>
									<div class="actions">
										<button class="button" disabled={busy}>Opslaan</button>
									</div>
								</form>
								<div class="danger-zone">
									{#if confirm === post.id}
										<p>
											{post.sourceTransactionId
												? `Kwijtschelden? ${formatCents(post.outstandingCents)} telt dan als jouw uitgave.`
												: 'Deze post kwijtschelden of verwijderen?'}
										</p>
									{/if}
									<div class="actions">
										{#if confirm === post.id}
											<form method="POST" action="?/forgive" use:enhance={keep}>
												<input type="hidden" name="id" value={post.id} />
												<button class="button danger small" disabled={busy}
													>Ja, kwijtschelden</button
												>
											</form>
											{#if !post.sourceTransactionId}
												<form method="POST" action="?/delete" use:enhance={keep}>
													<input type="hidden" name="id" value={post.id} />
													<button class="button danger small" disabled={busy}>Verwijderen</button>
												</form>
											{/if}
											<button
												type="button"
												class="button secondary small"
												onclick={() => (confirm = null)}>Annuleren</button
											>
										{:else}
											<button
												type="button"
												class="button danger small"
												onclick={() => (confirm = post.id)}
												>{post.sourceTransactionId
													? 'Kwijtschelden'
													: 'Kwijtschelden of verwijderen'}</button
											>
										{/if}
									</div>
								</div>
							</details>
						</li>
					{/each}
				</ul>
				{#if p.oldestDate}
					<p class="muted small since">
						Oudste post {formatShortDate(p.oldestDate)}
					</p>
				{/if}
			</article>
		{:else}
			<div class="empty">
				<h2>Niemand hoeft je iets te betalen</h2>
				<p class="muted">
					Schiet je iets voor, typ dan bij de uitgave <strong>met sanne</strong> of
					<strong>voor 3</strong>. Wat de anderen nog moeten, staat dan hier.
				</p>
				<a class="button secondary" href="/">Uitgave invoeren</a>
			</div>
		{/each}
	</section>

	<section aria-label="Nieuwe post" class="new">
		{#if !adding}
			<button class="button secondary small" onclick={openForm}>Nieuwe post</button>
			<p class="muted small">
				Voor iets zonder uitgave, zoals contant voorgeschoten of wat jij nog moet.
			</p>
		{:else}
			<form method="POST" action="?/add" use:enhance={keep} class="card add">
				<h3>Nieuwe post</h3>
				<fieldset class="field">
					<legend>Richting</legend>
					<div class="segmented">
						<label>
							<input type="radio" name="direction" value="te_krijgen" bind:group={direction} />
							<span>Ik krijg nog</span>
						</label>
						<label>
							<input type="radio" name="direction" value="te_betalen" bind:group={direction} />
							<span>Ik moet nog</span>
						</label>
					</div>
				</fieldset>
				<div class="grid">
					<div class="field">
						<label for="owed-person">{direction === 'te_krijgen' ? 'Van' : 'Aan'}</label>
						<Select
							id="owed-person"
							name="personId"
							label={direction === 'te_krijgen' ? 'Van' : 'Aan'}
							bind:value={newPerson}
							options={peopleOptions}
						/>
					</div>
					{#if newPerson === ''}
						<label class="field">
							<span>Naam</span>
							<input name="newName" maxlength="40" required autocomplete="off" />
						</label>
					{:else}
						<input type="hidden" name="newName" value="" />
					{/if}
					<label class="field">
						<span>Bedrag</span>
						<input
							id="owed-amount"
							name="amount"
							inputmode="decimal"
							placeholder="0,00"
							class="num"
							required
							autocomplete="off"
						/>
					</label>
					<label class="field">
						<span>Datum</span>
						<input type="date" name="date" value={data.today} required />
					</label>
				</div>
				<label class="field">
					<span>Waarvoor</span>
					<input name="description" maxlength="100" placeholder="Bioscoop" autocomplete="off" />
				</label>
				<label class="field">
					<span>Tikkie-link</span>
					<input
						name="tikkieUrl"
						type="url"
						inputmode="url"
						placeholder="Optioneel"
						maxlength="300"
						autocomplete="off"
					/>
				</label>
				<div class="actions">
					<button class="button" disabled={busy}>Toevoegen</button>
					<button type="button" class="button secondary" onclick={() => (adding = false)}
						>Sluiten</button
					>
				</div>
			</form>
		{/if}
	</section>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 28px;
		max-width: 44rem;
	}

	.intro,
	.total {
		display: grid;
		gap: 14px;
	}

	.total {
		gap: 4px;
	}

	.small {
		font-size: 0.88rem;
	}

	.button.small {
		min-height: var(--tap);
		padding: 0 14px;
		font-size: 0.92rem;
	}

	.undo {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.people {
		display: grid;
		gap: 16px;
	}

	@container (min-width: 900px) {
		.people {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			align-items: start;
		}
	}

	.person {
		display: grid;
		gap: 8px;
		padding: 18px;
	}

	.person header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.sum {
		display: grid;
		justify-items: end;
		font-size: 1.15rem;
		font-weight: 650;
	}

	.in {
		color: var(--accent-strong);
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.posts li {
		display: grid;
		gap: 2px;
		padding: 10px 0 2px;
		border-top: 1px solid var(--line);
	}

	.row {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.what {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
		overflow-wrap: anywhere;
	}

	.desc {
		font-weight: 550;
	}

	.amount {
		font-weight: 600;
		white-space: nowrap;
	}

	.remind {
		justify-self: start;
		margin-top: 4px;
		padding: 2px 10px;
		border-radius: 999px;
		background: color-mix(in oklch, var(--warn) 22%, transparent);
		font-size: 0.85rem;
		font-weight: 550;
	}

	.extra {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		font-size: 0.92rem;
	}

	.extra a {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		font-weight: 550;
	}

	.more summary {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		color: var(--accent-strong);
		font-weight: 550;
		cursor: pointer;
	}

	.edit,
	.add {
		display: grid;
		gap: 14px;
	}

	.add {
		padding: 18px;
	}

	.edit {
		padding-bottom: 10px;
	}

	.danger-zone {
		display: grid;
		gap: 8px;
		padding: 10px 0 12px;
	}

	.field {
		display: grid;
		gap: 6px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.field > span:first-child,
	.field > label,
	legend {
		font-weight: 550;
		font-size: 0.95rem;
	}

	legend {
		padding: 0;
		margin-bottom: 6px;
	}

	.field input {
		width: 100%;
	}

	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 14px;
	}

	@container (min-width: 560px) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.segmented {
		display: grid;
		grid-template-columns: 1fr 1fr;
		padding: 3px;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}

	.segmented label {
		position: relative;
		display: grid;
	}

	.segmented input {
		position: absolute;
		opacity: 0;
		inset: 0;
		min-height: 0;
		margin: 0;
		cursor: pointer;
	}

	.segmented span {
		display: grid;
		place-items: center;
		min-height: 40px;
		border-radius: 8px;
		font-size: 0.92rem;
		font-weight: 550;
		color: var(--muted);
		pointer-events: none;
	}

	.segmented input:checked + span {
		background: var(--surface);
		color: var(--text);
		box-shadow: 0 1px 3px oklch(0.2 0.01 85 / 0.14);
	}

	.segmented input:focus-visible + span {
		outline: 2px solid var(--focus);
		outline-offset: 1px;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.new {
		display: grid;
		gap: 6px;
		justify-items: start;
	}

	.new .add {
		justify-self: stretch;
	}

	.empty {
		display: grid;
		gap: 10px;
		justify-items: start;
		padding: 8px 0;
	}

	.since {
		padding-top: 6px;
		border-top: 1px solid var(--line);
	}
</style>
