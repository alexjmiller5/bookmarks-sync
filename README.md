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

`.github/workflows/ci.yml` runs `just check` + `just test` on push/PR. Tests
mock all HTTP, so CI needs zero secrets.

There is deliberately **no deploy job yet** — it needs the 1P vault + service
account from the setup section below. Once those exist, add a `deploy` job to
the same workflow (push-to-main only), with `OP_SERVICE_ACCOUNT_TOKEN` as the
repo's single GH secret:

```yaml
deploy:
  needs: ci
  if: github.ref == 'refs/heads/main'
  runs-on: ubuntu-latest
  env:
    OP_SERVICE_ACCOUNT_TOKEN: ${{ secrets.OP_SERVICE_ACCOUNT_TOKEN }}
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - uses: 1Password/install-cli-action@v4
    - uses: 1password/load-secrets-action@v2
      with:
        export-env: true
      env:
        CLOUDFLARE_API_TOKEN: op://Bookmarks Sync/cloudflare/api-token
        CLOUDFLARE_ACCOUNT_ID: op://Bookmarks Sync/cloudflare/account-id
    - run: bun install --frozen-lockfile
    - run: bun run build
    - run: bunx wrangler deploy
    # after deploy — `wrangler secret put` needs the Worker to exist
    - run: ./scripts/sync-secrets.sh
```

## One-time setup

A 1Password service account cannot create vaults or service accounts, so
these are manual. Run once:

```bash
# 1. Project vault + credential items
op vault create "Bookmarks Sync"
op item create --category "API Credential" --title "Bookmarks Sync GitHub PAT" \
  --vault "Bookmarks Sync" "token[concealed]=<a GitHub PAT with read:user scope, for reading your starred repos>"
op item create --category "API Credential" --title "Bookmarks Sync Notion API Key" \
  --vault "Bookmarks Sync" "token[concealed]=<a Notion internal integration secret with access to the Bookmarks DB>"
op item create --category "API Credential" --title "Bookmarks Sync Sync Token" \
  --vault "Bookmarks Sync" "token[concealed]=$(openssl rand -hex 32)"
# CI deploy creds (for the future deploy job — see the CI section above)
op item create --category "API Credential" --title "cloudflare" \
  --vault "Bookmarks Sync" \
  "api-token[concealed]=<CF API token with Workers edit>" \
  "account-id[text]=<CF account id>"

# 2. Read-only CI service account, token stored in your own vault
OUT=$(op service-account create "bookmarks-sync-ci" \
  --vault "Bookmarks Sync:read_items" --format json </dev/null)
op item create --category "API Credential" \
  --title "Bookmarks Sync CI op Service Account Token" --vault "<your vault>" \
  "token[concealed]=$(echo "$OUT" | jq -r .token)" </dev/null

# 3. GitHub repo + the single CI secret
gh repo create <owner>/<repo> --source . --push
gh secret set OP_SERVICE_ACCOUNT_TOKEN \
  --body "$(op read 'op://<your vault>/Bookmarks Sync CI op Service Account Token/token')"

# 4. Push Worker secrets (GITHUB_TOKEN, NOTION_API_KEY, SYNC_TOKEN)
just sync-secrets
```

Also:

- Share the Notion integration with the Bookmarks DB (Notion UI:
  Bookmarks DB → connections → add the integration).
- Set `NOTION_DATA_SOURCE_ID` (under `vars` in `wrangler.jsonc`) to your
  Bookmarks DB's data-source id — plain config, not a secret, so it lives in
  the wrangler config rather than `.env.tpl`. Both the Worker and
  `scripts/dry-run.ts` read it from there.
