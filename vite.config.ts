import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// SvelteKit 3 / adapter-node 6 kennen geen ORIGIN-omgevingsvariabele meer: de origin
// voor CSRF-controles wordt bij het bouwen vastgelegd in `paths.origin`.
const origin = process.env.ORIGIN;

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
	test: {
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
