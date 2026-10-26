<script lang="ts" module>
	export interface Series {
		label: string;
		/** Centen per punt; null laat een gat */
		values: (number | null)[];
		/** CSS-kleur, ook `var(--accent)` of een kleur uit categoryColor.ts */
		color: string;
		/** Staven of een lijn */
		kind?: 'bars' | 'line';
		/** Gestippeld: een verwachting */
		dashed?: boolean;
	}
</script>

<script lang="ts">
	import 'uplot/dist/uPlot.min.css';
	import { onMount, untrack } from 'svelte';
	import type uPlot from 'uplot';
	import { formatCents } from '#lib/money.ts';

	// Grote grafiek (spec: Architectuur, Beweging): uPlot op een canvas, pas geladen na de eerste
	// weergave zodat hij niet in de eerste bundel zit. Het canvas is decoratief; een tabel voor
	// schermlezers en de legenda eronder zeggen hetzelfde in tekst. Bij het opbouwen schuift een
	// vlak weg (GSAP-timeline, alleen transform en opacity): lijnen verschijnen van links, staven
	// groeien vanaf de onderkant. Bij prefers-reduced-motion staat hij er meteen.
	let {
		label,
		ticks,
		names,
		series,
		height = 200,
		limit,
		focus
	}: {
		/** Onderschrift van de tabel, zoals "Uitgegeven per dag in oktober" */
		label: string;
		/** Kort onder de as: "1", "okt" */
		ticks: string[];
		/** Voluit in de legenda en de tabel: "12 oktober", "oktober 2026" */
		names: string[];
		series: Series[];
		height?: number;
		/** Een stippellijn op deze hoogte, zoals de som van de limieten */
		limit?: { cents: number; label: string };
		/** Welk punt de legenda toont zolang je niet aanwijst; standaard het laatste met een waarde */
		focus?: number;
	} = $props();

	let box = $state<HTMLDivElement>();
	let width = $state(0);
	let dark = $state(false);
	let plot = $state.raw<uPlot>();
	let pointed = $state<number | null>(null);

	const lastWithValue = $derived.by(() => {
		for (let i = ticks.length - 1; i >= 0; i--)
			if (series.some((s) => s.values[i] !== null && s.values[i] !== undefined)) return i;
		return ticks.length - 1;
	});
	const shown = $derived(pointed ?? focus ?? lastWithValue);
	const money = (cents: number | null | undefined) =>
		cents === null || cents === undefined ? '—' : formatCents(cents, { whole: true });

	// De breedte volgt de kaart. Een eigen ResizeObserver in plaats van bind:clientWidth: die
	// helper komt anders in de gedeelde runtime van elke pagina (JS-budget)
	onMount(() => {
		const observer = new ResizeObserver(([entry]) => {
			width = Math.round(entry?.contentRect.width ?? 0);
		});
		if (box) observer.observe(box);
		return () => observer.disconnect();
	});

	onMount(() => {
		const media = matchMedia('(prefers-color-scheme: dark)');
		dark = media.matches;
		const change = () => (dark = media.matches);
		media.addEventListener('change', change);
		return () => media.removeEventListener('change', change);
	});

	/** Een CSS-kleur (ook met var()) zoals het canvas hem kan gebruiken. */
	function resolve(host: HTMLElement, color: string): string {
		const probe = document.createElement('span');
		probe.style.color = color;
		host.append(probe);
		const value = getComputedStyle(probe).color;
		probe.remove();
		return value;
	}

	function options(uPlotLib: typeof uPlot, host: HTMLElement, w: number): uPlot.Options {
		const muted = resolve(host, 'var(--muted)');
		const line = resolve(host, 'var(--line)');
		const n = ticks.length;
		const bars = series.some((s) => s.kind !== 'line');
		const barPaths = uPlotLib.paths.bars?.({ size: [0.62, 44], radius: 0.18 });
		const axis = {
			stroke: muted,
			font: '12px "Inter Variable", system-ui, sans-serif',
			grid: { stroke: line, width: 1 },
			ticks: { show: false }
		};
		const limitCents = limit?.cents ?? 0;
		return {
			width: w,
			height,
			legend: { show: false },
			cursor: {
				drag: { x: false, y: false },
				points: { size: 8 },
				y: false
			},
			scales: {
				x: {
					time: false,
					range: bars ? [-0.5, n - 0.5] : [0, Math.max(1, n - 1)]
				},
				y: {
					range: (_u, _min, max) => [0, Math.max(max, limitCents, 100) * 1.08]
				}
			},
			axes: [
				{
					...axis,
					grid: { show: false },
					space: 24,
					incrs: [1, 2, 3, 5, 7, 10, 14],
					values: (_u, splits) => splits.map((i) => ticks[i] ?? '')
				},
				{
					...axis,
					size: 64,
					space: 36,
					values: (_u, splits) => splits.map((v) => formatCents(v, { whole: true }))
				}
			],
			series: [
				{},
				...series.map((s) => {
					const color = resolve(host, s.color);
					return s.kind === 'line'
						? {
								stroke: color,
								width: 2.5,
								dash: s.dashed ? [6, 5] : undefined,
								points: { show: false }
							}
						: { stroke: color, fill: color, width: 0, paths: barPaths, points: { show: false } };
				})
			],
			hooks: {
				setCursor: [(u) => (pointed = u.cursor.idx ?? null)],
				draw: [
					(u) => {
						if (!limit) return;
						const y = Math.round(u.valToPos(limit.cents, 'y', true));
						const { ctx } = u;
						ctx.save();
						ctx.strokeStyle = muted;
						ctx.lineWidth = 1.5 * devicePixelRatio;
						ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
						ctx.beginPath();
						ctx.moveTo(u.bbox.left, y);
						ctx.lineTo(u.bbox.left + u.bbox.width, y);
						ctx.stroke();
						ctx.restore();
					}
				]
			}
		};
	}

	/** Opbouwen: een vlak in de kleur van de kaart schuift weg, daarna verschijnt de legenda. */
	async function build(u: uPlot, host: HTMLElement, bars: boolean) {
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const cover = document.createElement('div');
		cover.className = 'cover';
		cover.style.transformOrigin = bars ? 'top' : 'right';
		u.over.append(cover);
		const legend = host.parentElement?.querySelectorAll('.legend li') ?? [];
		try {
			const { gsap } = await import('gsap');
			gsap
				.timeline({ onComplete: () => cover.remove() })
				.fromTo(u.root, { opacity: 0 }, { opacity: 1, duration: 0.18, ease: 'power1.out' })
				.to(cover, { [bars ? 'scaleY' : 'scaleX']: 0, duration: 0.55, ease: 'power3.out' }, '<0.05')
				.from(
					legend,
					{ opacity: 0, y: 6, duration: 0.24, stagger: 0.06, ease: 'power2.out' },
					'-=0.3'
				);
		} catch {
			cover.remove();
		}
	}

	// Opnieuw tekenen bij andere gegevens of een ander thema; de breedte volgt hieronder
	$effect(() => {
		const host = box;
		if (!host) return;
		// options() leest deze pas na het laden van uPlot; hier, zodat ze een nieuwe tekening geven
		void [dark, limit?.cents, limit?.label, height];
		const data: uPlot.AlignedData = [ticks.map((_, i) => i), ...series.map((s) => s.values)];
		const bars = series.some((s) => s.kind !== 'line');
		let made: uPlot | undefined;
		let cancelled = false;
		void import('uplot').then(({ default: uPlotLib }) => {
			if (cancelled) return;
			const w = untrack(() => width) || host.clientWidth;
			made = new uPlotLib(options(uPlotLib, host, w), data, host);
			plot = made;
			void build(made, host, bars);
		});
		return () => {
			cancelled = true;
			made?.destroy();
			pointed = null;
		};
	});

	$effect(() => {
		if (plot && width > 0 && plot.width !== width) plot.setSize({ width, height });
	});
