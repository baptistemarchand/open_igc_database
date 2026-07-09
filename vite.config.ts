import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Deploys to Cloudflare (Pages/Workers). During `vite dev` the adapter's
			// platformProxy reads wrangler.toml and exposes bindings on `event.platform.env`
			// backed by a local Miniflare D1 (real SQLite) and local R2 — no cloud calls.
			adapter: adapter()
		})
	]
});
