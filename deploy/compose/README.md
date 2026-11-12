# Drawboard with Docker Compose

One host, Docker Compose v2, a reverse proxy that terminates TLS in front of it, and an OpenID
Connect provider for sign-in. For Kubernetes use the Helm chart (`../helm/drawboard`).

| Service | Image | Notes |
|---|---|---|
| frontend | `ghcr.io/dergeorg/drawboard-frontend` | nginx: the web app, proxies `/api` and the WebSocket to the backend. The only port. |
| backend | `ghcr.io/dergeorg/drawboard-backend` | Spring Boot, one instance (collaboration state is in memory) |
| db | `postgres:18-alpine` | volume `db-data` |
| gotenberg | `gotenberg/gotenberg` | Office documents -> PDF, on a network without a route out |
| files-owner | `busybox` | runs once per start: gives the `files` volume to the backend's user (uid 10001) |

## Local trial (5 minutes, nothing to configure)

Everything on your machine, with a bundled Keycloak and three users. Not for a server others can
reach: the passwords are the user names and it runs on plain HTTP.

```sh
./generate-keys.sh
docker compose -f docker-compose.yml -f compose.trial.yaml --env-file trial/trial.env up -d
```

Open <http://localhost:8080> and sign in as `anna` / `anna` (admin), `ben` / `ben` or
`chris` / `chris`. Open a second browser (or a private window) as another user to see live
collaboration. The first start takes a minute or two (database migrations); on a Mac with Apple
silicon longer, because the images are built for linux/amd64 and run emulated.

Stop: `docker compose -f docker-compose.yml -f compose.trial.yaml --env-file trial/trial.env down`
(add `-v` to delete the data).

## Install

1. **Get the files** - this folder (`docker-compose.yml`, `.env.example`, `generate-keys.sh`).
2. **Keys**: `./generate-keys.sh` creates `keys/file_url_keys`, `keys/plugin_pseudonym_key` and
   `keys/guest_signing_keys` (never overwrites existing ones). Keep them: new keys end every signed
   file URL and guest session. Back them up with the data.
3. **Configure**: `cp .env.example .env` and set at least `PUBLIC_URL`, `OIDC_ISSUER_URI` and
   `DB_PASSWORD` (`openssl rand -base64 32`). Set up the identity provider (below).
4. **Reverse proxy**: forward `https://<your host>` to `http://127.0.0.1:8080` (`HTTP_PORT`), with
   WebSocket upgrade allowed and `X-Forwarded-For` appended. Example for nginx:

   ```nginx
   location / {
     proxy_pass http://127.0.0.1:8080;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection $connection_upgrade;   # map $http_upgrade $connection_upgrade {...}
     proxy_set_header Host $host;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
     client_max_body_size 60m;
   }
   ```

   Caddy: `reverse_proxy 127.0.0.1:8080` does all of that by itself.
5. **Start**: `docker compose up -d`, then `docker compose ps` until everything is `healthy`.
6. **Sign in** at `PUBLIC_URL`. Users are created on their first sign-in; members of `ADMIN_GROUP`
   are instance admins.

## Identity provider

Drawboard speaks plain OpenID Connect. The provider needs:

* a **public client** `drawboard` (`OIDC_CLIENT_ID`) with authorization code + PKCE (S256) and exactly
  these redirect URIs: `<PUBLIC_URL>/auth/callback` and `<PUBLIC_URL>/silent-renew.html`,
  post-logout redirect `<PUBLIC_URL>/`, web origin (CORS) `<PUBLIC_URL>`;
* **access tokens as JWT** (RS256, ES256 or PS256) whose `aud` contains `drawboard-api`
  (`OIDC_AUDIENCE`) and whose `iss` is exactly `OIDC_ISSUER_URI`;
* scopes `openid profile email` and, for admins and group sharing, a `groups` claim with the group
  names.

**Keycloak:** client `drawboard` (public, standard flow, PKCE S256), an audience mapper that adds
`drawboard-api` to the access token, a client scope `groups` with a group membership mapper (claim
`groups`, full path off). `trial/realm.json` is a working example.
**Authelia:** client with `public: true`, `require_pkce: true`, `pkce_challenge_method: S256`,
`audience: [drawboard-api]`, `access_token_signed_response_alg: RS256` (otherwise the access tokens are
opaque and every call is a 401), the SPA origin in the client's CORS `allowed_origins`, scopes
`openid profile email groups`.
**Authentik:** an OAuth2/OpenID provider with client type *public*, the redirect URI above, signing
key set, and a scope mapping that puts `drawboard-api` into `aud` of the access token.

If the backend reaches the provider under another address than the issuer (same host, internal
network), set `OIDC_JWK_SET_URI` to the internal JWKS URL; `OIDC_ISSUER_URI` stays the public one.

## Trusted proxies

The backend believes `X-Forwarded-For` only from `TRUSTED_PROXIES`. It must list the frontend's
network (`WEB_SUBNET`, default `172.30.37.0/24`) and, if your reverse proxy runs on another host or in
another Docker network, its address. Wrong values make every user look like one address, and the rate
limits then count all users together. Check it once: open `PUBLIC_URL/s/x` (a made-up guest link),
then find the audit event `library.share.exchange-failed` in the backend log - its `ip` must be your
real client address. If `WEB_SUBNET` overlaps a network on your host, change both values.

## Update, backup

* **Update**: set `DRAWBOARD_BACKEND_VERSION` / `DRAWBOARD_FRONTEND_VERSION` in `.env`, then
  `docker compose pull && docker compose up -d`. Migrations run on start; there is no automatic
  rollback, so back up first.
* **Backup**: the volumes `drawboard_db-data` (or `docker compose exec db pg_dump -U drawboard drawboard`)
  and `drawboard_files`, plus `keys/` and `.env`. Test a restore.

## Before enabling guest links

`GUESTS_ENABLED=true` lets people without an account open boards through shared links. Do these
first: trusted proxies verified (above); `keys/guest_signing_keys` kept secret; TLS and the headers
`Referrer-Policy: no-referrer` and `Content-Security-Policy` checked through your reverse proxy
(`curl -sI https://<host>/s/x`); tested backups. Guests on EDITOR links can change content - hand out
VIEWER or COMMENTER links unless editing is the point. Third-party plugins additionally need their
own hostname (`PLUGIN_ORIGIN`, proxied to the same frontend port). Details: the chart README,
"Before enabling guest links".
