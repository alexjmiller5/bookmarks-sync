# bookmarks-sync

Two-way sync between GitHub and the life-data `bookmarks` table. Every
starred repo is a bookmark tagged "Github" and every GitHub bookmark is a
star; GitHub list membership mirrors the bookmark's other tags. Runs as a
Cloudflare Worker: an hourly CF cron trigger plus a manual sync endpoint,
with a minimal status page.

Architecture notes:

- **Cloudflare Worker, not the Python/Modal default.** `wrangler.jsonc` IS
  the IaC, so no terraform module is needed.
- **Sync state is one Durable Object.** The `SyncState` object (SQLite
  backed, declared in `wrangler.jsonc`) holds the base: the stars, bookmarks
  and list memberships both sides agreed on after the last run. It needs no
  provisioning beyond a deploy.

## Sync semantics

- **Three-way merge.** Each run compares GitHub and life-data against the
  base. Whichever side differs from the base changed, so its value wins:
  - star a repo: a bookmark is created; unstar it: its bookmarks are
    soft-deleted.
  - bookmark a GitHub repo: it is starred; delete the bookmark: it is
    unstarred.
  - add a repo to a list or tag a GitHub bookmark: the other side follows,
    name by name, so changes on both sides in one run both survive.
- **First run is a union.** With no base, every bookmark gets starred and
  every star gets a bookmark.
- **Tags are lists.** Every `bookmarks.tags` option except Github mirrors the
  GitHub list of the same name. A missing list is created (public, with the
  tag's catalog description). A GitHub list with no matching tag option is
  kept on GitHub and flagged in the bookmark's `needs_review`; once the tag
  option exists, the next run syncs it and clears the flag. Lists are never
  deleted.
- **Repos are matched by GitHub node id**, so renames and transfers keep
  their bookmark. A bookmark url that resolves to no repository is flagged
  in `needs_review` and skipped until the url is fixed.
- **Limits per run:** at most `MAX_GITHUB_WRITES` (50) GitHub writes, so a
  large backlog drains hourly; a run that would remove more than
  `MAX_REMOVALS` (20) repos refuses to write anything unless called with
  `allow_removals=true`.
- **Field mapping for new bookmarks**: `description` = repo description (no
  trailing period), `title` = `owner/repo: description`, `url` = repo url,
  `tags` = `["Github", ...its lists]`. Repos without a description use
  `owner/repo` for both text fields.

Core logic lives in `src/lib/sync/`: `plan.ts` is the pure merge,
`github.ts` and `lifedata.ts` are the API layers, and `run.ts` applies a
plan. Each file has vitest specs alongside. Every run emits one structured
`sync_run` JSON log line, visible via `just logs`.

## Running the sync

- **Cron**: hourly, `triggers.crons: ["0 * * * *"]` in `wrangler.jsonc`
  (free CF cron; deliberately not one of the 5 Modal slots).
- **Manual endpoint**: `POST /api/sync`, authed by the `SYNC_TOKEN` Worker
  secret. `?dry_run=true` plans without writing; `?allow_removals=true`
  lifts the mass-removal guard for one run:

  ```bash
  curl -X POST "https://bookmarks-sync.<subdomain>.workers.dev/api/sync?dry_run=true" \
    -H "Authorization: Bearer $SYNC_TOKEN"
  ```

  The shared-secret header is a stopgap until Cloudflare Access fronts this
  Worker (Service Tokens for machine callers).

- **From this machine**, a preview that never writes. It plans from an empty
  base, so it shows what a first run would do:

  ```bash
  op run --env-file=.env.tpl -- bun scripts/dry-run.ts
  ```

## Layout

```
src/worker.ts     Worker entrypoint: SvelteKit fetch, scheduled() cron handler, SyncState DO
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

1. Create a dedicated GitHub fine-grained personal access token with the
   account permission **Starring: Read and write** (stars and lists) and
   **Metadata: Read** on all repositories, so private stars resolve. No
   repository contents or administration permissions are needed.
2. Mint a dedicated life-data hub token with `tables:read,tables:write`
   (`life token create bookmarks-sync --scopes tables:read,tables:write`).
3. Set the hub URL in `wrangler.jsonc` under `vars.LIFE_HUB_URL`.
4. Bootstrap from a desktop-authenticated 1Password shell:

   ```bash
   op-project-bootstrap .env.tpl --repo <owner>/<repo>
   ```

   This creates the project vault, ENV and CI credential items, read-only
   service account, and GitHub secret. `scripts/provision.py` mints the
   Cloudflare deployment credential and random manual-sync token. Supply the
   newly created GitHub and hub credentials when prompted. Never copy
   credentials from an agent or another project.

5. Run `op-project-bootstrap --check .env.tpl`, then push to main and verify
   the deploy workflow succeeded.

The project owns its Worker, cron, vault, and deployment token. It consumes
GitHub and the life-data hub through their supported APIs.
Cloudflare's Workers Scripts Write permission applies to the deployment
account, so token separation gives independent rotation without enforcing
per-Worker access. The provisioner grants no R2, D1, DNS, or Access permissions.

To rotate a credential, mint and store its replacement, deploy, and verify
its actual API operations before revoking the predecessor by provider ID.
