import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// SvelteKit 3 / adapter-node 6 kennen geen ORIGIN-omgevingsvariabele meer: de origin
// voor CSRF-controles wordt bij het bouwen vastgelegd in `paths.origin`.
const origin = process.env.ORIGIN;

const FRAMEWORK = /[\\/]node_modules[\\/](?:svelte|@sveltejs[\\/]kit)[\\/]|vite[\\/]preload-helper/;
// Kit laadt client-entry.js dynamisch vanuit entry.js en zoekt die twee chunks na het bouwen
// terug; ze moeten dus eigen bestanden blijven
const KIT_ENTRY =
	/[\\/]@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/]client[\\/](?:client-)?entry\.js$/;

/**
 * Chunks van de browserbundel (spec: Performance). Zonder groepen wordt elke module die twee
 * pagina's delen een eigen bestand: het startscherm laadde zo 35 bestanden, de helft onder de
 * 1 kB, en elk bestand kost een request, eigen headers en slechtere compressie. Daarom:
 * - `framework`: Svelte en SvelteKit (met hun afhankelijkheden) in één bestand; elke pagina
 *   laadt ze toch.
 * - `lib`: kleine modules uit src/lib die veel pagina's delen (geld, datums, iconen, Toast ...)
 *   in één bestand. Een pagina laadt daarmee soms een paar kB die ze niet gebruikt, maar dat
 *   is minder dan wat losse bestanden kosten. Grotere of zelden gedeelde modules en
 *   componenten blijven gewoon eigen chunks. Alleen JS: CSS gaat mee met zijn component.
 */
const codeSplitting = {
	groups: [
		{
			name: 'framework',
			test: (id: string) => FRAMEWORK.test(id) && !KIT_ENTRY.test(id),
			priority: 2
		},
		{
			name: 'lib',
			test: /[\\/]src[\\/]lib[\\/][^?]*$/,
			minShareCount: 4,
			maxModuleSize: 4 * 1024,
			priority: 1
		}
	]
};

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({ precompress: false }),
			paths: { origin },
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self'],
					// style-attributen (Svelte `style:`) toestaan; <style>-elementen krijgen een nonce
					'style-src-attr': ['unsafe-inline'],
					'img-src': ['self', 'data:', 'blob:'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'manifest-src': ['self'],
					'worker-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['none'],
					'form-action': ['self'],
					'frame-ancestors': ['none']
				}
			},
			version: { pollInterval: 0 }
		})
	],
	build: {
		// Geen sourcemaps in de client-bundel: houdt de broncode en paden uit productie
		sourcemap: false
	},
	// Alleen de browserbundel; de service worker blijft één bestand (codeSplitting uit, door Kit)
	environments: {
		client: { build: { rolldownOptions: { output: { codeSplitting } } } }
	},
	test: {
		// Alleen met `--coverage` (CI, static-job); scripts/coverage-summary.mjs zet het totaal in
		// de job-samenvatting. Geen drempel: dit is informatie, geen doel.
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts'],
			reporter: ['text-summary', 'json-summary']
		},
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					include: ['src/**/*.test.ts'],
					exclude: ['src/**/*.integration.test.ts'],
					environment: 'node'
				}
			},
			{
				extends: true,
				test: {
					name: 'integration',
					include: ['src/**/*.integration.test.ts', 'tests/integration/**/*.test.ts'],
					environment: 'node',
					fileParallelism: false
				}
			}
		]
	}
});
