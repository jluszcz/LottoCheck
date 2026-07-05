import js from '@eslint/js';
import globals from 'globals';

export default [
	{
		ignores: ['coverage/', 'dist/', '.wrangler/', 'node_modules/'],
	},
	js.configs.recommended,
	{
		// Worker source runs in the Cloudflare Workers (service worker) runtime
		files: ['src/**/*.js'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.serviceworker,
				...globals.browser,
			},
		},
	},
	{
		// Vitest test files
		files: ['src/**/*.test.js'],
		languageOptions: {
			globals: {
				...globals.vitest,
			},
		},
	},
	{
		// Config files run under Node
		files: ['*.config.js', '*.config.mjs'],
		languageOptions: {
			sourceType: 'module',
			globals: {
				...globals.node,
			},
		},
	},
];
