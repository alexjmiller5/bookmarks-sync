#!/usr/bin/env bun
// Preview a sync from this machine, never writing anything:
//   op run --env-file=.env.tpl -- bun scripts/dry-run.ts
// It plans from an EMPTY base, i.e. what a first run does. The deployed
// Worker's base lives in its Durable Object; for the live plan use
// POST /api/sync?dry_run=true on the Worker.
import { runSync } from '../src/lib/sync/run';

const { GITHUB_TOKEN, GITHUB_PUBLIC_TOKEN, LIFE_HUB_TOKEN } = Bun.env;
if (!GITHUB_TOKEN || !GITHUB_PUBLIC_TOKEN || !LIFE_HUB_TOKEN) {
	console.error(
		'Missing GITHUB_TOKEN / GITHUB_PUBLIC_TOKEN / LIFE_HUB_TOKEN; run via: op run --env-file=.env.tpl -- bun scripts/dry-run.ts'
	);
	process.exit(1);
}
// LIFE_HUB_URL is a plain wrangler var, not a secret (ponytail: strips whole-line comments only)
const wrangler = JSON.parse(
	(await Bun.file(new URL('../wrangler.jsonc', import.meta.url)).text()).replace(
		/^\s*\/\/.*$/gm,
		''
	)
) as { vars: { LIFE_HUB_URL: string } };

const summary = await runSync(
	{ GITHUB_TOKEN, GITHUB_PUBLIC_TOKEN, LIFE_HUB_TOKEN, LIFE_HUB_URL: wrangler.vars.LIFE_HUB_URL },
	{ load: async () => null, save: async () => {} },
	{ trigger: 'script', dryRun: true, allowRemovals: true }
);
const { planned: p } = summary;
console.log(
	`\nDRY RUN, nothing written. starred=${summary.starred} bookmarked=${summary.bookmarked}`
);
for (const [k, v] of Object.entries(p)) console.log(`${k}: ${Array.isArray(v) ? v.length : v}`);
console.log(`lists to create: ${p.createLists.join(', ') || 'none'}`);
if (summary.errors.length) {
	for (const e of summary.errors) console.error(`  ! ${e}`);
	process.exit(1);
}
