<script lang="ts" module>
	export interface SelectOption {
		value: string;
		label: string;
		/** Kop waaronder de optie in de lijst staat */
		group?: string;
		/** Kleur van het bolletje voor de naam, zoals de groepskleur van een categorie */
		dot?: string | null;
	}

	const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
</script>

<script lang="ts">
	// Eigen select volgens het ARIA-patroon "select-only combobox": een knop met een lijst
	// in de top layer (popover). Op een telefoon wordt de lijst een sheet onderin, binnen
	// bereik van je duim. Lange lijsten krijgen een zoekveld. Het formulier krijgt de waarde
	// via een verborgen invoerveld, dus `required` en gewone formulieren werken gewoon.
	import { tick } from 'svelte';
	import { keyboardInset } from '#lib/viewport.ts';

	let {
		options,
		value = $bindable(''),
		name,
		id,
		label,
		placeholder = 'Kies…',
		required = false,
		disabled = false,
		searchable = options.length > 8,
		variant = 'field',
		onchange
	}: {
		options: SelectOption[];
		value?: string;
		name?: string;
		/** Voor een zichtbare `<label for>`; anders geeft `label` de toegankelijke naam */
		id?: string;
		label?: string;
		placeholder?: string;
		required?: boolean;
		disabled?: boolean;
		searchable?: boolean;
		variant?: 'field' | 'chip';
		onchange?: (value: string) => void;
	} = $props();

	const uid = $props.id();
	const triggerId = $derived(id ?? `${uid}-trigger`);
	const listId = `${uid}-list`;
	const optionId = (i: number) => `${uid}-opt-${i}`;

	let trigger: HTMLButtonElement;
	let popup: HTMLDivElement;
	let list = $state<HTMLUListElement>();
	let search = $state<HTMLInputElement>();

	let open = $state(false);
	let sheet = $state(false);
	// Ruimte boven het schermtoetsenbord, zodat de sheet niet achter het toetsenbord valt
	let lift = $state({ bottom: 0, room: 0 });
	let query = $state('');
	let active = $state(-1);
	let place = $state<{ top?: number; bottom?: number; left: number; width: number; max: number }>({
		left: 0,
		width: 0,
		max: 320
	});
	let seeded = false;
	let typed = '';
	let typedAt = 0;

	const selected = $derived(options.find((o) => o.value === value));
	const shown = $derived.by(() => {
		const q = fold(query.trim());
		return q ? options.filter((o) => fold(o.label).includes(q)) : options;
	});
	// Opeenvolgende opties met dezelfde groep komen onder één kop
	const sections = $derived.by(() => {
		const out: { group: string | undefined; items: { option: SelectOption; index: number }[] }[] =
			[];
		shown.forEach((option, index) => {
			const last = out.at(-1);
			if (last && last.group === option.group) last.items.push({ option, index });
			else out.push({ group: option.group, items: [{ option, index }] });
		});
		return out;
	});

	// Zolang de sheet open is: meebewegen met het toetsenbord (visualViewport). Een effect,
	// omdat dit een abonnement op iets buiten Svelte is.
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

	function measure() {
		sheet = matchMedia('(max-width: 640px)').matches;
		if (sheet) return;
		const r = trigger.getBoundingClientRect();
		const below = innerHeight - r.bottom - 12;
		const above = r.top - 12;
		const width = Math.max(r.width, 220);
		const left = Math.max(8, Math.min(r.left, innerWidth - width - 8));
		if (below < 240 && above > below) {
			place = { bottom: innerHeight - r.top + 6, left, width, max: Math.min(360, above) };
		} else {
			place = { top: r.bottom + 6, left, width, max: Math.min(360, below) };
		}
	}

	function onbeforetoggle(e: ToggleEvent) {
		if (e.newState !== 'open') return;
		if (!seeded) query = '';
		active = seeded
			? 0
			: Math.max(
					0,
					options.findIndex((o) => o.value === value)
				);
		seeded = false;
		measure();
		open = true;
	}

	async function ontoggle(e: ToggleEvent) {
		if (e.newState === 'open') {
			// Vangnet voor een browser die geen beforetoggle stuurt: dan hier alsnog vullen
			if (!open) {
				measure();
				open = true;
			}
			await tick();
			focusInside();
			scrollToActive();
		} else {
			open = false;
			if (popup.contains(document.activeElement) || document.activeElement === document.body)
				trigger.focus();
		}
	}

	function focusInside() {
		// Op een aanraakscherm geen toetsenbord opdringen: focus op de lijst, niet op het zoekveld
		const touch = matchMedia('(pointer: coarse)').matches;
		(searchable && !touch ? search : list)?.focus();
	}

	// Gaat de focus naar iets buiten de lijst (behalve de knop zelf), dan sluit de lijst
	function onfocusout(e: FocusEvent) {
		const to = e.relatedTarget as Node | null;
		if (to && !popup.contains(to) && to !== trigger) hide();
	}

	function show() {
		if (!disabled && !popup.matches(':popover-open')) popup.showPopover();
	}

	function hide() {
		if (popup.matches(':popover-open')) popup.hidePopover();
	}

	function choose(option: SelectOption | undefined) {
		if (!option) return;
		hide();
		trigger.focus();
		if (option.value === value) return;
		value = option.value;
		onchange?.(option.value);
	}

	function scrollToActive() {
		document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
	}

	function move(to: number) {
		if (shown.length === 0) return;
		active = Math.max(0, Math.min(shown.length - 1, to));
		void tick().then(scrollToActive);
	}

	function onTriggerKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			// Staat de lijst al open, dan gaat de focus erin
			if (open) focusInside();
			else show();
		} else if (
			searchable &&
			e.key.length === 1 &&
			e.key !== ' ' &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey
		) {
			// Gewoon beginnen met typen opent de lijst met dat zoekwoord
			e.preventDefault();
			if (open) query += e.key;
			else {
				query = e.key;
				seeded = true;
				show();
			}
		}
	}

	function onListKey(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				move(active + 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				move(active - 1);
				break;
			case 'Home':
				if (e.target === search) return;
				e.preventDefault();
				move(0);
				break;
			case 'End':
				if (e.target === search) return;
				e.preventDefault();
				move(shown.length - 1);
				break;
			case 'PageDown':
				e.preventDefault();
				move(active + 8);
				break;
			case 'PageUp':
				e.preventDefault();
				move(active - 8);
				break;
			case 'Enter':
				e.preventDefault();
				choose(shown[active]);
				break;
			case 'Tab':
				hide();
				break;
			default:
				if (e.target !== search && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
					if (searchable) {
						search?.focus();
						return;
					}
					// Zonder zoekveld: typen springt naar de eerste optie die zo begint
					const now = Date.now();
					typed = now - typedAt > 700 ? e.key : typed + e.key;
					typedAt = now;
					const hit = shown.findIndex((o) => fold(o.label).startsWith(fold(typed)));
					if (hit >= 0) move(hit);
				}
		}
	}
