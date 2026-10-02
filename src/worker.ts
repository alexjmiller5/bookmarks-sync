/**
 * Real Worker entrypoint (`main` in wrangler.jsonc): wraps the SvelteKit
 * adapter build output to add a `scheduled()` handler, which the adapter
 * cannot emit, and exports the SyncState Durable Object. The adapter is
 * pointed at wrangler.build.jsonc (see vite.config.ts) so it writes to
 * .svelte-kit/cloudflare/_worker.js instead of overwriting this file.
 * `vite build` must run before wrangler bundles/deploys this (justfile
 * `deploy` already does).
 */
import { DurableObject } from 'cloudflare:workers';
// @ts-ignore build artifact — exists after `bun run build`
import sveltekit from '../.svelte-kit/cloudflare/_worker.js';
import { runSync, syncState } from './lib/sync/run';
import type { Base } from './lib/sync/plan';

/** The sync base (state both sides agreed on last run), in one SQLite-backed instance. */
export class SyncState extends DurableObject {
	async load(): Promise<Base | null> {
		return (await this.ctx.storage.get<Base>('base')) ?? null;
	}
	async save(base: Base): Promise<void> {
		await this.ctx.storage.put('base', base);
	}
}

const app = sveltekit as ExportedHandler<Env>;

export default {
	...app,
	scheduled(controller, env, ctx) {
		ctx.waitUntil(runSync(env, syncState(env.SYNC_STATE), { trigger: 'cron' }));
	}
} satisfies ExportedHandler<Env>;
