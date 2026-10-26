<script lang="ts">
	import Tile from '#lib/components/Tile.svelte';
	import * as icons from '#lib/icons-extra.ts';
	import { formatCents } from '#lib/money.ts';

	let { data } = $props();
	const t = $derived(data.tiles);

	const plural = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;
	const names = (list: string[]) =>
		list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} en ${list.at(-1)}`;

	interface TileData {
		href: string;
		title: string;
		value: string;
		icon: icons.IconDef;
		/** Vraagt aandacht: stip en waarschuwende waarde */
		warn?: boolean;
	}

	const groups = $derived<{ title: string; tiles: TileData[] }[]>([
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
					icon: icons.teKrijgen
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
					icon: icons.terugbetalingen,
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
					icon: icons.vasteLasten
				},
				{
					href: '/bonnen',
					title: 'Bonnen',
					value:
						t.receipts.waiting > 0
							? `${plural(t.receipts.waiting, 'bon wacht', 'bonnen wachten')} op je`
							: t.receipts.total > 0
								? plural(t.receipts.total, 'bon', 'bonnen')
								: 'Foto of screenshot toevoegen',
					icon: icons.bonnen,
					warn: t.receipts.waiting > 0
				},
				{
					href: '/saldocheck',
					title: 'Saldocheck',
					value:
						t.balanceDue.length > 0
							? `Nog te doen voor ${names(t.balanceDue)}`
							: 'Gedaan deze maand',
					icon: icons.saldocheck,
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
					icon: icons.categorieen
				},
				{
					href: '/regels',
					title: 'Regels',
					value: t.rules > 0 ? plural(t.rules, 'regel', 'regels') : 'Nog geen regels',
					icon: icons.regels
				},
				{
					href: '/personen',
					title: 'Personen',
					value: t.people > 0 ? plural(t.people, 'persoon', 'personen') : 'Nog niemand',
					icon: icons.personen
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
					icon: icons.meldingen
				},
				{
					href: '/instellingen/rekeningen',
					title: 'Rekeningen',
					value: t.accounts.length > 0 ? names(t.accounts) : 'Nog geen',
					icon: icons.rekeningen
				},
				{
					href: '/instellingen/beveiliging',
					title: 'Beveiliging',
					value: !t.recoveryCode
						? 'Geen herstelcode'
						: t.passkeys < 2
							? '1 passkey, voeg er een toe'
							: `${plural(t.passkeys, 'passkey', 'passkeys')} en een herstelcode`,
					icon: icons.beveiliging,
					warn: !t.recoveryCode
				},
				{
					href: '/instellingen/apparaten',
					title: 'Apparaten',
					value: t.uploadTokens.blocked
						? 'Een token is geblokkeerd'
						: t.uploadTokens.renewShortcut
							? 'Opdracht opnieuw ondertekenen'
							: t.uploadTokens.count > 0
								? `${plural(t.uploadTokens.count, 'apparaat', 'apparaten')} met het deelmenu`
								: 'Deelmenu nog niet ingesteld',
					icon: icons.apparaten,
					warn: t.uploadTokens.blocked || t.uploadTokens.renewShortcut
				},
				{
					href: '/instellingen/status',
					title: 'Status',
					value:
						t.statusAttention > 0
							? `${plural(t.statusAttention, 'punt vraagt', 'punten vragen')} aandacht`
							: 'Alles werkt',
					icon: icons.status,
					warn: t.statusAttention > 0
				},
				{
					href: '/instellingen/gebruik',
					title: 'Gebruik',
					value: !t.usage
						? 'Nog niets ingevoerd'
						: t.usage.streak > 1
							? `${t.usage.streak} dagen op rij`
							: `${t.usage.days} van ${t.usage.daysSoFar} dagen deze week`,
					icon: icons.gebruik
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
						<Tile {...tile} />
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

	.logout {
		padding-top: 4px;
	}

	.logout svg {
		width: 18px;
		height: 18px;
	}
</style>
