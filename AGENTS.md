# AGENTS.md

bookmarks-sync: two-way sync between GitHub and the soma `bookmarks`
table. Stars are GitHub-tagged bookmarks and GitHub list membership mirrors the
other tags, via a three-way merge against the last agreed state (semantics in
README "Sync semantics"). Cloudflare Worker (cf-site template) with a minimal
status page; sync runs on a CF cron trigger + manual endpoint.

## Project decisions

- **CF Worker, not modal-service**: wrangler.jsonc IS the IaC — no terraform.
- **Sync state = the `SyncState` Durable Object** (SQLite backed, one
  instance named `github`, declared with its migration in wrangler.jsonc). It
  stores only the base `{repos: {nodeId: {key, lists}}}`; the bookmarks
  themselves live in soma. Losing it is safe: the next run is a union
  (stars + bookmarks), which can re-star repos unstarred since the last run. Retained bookmark
  tombstones still prevent recreating intentionally deleted bookmarks; a
  live replacement row for the same URL takes precedence.
- **Pure planner, thin I/O**: `plan.ts` decides everything from fetched
  inputs and is where merge behavior changes and gets tested; `run.ts` applies
  a plan and advances the base only for repos whose every write landed.
- **Vocabulary**: every `bookmarks.tags` option except Github is a GitHub
  list name. The Worker's hub token cannot change the catalog, so a new GitHub
  list needs its tag option added by an agent (`soma property set
bookmarks.tags --options ...`, then `soma doc` for the soma-map) before it
  syncs; until then the run flags affected bookmarks in `needs_review`.
- **Owned infrastructure:** the `bookmarks-sync` Worker and its cron, the
  Bookmarks Sync vault, and its CI service account. The deployment token is
  minted by `scripts/provision.py` with Workers Scripts Write on the deployment
  account. Cloudflare enforces that permission at account scope, so separate
  tokens provide independent rotation but do not prevent access to sibling
  Workers. CI has no DNS, R2, D1, or Access administration permissions.
- Secrets: `GITHUB_TOKEN`, `GITHUB_PUBLIC_TOKEN`, `SOMA_HUB_TOKEN`, `SYNC_TOKEN` (see `.env.tpl`;
  vault `Bookmarks Sync`). Plain config (`SOMA_HUB_URL`) lives under `vars`
  in wrangler.jsonc, not in `.env.tpl`.
- **GitHub access:** both PATs are independently minted for this project.
  `GITHUB_TOKEN` is fine-grained: Starring read/write and Metadata read on
  owned repositories, for complete reads (including private stars) and
  private star/unstar writes. `GITHUB_PUBLIC_TOKEN` is classic with exactly
  `public_repo,user`, for public stars and all supported list writes. Never
  substitute the public-only reader for complete reads or grant classic
  `repo` scope implicitly. Private list writes are reported as unsupported,
  excluded from the write budget, and keep that repo's base unsettled.
  Preserve the common 50-write budget across both credentials. Renew each
  before its recorded expiration, store it in this project's ENV item, and
  verify complete reads and routed writes. Never deploy an agent credential.
- **soma access:** `SOMA_HUB_TOKEN` is this project's own hub token,
  enrolled with the Soma profile `bookmarks-sync-writer-v1`, granting exactly
  `tables:read:bookmarks` and `tables:write:bookmarks` (no other table, no
  file, admin or catalog-write grant). The Worker reads the `bookmarks`
  table's GitHub-repository rows including tombstones (`POST /v1/rows/pull`
  as one `{batch:[...]}` pull of up to 5,000 rows, following `next_cursor`) and the tag vocabulary
  (`GET /v1/catalog/options?table=bookmarks&column=tags`), and
  pushes catalog-valid rows grouped by column set (`POST /v1/rows/push`: new
  bookmarks, sparse tag and `needs_review` updates, soft deletes with
  `deleted_at = updated_at`, `updated_at` ISO-8601 UTC ms). The catalog
  enforces the one-bookmark-per-url and Github-tag rules; a rejected row is
  reported in the run summary and its repo is re-planned next run. Never deploy
  the agent's hub token. The hub is reached through the `SOMA_HUB` service
  binding (wrangler.jsonc `services`): a Worker cannot fetch a sibling
  workers.dev Worker over the network (Cloudflare error 1042). The binding
  only carries the same HTTP request the URL would; auth is still the token.
