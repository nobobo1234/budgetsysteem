<script lang="ts">
	import { ICONS, type IconName } from '#lib/icons.ts';
	import { formatCents } from '#lib/money.ts';

	let { data } = $props();
	const t = $derived(data.tiles);

	const plural = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;
	const names = (list: string[]) =>
		list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} en ${list.at(-1)}`;

	interface Tile {
		href: string;
		title: string;
		value: string;
		icon: IconName;
		/** Vraagt aandacht: stip en waarschuwende waarde */
		warn?: boolean;
	}

	const groups = $derived<{ title: string; tiles: Tile[] }[]>([
		{
			title: 'Geld',
			tiles: [
				{
					href: '/te-krijgen',
					title: 'Te krijgen',
					value:
						t.owed.toReceiveCents > 0
							? `${formatCents(t.owed.toReceiveCents)} van ${plural(t.owed.people, 'persoon', 'personen')}`
							: 'Niets open',
					icon: 'teKrijgen'
				},
				{
					href: '/terugbetalingen',
					title: 'Terugbetalingen',
					value:
						t.shares.arrearsCents > 0
							? `${formatCents(t.shares.arrearsCents)} achterstand`
							: t.shares.lasts > 0
								? plural(t.shares.lasts, 'gedeelde last', 'gedeelde lasten')
								: 'Nog niets gedeeld',
					icon: 'terugbetalingen',
					warn: t.shares.arrearsCents > 0
				},
				{
					href: '/vaste-lasten',
					title: 'Vaste lasten',
					value:
						t.fixed.proposals > 0
							? plural(t.fixed.proposals, 'voorstel', 'voorstellen') + ' om te bekijken'
							: t.fixed.active > 0
								? `${formatCents(t.fixed.perMonthCents, { whole: true })} per maand`
								: 'Nog geen',
					icon: 'vasteLasten'
				},
				{
					href: '/saldocheck',
					title: 'Saldocheck',
					value:
						t.balanceDue.length > 0
							? `Nog te doen voor ${names(t.balanceDue)}`
							: 'Gedaan deze maand',
					icon: 'saldocheck',
					warn: t.balanceDue.length > 0
				}
			]
		},
		{
			title: 'Ordenen',
			tiles: [
				{
					href: '/categorieen',
					title: 'Categorieën',
					value: plural(t.categories, 'categorie', 'categorieën'),
					icon: 'categorieen'
				},
				{
					href: '/regels',
					title: 'Regels',
					value: t.rules > 0 ? plural(t.rules, 'regel', 'regels') : 'Nog geen regels',
					icon: 'regels'
				},
				{
					href: '/personen',
					title: 'Personen',
					value: t.people > 0 ? plural(t.people, 'persoon', 'personen') : 'Nog niemand',
					icon: 'personen'
				}
			]
		},
		{
			title: 'App',
			tiles: [
				{
					href: '/instellingen/meldingen',
					title: 'Meldingen',
					value: t.devices > 0 ? `Aan op ${plural(t.devices, 'apparaat', 'apparaten')}` : 'Nog uit',
					icon: 'meldingen'
				},
				{
					href: '/instellingen/rekeningen',
					title: 'Rekeningen',
					value: t.accounts.length > 0 ? names(t.accounts) : 'Nog geen',
					icon: 'rekeningen'
				},
				{
					href: '/instellingen/beveiliging',
					title: 'Beveiliging',
					value: !t.recoveryCode
						? 'Geen herstelcode'
						: t.passkeys < 2
							? '1 passkey, voeg er een toe'
							: `${plural(t.passkeys, 'passkey', 'passkeys')} en een herstelcode`,
					icon: 'beveiliging',
					warn: !t.recoveryCode
				},
				{
					href: '/instellingen/status',
					title: 'Status',
					value:
						t.statusAttention > 0
							? `${plural(t.statusAttention, 'punt vraagt', 'punten vragen')} aandacht`
							: 'Alles werkt',
					icon: 'status',
					warn: t.statusAttention > 0
				}
			]
		}
	]);
</script>

<svelte:head>
	<title>Meer · Budget</title>
</svelte:head>

<div class="page">
	<h1>Meer</h1>

	{#each groups as group (group.title)}
		<section aria-labelledby="group-{group.title}">
			<h2 id="group-{group.title}">{group.title}</h2>
			<ul class="tiles">
				{#each group.tiles as tile (tile.href)}
					<li>
						<a
							class={['tile', 'hue', tile.warn && 'warn']}
							href={tile.href}
							style:--h={ICONS[tile.icon].hue}
						>
							<span class="icon-badge" aria-hidden="true">
								<svg viewBox="0 0 24 24">
									<path
										d={ICONS[tile.icon].path}
										fill="none"
										stroke="currentColor"
										stroke-width="1.7"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</span>
							<span class="title" data-morph-to={tile.href} data-morph-part="titel"
								>{tile.title}</span
							>
							<span class="value num">
								{#if tile.warn}<span class="visually-hidden"
										>Vraagt aandacht:
									</span>{/if}{tile.value}
							</span>
							{#if tile.warn}<span class="dot" aria-hidden="true"></span>{/if}
						</a>
					</li>
				{/each}
			</ul>
		</section>
	{/each}

	<form method="POST" action="?/logout" class="logout">
		<button class="button secondary">
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path
					d="M14 4h5v16h-5 M10 8l-4 4 4 4 M6 12h10"
					fill="none"
					stroke="currentColor"
					stroke-width="1.7"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
			Uitloggen
		</button>
	</form>
</div>

<style>
	.page {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 28px;
		max-width: 56rem;
	}

	section {
		display: grid;
		gap: 12px;
	}

	.tiles {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 150px), 1fr));
		gap: 10px;
	}

	.tile {
		position: relative;
		display: grid;
		grid-template-rows: auto 1fr auto;
		gap: 4px;
		height: 100%;
		min-height: 124px;
		padding: 14px;
		border-radius: var(--radius);
		background: var(--surface);
		box-shadow: var(--shadow);
		color: var(--text);
		text-decoration: none;
		transition:
			transform 220ms var(--ease-spring),
			box-shadow 220ms var(--ease-out);
	}

	.tile:active {
		transform: scale(0.97);
	}

	@media (hover: hover) {
		.tile:hover {
			transform: translateY(-2px);
			box-shadow:
				var(--shadow),
				0 10px 28px oklch(0.2 0.01 85 / 0.08);
		}

		.tile:hover .icon-badge {
			transform: rotate(-6deg) scale(1.06);
		}
	}

	.icon-badge {
		margin-bottom: 10px;
	}

	.title {
		align-self: end;
		font-weight: 600;
		line-height: 1.25;
	}

	.value {
		color: var(--muted);
		font-size: 0.9rem;
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.warn .value {
		color: color-mix(in oklch, var(--warn) 70%, var(--text));
		font-weight: 550;
	}

	.dot {
		position: absolute;
		top: 14px;
		right: 14px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--warn);
		box-shadow: 0 0 0 4px color-mix(in oklch, var(--warn) 22%, transparent);
	}

	.logout {
		padding-top: 4px;
	}

	.logout svg {
		width: 18px;
		height: 18px;
	}

	@media (prefers-reduced-motion: reduce) {
		.tile:hover,
		.tile:hover .icon-badge {
			transform: none;
		}
	}
</style>
