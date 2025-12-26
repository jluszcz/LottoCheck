import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.toml' },
			},
		},
		// Note: Coverage reporting is not supported with @cloudflare/vitest-pool-workers
		// due to lack of node:inspector support in CloudFlare Workers environment
	},
});