- **Cron**: hourly via `triggers.crons` in wrangler.jsonc; each run spends at
  most `MAX_GITHUB_WRITES` GitHub writes and refuses to remove more than
  `MAX_REMOVALS` repos (`run.ts`). Manual runs via `POST /api/sync` with
  `Authorization: Bearer $SYNC_TOKEN` (`?dry_run=true`,
  `?allow_removals=true`); the shared secret is a stopgap until CF Access
  fronts the Worker.
- **Custom Worker entry** (deviation from the template): the CF adapter
  writes its worker to the `main` of whatever wrangler config it reads and
  can't emit `scheduled()`, so the adapter reads `wrangler.build.jsonc`
  (set in vite.config.ts) while the real `wrangler.jsonc` `main` is
  `src/worker.ts`, which wraps the build output and adds the cron handler.
  Keep the two configs' `name`/`compatibility_date` in sync. Consequences:
  `checkJs` is off in tsconfig.json (svelte-check would otherwise type-check
  the generated bundle via the worker-configuration.d.ts `mainModule` import),
  and `vite build` must precede any wrangler deploy/dry-run.

## Architecture rules

- **Backend logic that exists to serve this site lives HERE** as SvelteKit
  server routes (`+page.server.ts`, `src/routes/api/*/+server.ts`) — it all
  compiles into the one Worker. Do not create a separate backend for form
  handling, D1 reads, or thin API glue.
- Heavier Python work (AI pipelines, scraping, long jobs) does NOT belong
  here — that's Modal or the mac mini (see the `infra` skill).
- Bindings (D1, R2, KV, cron triggers) are declared in `wrangler.jsonc` —
  that file IS the IaC. Access them via `platform.env` (typed in
  `worker-configuration.d.ts`; regenerate with `bun run gen`).
- Scheduled work attached to this site → [`triggers.crons`](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
  in wrangler.jsonc (free) — though Modal cron is the house default for
  standalone jobs.
- Private site? Put Cloudflare Access in front (Google SSO for browsers,
  Service Tokens for machine callers). Never roll custom auth for
  personal-only apps.

## Stack

Bun (never npm) · SvelteKit + Svelte 5 runes · Tailwind v4 · vitest ·
prettier. Config note: there is no `svelte.config.js` — adapter and compiler
options live in `vite.config.ts` inside the `sveltekit()` plugin.

## UI conventions

- ALL design tokens (colors, fonts, spacing, radii) go in the `@theme` block
  in `src/routes/layout.css`. Components consume tokens, never raw values.
- Icons: heroicons.com ONLY — never emojis or generic unicode.

## Commands

Standard verb set (see global AGENTS.md) — the justfile is the interface,
not a script catalog; one-offs go in `scripts/` and run directly.

| Command                   | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `just dev`                | Dev server (secrets injected via op)                |
| `just test`               | vitest                                              |
| `just check` / `just fmt` | wrangler types + svelte-check + prettier / auto-fix |
| `just build`              | Production build                                    |
| `just logs`               | `wrangler tail` on the deployed Worker              |
| `just sync-secrets`       | Push `.env.tpl` → Worker secrets                    |
| `just deploy`             | test + build + `wrangler deploy`                    |

## TDD

Write the test first (`*.spec.ts` next to the code, or `src/**/*.svelte.spec.ts`
for components), then the code. Tests mock all HTTP — CI
(`.github/workflows/ci.yml`: `just check` + `just test` on push/PR) needs no
secrets. `.github/workflows/deploy.yml` tests, builds, deploys, and syncs
runtime secrets on pushes to main using the project's own deployment token.
