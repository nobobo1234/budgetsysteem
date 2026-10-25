<script lang="ts">
	import { tick, type Snippet } from 'svelte';
	import { keyboardInset } from '#lib/viewport.ts';

	// Sheet en popover (spec: Componenten): een korte dialoog of een menu in de top layer. Op
	// een telefoon een sheet onderin, binnen bereik van je duim; op desktop een kaart naast de
	// knop die hem opende. Sluit met Esc en door ernaast te tikken (popover="auto"); de focus
	// gaat daarna terug naar die knop.
	let {
		open = $bindable(false),
		title,
		focusField = true,
		children
	}: {
		open?: boolean;
		/** Kop van de sheet; ook de toegankelijke naam */
		title: string;
		/** Meteen in het eerste tekstveld; uit voor een formulier dat je eerst leest */
		focusField?: boolean;
		children: Snippet;
	} = $props();

	const uid = $props.id();
	let popup = $state<HTMLElement>();
	let opener: HTMLElement | null = null;
	// Safari geeft een knop geen focus bij een klik: onthoud daarom ook wat je aantikte
	let tapped: HTMLElement | null = null;
	let sheet = $state(true);
	let place = $state<{ top?: number; bottom?: number; left: number; width: number }>({
		left: 0,
		width: 0
	});
	let lift = $state({ bottom: 0, room: 0 });

	// Het open-zijn komt van buiten (een knop zet `open`); de popover volgt
	$effect(() => {
		if (!popup) return;
		const shown = popup.matches(':popover-open');
		if (open && !shown) show();
		else if (!open && shown) popup.hidePopover();
	});

	// Zolang de sheet open is: meebewegen met het schermtoetsenbord (zie viewport.ts)
	$effect(() => {
		const vv = window.visualViewport;
		if (!open || !sheet || !vv) return;
		const fit = () => (lift = keyboardInset(innerHeight, vv));
		fit();
		vv.addEventListener('resize', fit);
		vv.addEventListener('scroll', fit);
		return () => {
			vv.removeEventListener('resize', fit);
			vv.removeEventListener('scroll', fit);
			lift = { bottom: 0, room: 0 };
		};
	});

	function show() {
		const active = document.activeElement;
		opener = active instanceof HTMLElement && active !== document.body ? active : tapped;
		sheet = matchMedia('(max-width: 640px)').matches;
		if (!sheet && opener) {
			const r = opener.getBoundingClientRect();
			const width = Math.min(360, innerWidth - 16);
			const left = Math.max(8, Math.min(r.left, innerWidth - width - 8));
			place =
				innerHeight - r.bottom < 280 && r.top > innerHeight - r.bottom
					? { bottom: innerHeight - r.top + 6, left, width }
					: { top: r.bottom + 6, left, width };
		} else if (!sheet) {
			const width = Math.min(380, innerWidth - 16);
			place = { top: Math.max(16, innerHeight * 0.2), left: (innerWidth - width) / 2, width };
		}
		popup!.showPopover();
	}

	async function ontoggle(e: ToggleEvent) {
		if (e.newState === 'open') {
			open = true;
			await tick();
			// Eerst een tekstveld (als dat de bedoeling is), anders de sheet zelf, zodat Tab
			// vanaf het begin loopt en een telefoon niet ongevraagd het toetsenbord opent
			const field = focusField
				? popup?.querySelector<HTMLElement>('input:not([type=hidden]), textarea')
				: null;
			(field ?? popup)?.focus();
		} else {
			open = false;
			if (popup?.contains(document.activeElement) || document.activeElement === document.body)
				opener?.focus();
		}
	}
</script>

<svelte:document
	onpointerdowncapture={(e) =>
		(tapped = (e.target as Element | null)?.closest<HTMLElement>('button, a[href]') ?? null)}
/>

<div
	bind:this={popup}
	popover="auto"
	role="dialog"
	tabindex="-1"
	aria-labelledby="{uid}-title"
	class={['popup', sheet && 'sheet']}
	style:top={sheet || place.top === undefined ? undefined : `${place.top}px`}
	style:bottom={sheet
		? lift.bottom
			? `${lift.bottom}px`
			: undefined
		: place.bottom === undefined
			? undefined
			: `${place.bottom}px`}
	style:left={sheet ? undefined : `${place.left}px`}
	style:width={sheet ? undefined : `${place.width}px`}
	style:--room={sheet && lift.room ? `${lift.room - 16}px` : undefined}
	{ontoggle}
>
	<div class="head">
		<h2 id="{uid}-title">{title}</h2>
		<button type="button" class="close" aria-label="Sluiten" onclick={() => (open = false)}>
			<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9m0-9l-9 9" /></svg>
		</button>
	</div>
	<div class="body">{@render children()}</div>
</div>

<style>
	.popup {
		position: fixed;
		inset: auto;
		margin: 0;
		padding: 14px 16px 16px;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		box-shadow:
			0 2px 6px oklch(0.2 0.01 85 / 0.08),
			0 16px 40px oklch(0.2 0.01 85 / 0.16);
		max-height: min(80dvh, 40rem);
		overflow-y: auto;
		overscroll-behavior: contain;
		display: none;
		flex-direction: column;
		gap: 10px;
		opacity: 1;
		transform: none;
		transition:
			opacity 140ms var(--ease-out),
			transform 180ms var(--ease-out),
			overlay 180ms allow-discrete,
			display 180ms allow-discrete;
	}

	.popup:popover-open {
		display: flex;
	}

	.popup:not(:popover-open) {
		opacity: 0;
		transform: translateY(-4px) scale(0.98);
	}

	@starting-style {
		.popup:popover-open {
			opacity: 0;
			transform: translateY(-4px) scale(0.98);
		}
	}

	/* Telefoon: een sheet onderin */
	.popup.sheet {
		inset: auto 0 0 0;
		width: 100%;
		max-height: min(80dvh, 40rem, var(--room, 100dvh));
		padding: 10px 16px calc(16px + env(safe-area-inset-bottom));
		border-radius: 20px 20px 0 0;
		border-bottom: 0;
	}

	.popup.sheet::before {
		content: '';
		align-self: center;
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--line);
	}

	.popup.sheet:not(:popover-open) {
		opacity: 1;
		transform: translateY(100%);
	}

	@starting-style {
		.popup.sheet:popover-open {
			opacity: 1;
			transform: translateY(100%);
		}
	}

	.popup::backdrop {
		background: transparent;
	}

	.popup.sheet::backdrop {
		background: oklch(0.15 0.01 85 / 0.4);
	}

	.popup:focus-visible {
		outline: none;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	h2 {
		font-size: 1.3rem;
	}

	.close {
		display: grid;
		place-items: center;
		flex: none;
		width: var(--tap);
		height: var(--tap);
		margin-right: -10px;
		border: 0;
		border-radius: 50%;
		background: none;
		color: var(--muted);
		cursor: pointer;
	}

	.close svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}

	.body {
		display: grid;
		gap: 12px;
	}
</style>
