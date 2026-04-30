# Fenris Client Portal — operations

worker_dir   := "fenris-client-worker"
config       := worker_dir / "wrangler.jsonc"
kv_flags     := "--config " + config + " --remote --preview false"
namespace_id := "084db5e549a64a3ebfb0c234550250cf"

_default: 
    @just --list 

# ── Development ─────────────────────────────────────────────────────────────

# Run the worker locally (uses remote KV — real client codes work immediately)
dev:
    cd {{worker_dir}} && npx wrangler dev

# Deploy the worker to Cloudflare
deploy:
    cd {{worker_dir}} && npx wrangler deploy

# ── Client codes (KV) ───────────────────────────────────────────────────────

# Add or update a client code
# Usage: just set-client ACME01 clients/acme
set-client code folder:
    npx wrangler kv key put --binding=CLIENT_CODES "{{code}}" \
        '{"github_folder":"{{folder}}"}' \
        {{kv_flags}}

# List all client codes with their folder
list-clients:
    #!/usr/bin/env bash
    for code in $(npx wrangler kv key list --namespace-id={{namespace_id}} --remote 2>/dev/null | jq -r '.[].name'); do
        folder=$(npx wrangler kv key get --namespace-id={{namespace_id}} --remote --text "$code" 2>/dev/null | jq -r '.github_folder')
        printf "%-12s %s\n" "$code" "$folder"
    done

# Show the value for a specific client code
# Usage: just get-client ACME01
get-client code:
    npx wrangler kv key get --binding=CLIENT_CODES "{{code}}" {{kv_flags}}

# Revoke a client code (delete the KV entry)
# Usage: just revoke-client ACME01
revoke-client code:
    npx wrangler kv key delete --binding=CLIENT_CODES "{{code}}" {{kv_flags}}
