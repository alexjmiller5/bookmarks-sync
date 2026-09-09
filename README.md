# bookmarks-sync

One-way sync of GitHub starred repos into the Notion Bookmarks DB. Upserts
by repo URL (the unique key), tags each entry "Github". Runs as a Cloudflare
Worker: a CF cron trigger plus a manual sync endpoint, with a minimal status
page.

Architecture notes:

- **Cloudflare Worker, not the Python/Modal default** — per the project note
  ("try cloudflare r2 workers instead because gcp was a pain with
  terraform"). `wrangler.jsonc` IS the IaC, so no terraform module is needed.
- **No R2 for the MVP** — sync state lives in the Notion Bookmarks DB itself
  (URL is the unique key), so no blob storage is needed. ponytail: add an R2
  binding to wrangler.jsonc only if we later need caching beyond Notion.

## Sync semantics (assumptions)

- **One-way, GitHub → Notion.** The project title says "↔" but the valuable
  direction ships first; bidirectional can come later.
- **Never deletes.** A repo that gets un-starred is only reported
  (`diffStars().unstarred`) — bookmarks may be kept intentionally.
- **Upsert key** is the normalized URL (lowercase host, no trailing slash).
- **Field mapping** (verified against existing Github-tagged Bookmarks rows):
  `Description` (the DB's title property) = repo description,
  `Title` (rich_text) = `owner/repo: description`, `URL` = repo html_url,
  `Tags` = `["Github"]`. Repos without a description use `owner/repo` for
  both text fields.

Core logic lives in `src/lib/sync/` (`github.ts`, `notion.ts`, `diff.ts`,
`run.ts`), framework-free with vitest specs alongside. Every run emits one
structured `sync_run` JSON log line (starred/created/skipped/unstarred/errors)
— visible via `just logs`.

## Running the sync

- **Cron**: daily at 06:00 UTC — `triggers.crons: ["0 6 * * *"]` in
  `wrangler.jsonc` (free CF cron; deliberately not one of the 5 Modal slots).
- **Manual endpoint**: `POST /api/sync`, authed by the `SYNC_TOKEN` Worker
  secret (see `.env.tpl`); append `?dry_run=true` to diff without writing:

  ```bash
  curl -X POST "https://bookmarks-sync.<subdomain>.workers.dev/api/sync" \
    -H "Authorization: Bearer $(op read 'op://Bookmarks Sync/Bookmarks Sync Sync Token/token')"
  ```

  The shared-secret header is a stopgap until Cloudflare Access fronts this
  Worker (Service Tokens for machine callers) — swap it out then.

- **From this machine** (one-off, real writes unless `--dry-run`):

  ```bash
  op run --env-file=.env.tpl -- bun scripts/dry-run.ts --dry-run
  ```

## Layout

```
src/worker.ts     Worker entrypoint: SvelteKit fetch + scheduled() cron handler
src/routes/       pages + server routes (POST /api/sync lives here)
src/routes/layout.css   Tailwind + @theme design tokens
wrangler.jsonc    the IaC — bindings, cron triggers, domain
wrangler.build.jsonc    adapter-only build config (do not deploy with it)
.env.tpl          secrets manifest (1Password op:// refs, committed)
justfile          dev / test / check / fmt / build / logs / sync-secrets / deploy
```

The SvelteKit Cloudflare adapter writes its worker to the `main` of whatever
wrangler config it reads and cannot emit a `scheduled()` handler, so the
adapter is pointed at `wrangler.build.jsonc` (via `vite.config.ts`) and the
real `wrangler.jsonc` `main` is `src/worker.ts`, which wraps the build output
and adds the cron handler.

## Commands

`just dev` · `just test` · `just check` · `just fmt` · `just build` ·
`just logs` · `just sync-secrets` · `just deploy`

## CI

`.github/workflows/ci.yml` runs static checks and mocked tests on push/PR.
`.github/workflows/deploy.yml` tests, builds, deploys the Worker, and syncs
runtime secrets on pushes to main. The only GitHub secret is the project's
`OP_SERVICE_ACCOUNT_TOKEN`; deployment credentials come from its own vault.

## Setup

1. Create a dedicated GitHub fine-grained personal access token with
   **Starring: read** for the authenticated user's starred repositories.
   No repository writes or account administration permissions are needed.
   See [GitHub's endpoint permissions](https://docs.github.com/en/rest/activity/starring#list-repositories-starred-by-the-authenticated-user).
2. Create a dedicated Notion internal integration with read and insert content
   capabilities, and connect it only to the Bookmarks database.
3. Set the Bookmarks data-source ID in `wrangler.jsonc` under
   `vars.NOTION_DATA_SOURCE_ID`.
4. Bootstrap from a desktop-authenticated 1Password shell:

   ```bash
   op-project-bootstrap .env.tpl --repo <owner>/<repo>
   ```

   This creates the project vault, ENV and CI credential items, read-only
   service account, and GitHub secret. `scripts/provision.py` mints the
   Cloudflare deployment credential and random manual-sync token. Supply the
   newly created GitHub and Notion credentials when prompted. Never copy
   credentials from an agent or another project.

5. Run `op-project-bootstrap --check .env.tpl`, then push to main and verify
   the deploy workflow succeeded.

The project owns its Worker, cron, vault, and deployment token. It consumes
GitHub and the Notion Bookmarks database through their supported APIs.
Cloudflare's Workers Scripts Write permission applies to the deployment
account, so token separation gives independent rotation without enforcing
per-Worker access. The provisioner grants no R2, D1, DNS, or Access permissions.

To rotate a credential, mint and store its replacement, deploy, and verify
its actual API operations before revoking the predecessor by provider ID.
