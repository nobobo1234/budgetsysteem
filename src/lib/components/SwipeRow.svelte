<script lang="ts">
	import type { Snippet } from 'svelte';

	// Swipen op een rij (spec: Overige micro-interacties): naar rechts bevestigen, naar links
	// een andere categorie. Alleen met aanraken of de muis slepen; met het toetsenbord doe je
	// hetzelfde op de detailpagina. Verticaal scrollen blijft gewoon werken (touch-action).
	let {
		children,
		onright,
		onleft,
		rightLabel = 'Bevestigen',
		leftLabel = 'Categorie'
	}: {
		children: Snippet;
		/** Naar rechts vegen; zonder deze functie kan de rij niet naar rechts */
		onright?: () => void;
		onleft?: () => void;
		rightLabel?: string;
		leftLabel?: string;
	} = $props();

	const THRESHOLD = 72;
	let dx = $state(0);
	let dragging = $state(false);
	let start: { x: number; y: number; id: number } | null = null;
	let decided: 'x' | 'y' | null = null;
	// Na een veeg geen klik doorlaten naar de link in de rij
	let swallow = false;

	function down(e: PointerEvent) {
		if (e.button !== 0 || (!onright && !onleft)) return;
		start = { x: e.clientX, y: e.clientY, id: e.pointerId };
		decided = null;
		swallow = false;
	}

	function move(e: PointerEvent) {
		if (!start || e.pointerId !== start.id) return;
		const x = e.clientX - start.x;
		const y = e.clientY - start.y;
		if (!decided) {
			if (Math.abs(x) < 8 && Math.abs(y) < 8) return;
			decided = Math.abs(x) > Math.abs(y) * 1.2 ? 'x' : 'y';
			if (decided === 'x') {
				dragging = true;
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			}
		}
		if (decided !== 'x') return;
		// Weerstand voorbij de drempel, en niet naar een kant zonder actie
		const limit = (v: number) =>
			Math.abs(v) > THRESHOLD ? Math.sign(v) * (THRESHOLD + (Math.abs(v) - THRESHOLD) * 0.3) : v;
		dx = limit(x > 0 ? (onright ? x : 0) : onleft ? x : 0);
	}

	function up(e: PointerEvent) {
		if (!start || e.pointerId !== start.id) return;
		if (decided === 'x') {
			swallow = Math.abs(dx) > 8;
			// Pas na deze pointerup en de klik erna: anders sluit de browser een sheet die de actie
			// opent meteen weer (light dismiss van popover="auto" telt deze tik als ernaast)
			const action = dx >= THRESHOLD ? onright : dx <= -THRESHOLD ? onleft : undefined;
			if (action) setTimeout(action, 0);
		}
		start = null;
		decided = null;
		dragging = false;
		dx = 0;
	}

	function click(e: MouseEvent) {
		if (!swallow) return;
		e.preventDefault();
		e.stopPropagation();
		swallow = false;
	}
</script>

<div
	class={['swipe', dragging && 'dragging', dx > 0 && 'to-right', dx < 0 && 'to-left']}
	style:--dx="{dx}px"
>
	{#if onright}
		<span class={['action', 'right', dx >= THRESHOLD && 'armed']} aria-hidden="true">
			<svg viewBox="0 0 24 24"><path d="M5.5 12.5l4.5 4.5 8.5-9.5" /></svg>
			{rightLabel}
		</span>
	{/if}
	{#if onleft}
		<span class={['action', 'left', dx <= -THRESHOLD && 'armed']} aria-hidden="true">
			{leftLabel}
			<svg viewBox="0 0 24 24"><path d="M3.5 12V4h8l9 9-8 8z M8 8.5h.01" /></svg>
		</span>
	{/if}
	<!-- Vegen is een snelkoppeling voor aanraken; met het toetsenbord gaat het via de link in de
	     rij naar de detailpagina, waar dezelfde acties staan -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="row"
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		onclickcapture={click}
		ondragstart={(e) => e.preventDefault()}
	>
		{@render children()}
	</div>
</div>

<style>
	.swipe {
		position: relative;
		overflow: hidden;
	}

	.row {
		position: relative;
		background: var(--bg);
		touch-action: pan-y;
		/* Een link in de rij niet als bestand slepen: dan breekt de browser de veeg af */
		-webkit-user-drag: none;
		user-select: none;
		transform: translateX(var(--dx));
		transition: transform 260ms var(--ease-spring);
	}

	.dragging .row {
		transition: none;
	}

	.action {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 16px;
		font-weight: 650;
		font-size: 0.92rem;
		opacity: 0;
		transition: opacity 120ms var(--ease-out);
	}

	.to-right .right,
	.to-left .left {
		opacity: 1;
	}

	.right {
		justify-content: flex-start;
		background: var(--accent);
		color: var(--on-accent);
	}

	.left {
		justify-content: flex-end;
		background: var(--surface-2);
		color: var(--text);
	}

	.action svg {
		width: 20px;
		height: 20px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		transform: scale(0.8);
		transition: transform 200ms var(--ease-spring);
	}

	.armed svg {
		transform: scale(1.15);
	}
</style>
