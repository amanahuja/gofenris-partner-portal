# Fenris Partner Portal — Operations Reference

## Development & deployment

```bash
just dev       # run worker locally at localhost:8787 (uses live KV — real codes work)
just deploy    # deploy to Cloudflare
```

---

## Managing partner codes

Partner codes are stored in Cloudflare KV (`CLIENT_CODES` namespace). Each entry maps a short code to a GitHub folder path.

KV value format:
```json
{ "github_folder": "clients/acme" }
```

### Add a new partner

**Step 1 — Create the content folder in `gofenris/fenris-clients`:**

```
clients/
  <slug>/
    01-overview.md      ← required; contains YAML frontmatter + H1 + ## Overview
    02-<section>.md     ← optional; one ## heading per file, numeric prefix controls order
    ...
```

Frontmatter schema for `01-overview.md`:
```yaml
---
type: Retainer
timeline: Jan 2026 – Present
funder_chain: Funder → Partner → Fenris
summary: One sentence describing the engagement.
team:
  - name: Name
    role: Role
---

# Partner Name — Engagement Title

## Overview

Narrative paragraph.
```

**Step 2 — Add the KV entry:**

```bash
just set-client ACME01 clients/acme
```

**Step 3 — Share the code with the partner.**

---

### Edit a partner code (change folder)

Re-run `set-client` with the same code — it overwrites the existing entry:

```bash
just set-client ACME01 clients/acme
```

To edit via the Cloudflare dashboard: Workers & Pages → KV → `CLIENT_CODES` namespace → edit the key.

---

### Revoke a partner code

```bash
just revoke-client ACME01
```

Access is blocked immediately. Optionally archive or delete `clients/acme/` in the content repo.

---

### List all active codes

List keys  : `npx wrangler kv key list --namespace-id=084db5e549a64a3ebfb0c234550250cf --remote`
Get value  : `npx wrangler kv key get --namespace-id=084db5e549a64a3ebfb0c234550250cf --remote --text ACME01`

alternate: 
* List codes : `npx wrangler kv key list --binding=CLIENT_CODES {{kv_flags}`


List codes and folders, a bit of a messy recipe: 
```bash
just list-clients
```

### Inspect a specific code

```bash
just get-client ACME01
```

---

## Updating partner content

Edit markdown files in `gofenris/fenris-clients` and push. Changes are live immediately — no Worker redeployment needed.

```bash
# In your local clone of gofenris/fenris-clients:
git add . && git commit -m "Update Acme Q2 content" && git push
```

---

## Raw wrangler commands (without just)

If `just` isn't available, all operations use this pattern:

```bash
npx wrangler kv key put --binding=CLIENT_CODES "<CODE>" \
  '{"github_folder":"clients/<slug>"}' \
  --config fenris-client-worker/wrangler.jsonc --remote --preview false

npx wrangler kv key delete --binding=CLIENT_CODES "<CODE>" \
  --config fenris-client-worker/wrangler.jsonc --remote --preview false

npx wrangler kv key list --binding=CLIENT_CODES \
  --config fenris-client-worker/wrangler.jsonc --remote --preview false
```

> `--remote --preview false` is required because the KV namespace has both a production `id` and a `preview_id` configured.
