#!/usr/bin/env bash
# Fetches an access token from the LOCAL dev Keycloak via the dev-only client
# drawboard-dev (password grant). Local test values only – see dev/README.md.
#
#   dev/scripts/token.sh [alice|bob]            -> prints the access token
#   dev/scripts/token.sh alice --claims         -> prints the decoded claims
#   curl -H "Authorization: Bearer $(dev/scripts/token.sh alice)" localhost:18081/api/...
set -euo pipefail

user="${1:-alice}"
issuer="${OIDC_ISSUER_URI:-http://localhost:18180/realms/drawboard}"

token=$(curl -sf -X POST "$issuer/protocol/openid-connect/token" \
  -d grant_type=password \
  -d client_id=drawboard-dev \
  -d client_secret=drawboard-dev-secret \
  -d "username=$user" \
  -d "password=$user-dev" |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')

if [[ "${2:-}" == "--claims" ]]; then
  echo "$token" | cut -d. -f2 | python3 -c '
import base64, json, sys
s = sys.stdin.read().strip(); s += "=" * (-len(s) % 4)
c = json.loads(base64.urlsafe_b64decode(s))
print(json.dumps({k: c.get(k) for k in ("iss", "aud", "azp", "sub", "preferred_username", "name", "email", "groups", "scope", "exp")}, indent=2))'
else
  echo "$token"
fi
