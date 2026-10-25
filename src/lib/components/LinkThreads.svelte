<script lang="ts" module>
	/** Breedte van de strook links van de rijen, voor `lanes` banen. */
	export const threadGutter = (lanes: number) => (lanes === 0 ? 0 : 20 + (lanes - 1) * LANE);
	const LANE = 7;
</script>

<script lang="ts">
	import type { ThreadLayout } from '#lib/refund.ts';

	// De draad tussen een terugbetaling en zijn uitgave, in de strook links van een lijst. De
	// rijen dragen `data-tx-row`; de lijst eromheen is `position: relative` en laat links
	// `threadGutter(layout.lanes)` vrij. Wijzen of focussen op een rij licht zijn draden en de
	// rijen aan de andere kant op; een tik op de draad brengt je naar de andere kant.

	let { layout }: { layout: ThreadLayout } = $props();

	let root: SVGSVGElement;
	const gutter = $derived(threadGutter(layout.lanes));
	// Gemeten midden van elke rij, ten opzichte van de lijst
	let rows = $state.raw<Record<string, number>>({});
	let height = $state(0);
	let active = $state.raw<Set<string>>(new Set());

	const laneX = (lane: number) => gutter - 14 - lane * LANE;
	const rowX = $derived(gutter - 3);

	const drawn = $derived(
		layout.groups.flatMap((g) => {
			const source = rows[g.source];
			const members = [g.source, ...g.payments]
				.map((id) => ({ id, y: rows[id] }))
				.filter((m): m is { id: string; y: number } => m.y !== undefined)
				.sort((a, b) => a.y - b.y);
			if (source === undefined || members.length < 2) return [];
			const x = laneX(g.lane);
			const top = members[0]!.y;
			const bottom = members.at(-1)!.y;
			const r = Math.min(6, (bottom - top) / 2);
			const d = [
				`M${rowX} ${top}H${x + r}Q${x} ${top} ${x} ${top + r}`,
				`V${bottom - r}Q${x} ${bottom} ${x + r} ${bottom}H${rowX}`,
				...members.slice(1, -1).map((m) => `M${x} ${m.y}H${rowX}`)
			].join('');
			return [
				{
					...g,
					d,
					members,
					// De draad groeit vanuit de uitgave
					origin: source === bottom ? 'bottom' : 'top'
				}
			];
		})
	);

	function rowsOf(id: string) {
		return layout.groups.filter((g) => g.source === id || g.payments.includes(id));
	}

	function measure() {
		const list = root?.parentElement;
		if (!list) return;
		const box = list.getBoundingClientRect();
		const next: Record<string, number> = {};
		for (const g of layout.groups) {
			for (const id of [g.source, ...g.payments]) {
				const el = list.querySelector(`[data-tx-row="${CSS.escape(id)}"]`);
				if (!el) continue;
				const r = el.getBoundingClientRect();
				next[id] = Math.round(r.top - box.top + r.height / 2);
			}
		}
		rows = next;
		height = list.scrollHeight;
	}

	$effect(() => {
		void layout;
		const list = root.parentElement;
		if (!list) return;
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(list);
		void document.fonts?.ready.then(measure);

		const rowId = (e: Event) =>
			(e.target as Element | null)?.closest<HTMLElement>('[data-tx-row]')?.dataset.txRow;
		const enter = (e: Event) => {
			const id = rowId(e);
			active = new Set(id ? rowsOf(id).map((g) => g.source) : []);
		};
		const leave = () => (active = new Set());
		list.addEventListener('pointerover', enter);
		list.addEventListener('pointerleave', leave);
		list.addEventListener('focusin', enter);
		list.addEventListener('focusout', leave);
		return () => {
			observer.disconnect();
			list.removeEventListener('pointerover', enter);
			list.removeEventListener('pointerleave', leave);
			list.removeEventListener('focusin', enter);
			list.removeEventListener('focusout', leave);
		};
	});

	// De rijen aan een opgelichte draad krijgen een zachte tint
	$effect(() => {
		const list = root.parentElement;
		if (!list) return;
		const lit = new Set(
			layout.groups.filter((g) => active.has(g.source)).flatMap((g) => [g.source, ...g.payments])
		);
		for (const el of list.querySelectorAll<HTMLElement>('[data-tx-row]')) {
			el.toggleAttribute('data-thread-lit', lit.has(el.dataset.txRow ?? ''));
		}
	});

	/** Naar de andere kant: de rij aan de draad die het verst van de tik ligt. */
	function jump(e: MouseEvent, members: { id: string; y: number }[]) {
		const list = root.parentElement;
		if (!list) return;
		const y = e.clientY - list.getBoundingClientRect().top;
		const far = members.reduce((a, b) => (Math.abs(b.y - y) > Math.abs(a.y - y) ? b : a));
		const el = list.querySelector<HTMLElement>(`[data-tx-row="${CSS.escape(far.id)}"]`);
		if (!el) return;
		const box = el.getBoundingClientRect();
		if (box.top < 64 || box.bottom > innerHeight - 96) {
			const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
			el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
		}
		el.removeAttribute('data-thread-flash');
		// Opnieuw starten als je twee keer tikt
		void el.offsetWidth;
		el.setAttribute('data-thread-flash', '');
		el.addEventListener('animationend', () => el.removeAttribute('data-thread-flash'), {
			once: true
		});
	}