</script>

<figure class="chart">
	<div class="plot" bind:this={box} style:height="{height}px" aria-hidden="true"></div>

	<ul class="legend" aria-hidden="true">
		<li class="when">{names[shown] ?? ''}</li>
		{#each series as s (s.label)}
			<li>
				<span
					class={['swatch', s.kind === 'line' && 'line', s.dashed && 'dashed']}
					style:--c={s.color}
				></span>
				{s.label}
				<span class="num">{money(s.values[shown])}</span>
			</li>
		{/each}
		{#if limit}
			<li>
				<span class="swatch limit"></span>
				{limit.label}
				<span class="num">{money(limit.cents)}</span>
			</li>
		{/if}
	</ul>

	<!-- Een tabel negeert een smalle breedte; de omhullende div houdt hem buiten de pagina -->
	<div class="visually-hidden">
		<table>
			<caption
				>{label}{#if limit}. {limit.label}: {money(limit.cents)}{/if}</caption
			>
			<thead>
				<tr>
					<th scope="col">Wanneer</th>
					{#each series as s (s.label)}<th scope="col">{s.label}</th>{/each}
				</tr>
			</thead>
			<tbody>
				{#each names as name, i (i)}
					{#if series.some((s) => s.values[i] !== null && s.values[i] !== undefined)}
						<tr>
							<th scope="row">{name}</th>
							{#each series as s (s.label)}<td>{money(s.values[i])}</td>{/each}
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	</div>
</figure>

<style>
	.chart {
		display: grid;
		gap: 10px;
		margin: 0;
		min-width: 0;
	}

	.plot {
		position: relative;
		min-width: 0;
		/* Uitgerekt door het canvas zou de pagina horizontaal scrollen */
		overflow: hidden;
	}

	.plot :global(.cover) {
		position: absolute;
		inset: -2px;
		background: var(--surface);
		pointer-events: none;
	}

	.plot :global(.u-cursor-pt) {
		border-width: 2px;
		background: var(--surface) !important;
	}

	.legend {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 16px;
		font-size: 0.9rem;
		color: var(--muted);
	}

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.legend .when {
		flex-basis: 100%;
		color: var(--text);
		font-weight: 600;
	}

	.legend .num {
		color: var(--text);
		font-weight: 550;
	}

	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 3px;
		background: var(--c);
	}

	.swatch.line {
		height: 3px;
		width: 14px;
		border-radius: 2px;
	}

	.swatch.dashed {
		background: repeating-linear-gradient(90deg, var(--c) 0 4px, transparent 4px 7px);
	}

	.swatch.limit {
		height: 0;
		width: 14px;
		border-top: 2px dashed var(--muted);
		border-radius: 0;
		background: none;
	}
</style>
