# AGENTS.md

bookmarks-sync: one-way sync of GitHub starred repos → the life-data
`bookmarks` table (upsert by URL, tagged "Github"). Cloudflare Worker (cf-site
template) with a minimal status page; sync runs as a server route on a CF
cron trigger + manual endpoint.

## Project decisions

- **CF Worker, not modal-service**: wrangler.jsonc IS the IaC — no terraform.
- **No R2 for MVP**: sync state lives in the life-data `bookmarks` table
  itself (URL is the unique key). Add an R2 binding to wrangler.jsonc only if
  we later need caching beyond the hub.
- **One-way sync only** (GitHub → life-data) for now.
- **Owned infrastructure:** the `bookmarks-sync` Worker and its cron, the
  Bookmarks Sync vault, and its CI service account. The deployment token is
  minted by `scripts/provision.py` with Workers Scripts Write on the deployment
  account. Cloudflare enforces that permission at account scope, so separate
  tokens provide independent rotation but do not prevent access to sibling
  Workers. CI has no DNS, R2, D1, or Access administration permissions.
- Secrets: `GITHUB_TOKEN`, `LIFE_HUB_TOKEN`, `SYNC_TOKEN` (see `.env.tpl`;
  vault `Bookmarks Sync`). Plain config (`LIFE_HUB_URL`) lives under `vars`
  in wrangler.jsonc, not in `.env.tpl`.
- **GitHub access:** `GITHUB_TOKEN` is this project's independently minted
  fine-grained PAT. It has Starring read and repository Metadata read on all
  current and future repositories owned by the authenticated account, which
  preserves private-star discovery without granting source-code or write
  access. GitHub limits a fine-grained PAT to one resource owner; adding stars
  from another owner's private repositories requires reviewing that boundary.
  Renew through GitHub's token settings before its recorded expiration, store
  the replacement in this project's ENV item, and compare complete paginated
  star identities before deploying. Never use the agent's GitHub PAT at runtime.
- **life-data access:** `LIFE_HUB_TOKEN` is this project's own hub token
  (`life token create bookmarks-sync --scopes tables:read,tables:write`),
  scoped to row pulls and pushes; it holds no admin or file grants. The
  Worker reads the `bookmarks` table's live Github-tagged rows
  (`POST /v1/rows/pull`) and pushes one catalog-valid row per new star
  (`POST /v1/rows/push`: fresh 32-hex id, `url`, `title`, `description` with no
  trailing period, `tags` `["Github"]`, `updated_at` ISO-8601 UTC ms). The
  catalog enforces the one-bookmark-per-url and Github-tag rules; a rejected
  row is reported in the run summary, never retried blindly. Never deploy
  the agent's hub token.
- **Cron**: daily 06:00 UTC via `triggers.crons` in wrangler.jsonc; manual
  runs via `POST /api/sync` with `Authorization: Bearer $SYNC_TOKEN` — a
  stopgap until CF Access fronts the Worker.
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
