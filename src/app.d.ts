// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	// Worker secrets (pushed via `just sync-secrets`) — wrangler types can't
	// see them, so they're declared here and merged into the generated Env.
	interface Env {
		GITHUB_TOKEN: string;
		LIFE_HUB_TOKEN: string;
		SYNC_TOKEN: string;
	}

	namespace App {
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}

		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
	}
}

export {};
