# Canonical secrets manifest — 1Password secret references only, SAFE to commit.
# Refs are BY NAME on purpose: op-project-bootstrap parses this file.
# Worker bindings (D1, R2, KV) are NOT secrets — they go in wrangler.jsonc.
# Local dev:      op run --env-file=.env.tpl -- bun run dev
# Push to CF:     just sync-secrets
GITHUB_TOKEN=op://Bookmarks Sync/Bookmarks Sync ENV/GITHUB_TOKEN
LIFE_HUB_TOKEN=op://Bookmarks Sync/Bookmarks Sync ENV/LIFE_HUB_TOKEN
SYNC_TOKEN=op://Bookmarks Sync/Bookmarks Sync ENV/SYNC_TOKEN