</script>

<svg
	bind:this={root}
	class="threads"
	width={gutter}
	{height}
	viewBox="0 0 {gutter} {height || 1}"
	aria-hidden="true"
	data-threads={layout.groups.length}
>
	{#each drawn as g (g.source)}
		<g
			class={['thread', active.has(g.source) && 'lit']}
			style:transform-origin={g.origin}
			data-thread={g.source}
		>
			<path class="line" d={g.d} />
			{#each g.members as m (m.id)}
				<circle class={['end', m.id === g.source && 'source']} cx={rowX} cy={m.y} r="3" />
			{/each}
			<!-- Ruim raakvlak rond de dunne lijn -->
			<path
				class="hit"
				d={g.d}
				role="presentation"
				onclick={(e) => jump(e, g.members)}
				onpointerenter={() => (active = new Set([g.source]))}
				onpointerleave={() => (active = new Set())}
			/>
		</g>
	{/each}
</svg>

<style>
	.threads {
		position: absolute;
		top: 0;
		left: 0;
		z-index: 1;
		overflow: visible;
		pointer-events: none;
	}

	.thread {
		color: var(--accent);
		opacity: 0.55;
		transform-box: fill-box;
		animation: thread-in 320ms var(--ease-out);
		transition: opacity 160ms var(--ease-out);
	}

	.thread.lit {
		opacity: 1;
	}

	.line {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.75;
		stroke-linecap: round;
	}

	.end {
		fill: currentColor;
	}

	.end.source {
		fill: var(--bg);
		stroke: currentColor;
		stroke-width: 1.5;
	}

	.hit {
		fill: none;
		stroke: transparent;
		stroke-width: 16;
		pointer-events: stroke;
		cursor: pointer;
	}

	@keyframes thread-in {
		from {
			opacity: 0;
			transform: scaleY(0.2);
		}
	}

	/* Rijen aan een opgelichte draad, en de rij waar een tik op de draad je heen bracht */
	:global([data-tx-row]) {
		position: relative;
	}

	:global([data-tx-row])::after {
		content: '';
		position: absolute;
		inset: 0 -10px;
		border-radius: var(--radius-sm);
		background: var(--accent-soft);
		opacity: 0;
		pointer-events: none;
		transition: opacity 160ms var(--ease-out);
	}

	:global([data-tx-row][data-thread-lit])::after {
		opacity: 1;
	}

	:global([data-tx-row][data-thread-flash])::after {
		animation: thread-flash 1s var(--ease-out);
	}

	@keyframes -global-thread-flash {
		0%,
		100% {
			opacity: 0;
		}
		15%,
		70% {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.thread {
			animation: none;
		}

		:global([data-tx-row][data-thread-flash])::after {
			animation-duration: 1s;
			animation-timing-function: steps(1, end);
		}
	}
</style>
