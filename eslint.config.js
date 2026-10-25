import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import ts from 'typescript-eslint';

export default ts.config(
	{
		ignores: [
			'.svelte-kit/',
			'build/',
			'node_modules/',
			'drizzle/',
			'test-results/',
			'.e2e/',
			'.lhci/',
			'.lighthouseci/',
			'playwright-report/',
			'history/',
			'data/'
		]
	},
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			'no-undef': 'off',
			// Bedragen nooit via parseFloat (CLAUDE.md)
			'no-restricted-globals': [
				'error',
				{ name: 'parseFloat', message: 'Bedragen als hele centen; gebruik #lib/money.' }
			],
			'no-restricted-properties': [
				'error',
				{
					object: 'Number',
					property: 'parseFloat',
					message: 'Bedragen als hele centen; gebruik #lib/money.'
				}
			],
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		},
		rules: {
			// Nooit {@html} met tekst van gebruiker of AI (CLAUDE.md)
			'svelte/no-at-html-tags': 'error',
			// De app draait op de root zonder `paths.base`; gewone links zijn dan correct
			'svelte/no-navigation-without-resolve': 'off'
		}
	}
);