</script>

<svelte:window
	onresize={() => !sheet && hide()}
	onscrollcapture={(e) => open && !sheet && !popup.contains(e.target as Node) && measure()}
/>

<div class={['select', variant]}>
	<button
		bind:this={trigger}
		id={triggerId}
		type="button"
		role="combobox"
		class="trigger"
		aria-label={label}
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls={listId}
		aria-required={required || undefined}
		popovertarget="{uid}-popup"
		{disabled}
		onkeydown={onTriggerKey}
	>
		{#if selected?.dot !== undefined}
			<span class={['dot', !selected.dot && 'none']} style:--dot={selected.dot}></span>
		{/if}
		<span class={['text', !selected && 'placeholder']}>{selected?.label ?? placeholder}</span>
		<svg class="chevron" viewBox="0 0 16 16" aria-hidden="true">
			<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" />
		</svg>
	</button>

	<!-- Draagt de waarde naar het formulier; focus en validatie gaan naar de knop -->
	<input
		class="proxy"
		tabindex="-1"
		aria-hidden="true"
		{name}
		{value}
		{required}
		{disabled}
		onfocus={() => trigger.focus()}
	/>

	<div
		bind:this={popup}
		id="{uid}-popup"
		popover="auto"
		class={['popup', sheet && 'sheet']}
		style:top={sheet || place.top === undefined ? undefined : `${place.top}px`}
		style:bottom={sheet
			? `${lift.bottom}px`
			: place.bottom === undefined
				? undefined
				: `${place.bottom}px`}
		style:--room={sheet && lift.room ? `${lift.room - 16}px` : undefined}
		style:left={sheet ? undefined : `${place.left}px`}
		style:width={sheet ? undefined : `${place.width}px`}
		style:--max="{place.max}px"
		{onbeforetoggle}
		{ontoggle}
		{onfocusout}
	>
		{#if open}
			{#if sheet && label}<p class="sheet-title" aria-hidden="true">{label}</p>{/if}
			{#if searchable}
				<input
					bind:this={search}
					bind:value={query}
					class="search"
					type="text"
					role="combobox"
					aria-label="Zoek in {label ?? 'de lijst'}"
					aria-autocomplete="list"
					aria-expanded="true"
					aria-controls={listId}
					aria-activedescendant={shown[active] ? optionId(active) : undefined}
					placeholder="Zoeken"
					autocomplete="off"
					spellcheck="false"
					enterkeyhint="done"
					oninput={() => (active = 0)}
					onkeydown={onListKey}
				/>
			{/if}
			<ul
				bind:this={list}
				id={listId}
				role="listbox"
				tabindex="-1"
				aria-label={label}
				aria-activedescendant={shown[active] ? optionId(active) : undefined}
				onkeydown={onListKey}
			>
				{#each sections as section, s (s)}
					<li role="presentation">
						{#if section.group}
							<div class="group" id="{uid}-g-{s}" role="presentation">{section.group}</div>
						{/if}
						<ul role="group" aria-labelledby={section.group ? `${uid}-g-${s}` : undefined}>
							{#each section.items as { option, index } (option.value)}
								<!-- Toetsenbord loopt via de lijst (aria-activedescendant), niet per optie -->
								<!-- svelte-ignore a11y_click_events_have_key_events -->
								<li
									id={optionId(index)}
									role="option"
									aria-selected={option.value === value}
									class={['option', index === active && 'active']}
									onpointermove={() => (active = index)}
									onclick={() => choose(option)}
								>
									{#if option.dot !== undefined}
										<span class={['dot', !option.dot && 'none']} style:--dot={option.dot}></span>
									{/if}
									<span class="text">{option.label}</span>
									{#if option.value === value}
										<svg class="check" viewBox="0 0 16 16" aria-hidden="true">
											<path
												d="M3 8.5l3.2 3L13 5"
												fill="none"
												stroke="currentColor"
												stroke-width="1.8"
											/>
										</svg>
									{/if}
								</li>
							{/each}
						</ul>
					</li>
				{:else}
					<li role="presentation" class="none-found">Niets gevonden</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<style>
	.select {
		position: relative;
		min-width: 0;
	}

	.trigger {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: var(--tap);
		padding: 0 10px 0 12px;
		border: 1px solid var(--line);
		border-radius: var(--radius-sm);
		background: var(--surface);
		text-align: start;
		cursor: pointer;
		transition: transform 160ms var(--ease-spring);
	}

	.trigger:hover:not(:disabled) {
		border-color: color-mix(in oklch, var(--text) 28%, transparent);
	}

	.trigger:active:not(:disabled) {
		transform: scale(0.985);
	}

	.trigger:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.chip .trigger {
		min-height: var(--tap);
		padding: 0 6px 0 0;
		border: 0;
		background: transparent;
		font-size: 0.95rem;
	}

	.text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.placeholder {
		color: var(--muted);
	}

	.chevron {
		flex: none;
		width: 16px;
		height: 16px;
		color: var(--muted);
		transition: transform var(--dur) var(--ease-out);
	}

	[aria-expanded='true'] .chevron {
		transform: rotate(180deg);
	}

	.dot {
		flex: none;
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: var(--dot);
	}

	.dot.none {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--muted);
	}

	.proxy {
		position: absolute;
		bottom: 0;
		left: 50%;
		width: 1px;
		height: 1px;
		min-height: 0;
		padding: 0;
		border: 0;
		opacity: 0;
		pointer-events: none;
	}

	.popup {
		position: fixed;
		inset: auto;
		margin: 0;
		padding: 6px;
		border: 1px solid var(--line);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		box-shadow:
			0 2px 6px oklch(0.2 0.01 85 / 0.08),
			0 16px 40px oklch(0.2 0.01 85 / 0.16);
		overflow: hidden;
		display: none;
		flex-direction: column;
		height: auto;
		max-height: var(--max);
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

	/* Telefoon: een sheet onderin, binnen bereik van je duim */
	.popup.sheet {
		inset: auto 0 0 0;
		width: 100%;
		/* --room: hoogte boven het schermtoetsenbord, als dat open is */
		max-height: min(75dvh, 34rem, var(--room, 100dvh));
		padding: 8px 8px calc(12px + env(safe-area-inset-bottom));
		border-radius: 20px 20px 0 0;
		border-bottom: 0;
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

	.popup.sheet::backdrop {
		background: oklch(0.15 0.01 85 / 0.4);
	}

	.sheet-title {
		padding: 10px 12px 6px;
		font-family: var(--font-display);
		font-size: 1.25rem;
		font-weight: 560;
	}

	.search {
		flex: none;
		margin: 2px 2px 6px;
		background: var(--surface-2);
		border-color: transparent;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	/* Hoogte volgt de inhoud en krimpt pas bij max-height. Geen `flex: 1`: met basis 0% in
	   een kolom zonder vaste hoogte klapt de lijst in sommige WebKit-versies in tot 0 px */
	[role='listbox'] {
		flex: 0 1 auto;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		outline: none;
		border-radius: var(--radius-sm);
	}

	[role='listbox']:focus-visible {
		box-shadow: inset 0 0 0 2px var(--focus);
	}

	.group {
		padding: 10px 10px 4px;
		color: var(--muted);
		font-size: 0.85rem;
		font-weight: 600;
	}

	.option {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: var(--tap);
		padding: 0 10px;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}

	.option.active {
		background: var(--surface-2);
	}

	.option[aria-selected='true'] {
		font-weight: 600;
	}

	.check {
		flex: none;
		width: 16px;
		height: 16px;
		color: var(--accent-strong);
	}

	.none-found {
		padding: 12px 10px;
		color: var(--muted);
	}
</style>
