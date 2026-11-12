# Local development environment (local only)

Everything here is meant **for the Mac only**. Passwords, secrets and users in
`compose*.yaml` and `dev/` are throwaway test values and belong nowhere else.
No service uses port 8080 on the host (another container listens there on the Mac).

| File | Contents |
|---|---|
| `compose.yaml` | PostgreSQL 18, Keycloak 26.7.4 (dev mode), keycloak-config-cli |
| `compose.observability.yaml` | optional: Alloy, Tempo, Loki, Prometheus, Grafana |
| `dev/keycloak/drawboard-realm.json` | realm `drawboard` (clients, groups, test users) |
| `dev/observability/` | configuration of Alloy, Tempo, Loki, Prometheus, Grafana |
| `dev/observability/grafana/gen_service_dashboards.py` | generator of the service dashboards |
| `dev/logs/` | ECS log files of an app on the Mac (Alloy → Loki), not in Git |
| `dev/sourcemaps/` | hidden source maps of a locally run frontend image, per version (Alloy faro.receiver), not in Git |
| `dev/scripts/token.sh` | fetch a token for alice/bob |
| `dev/scripts/smoke-observability.sh` | smoke test: trace, log, metric via OTLP → Tempo/Loki/Prometheus |
| `dev/scripts/check_panels.py` | runs every query of the service dashboards through Grafana and reports panels without data |

## Starting and stopping

```bash
# database + Keycloak only
docker compose up -d

# with observability
docker compose -f compose.yaml -f compose.observability.yaml up -d

# status (keycloak-config-cli and tempo-init are one-shot containers: "Exited (0)" is correct)
docker compose -f compose.yaml -f compose.observability.yaml ps -a

# stop (data is kept)
docker compose -f compose.yaml -f compose.observability.yaml down

# reset everything (database, logs, traces, metrics gone)
docker compose -f compose.yaml -f compose.observability.yaml down -v
```

Flyway refuses to start when an applied migration changed. While the hexagonal
rebuild is unreleased its V1 migrations are still edited in place (`text`,
`timestamp`, no triggers) - after pulling such a change, reset with `down -v`.

Tempo and Loki are distroless images without a shell, so they have no
Docker health check. Check readiness: `curl localhost:13200/ready`,
`curl localhost:13100/ready`.

## Ports

| Port (host) | Service | Purpose |
|---|---|---|
| 15432 | postgres | database `drawboard`, user/password `drawboard`/`drawboard` |
| 18180 | keycloak | Keycloak (also 18180 inside the container), admin console `admin`/`admin` |
| 19000 | keycloak | management: `/health/ready`, `/metrics` |
| 4317 / 4318 | alloy | OTLP gRPC / HTTP – this is where the app sends traces and metrics |
| 12345 | alloy | Alloy UI (pipeline graph, component state) |
| 12347 | alloy | Faro receiver (`faro.receiver`): browser telemetry of the frontend, `POST /collect` |
| 13000 | grafana | Grafana |
| 19090 | prometheus | Prometheus |
| 13100 | loki | Loki API |
| 13200 | tempo | Tempo API |

Reserved for the frontend (not started by these Compose files):

| Port (host) | What | Purpose |
|---|---|---|
| 18081 / 18082 | backend (`bootRun`) | API `/api/…`, Swagger UI / management (health) |
| 4200 | frontend dev server (`ng serve`) | proxies `/api` → 18081 and `/faro` → 12347 |
| 18090 | frontend image run locally (`docker run -p 18090:8080 …`) | same origin for app, `/api` and `/faro` (the image's nginx forwards them); E2E tests run against it |

See [Frontend (local)](#frontend-local).

## Database

- JDBC: `jdbc:postgresql://localhost:15432/drawboard`
- R2DBC: `r2dbc:postgresql://localhost:15432/drawboard`
- from a container in the Compose network: host `postgres`, port `5432`
- user `drawboard`, password `drawboard` – one user for everything

The schemas of the modules (`library`, `users`, `auditing`) are created by the app's **Flyway**, not by the
Compose file.

## Keycloak

Realm `drawboard` (local dev case). In the central dergeorg Keycloak the app lives
in the realm **`dergeorg`** instead, with the same client names - then only
`OIDC_ISSUER_URI` changes (`…/realms/dergeorg`). The dev client `drawboard-dev`
**never** belongs in a shared realm. The backend itself only speaks standard OpenID
Connect: any other provider is bound through the `OIDC_*` variables (see the README).

| Client | Type | Purpose |
|---|---|---|
| `drawboard-api` | bearer-only, all flows off | the resource server; its name is the audience (`OIDC_AUDIENCE`) |
| `drawboard-web` | public, standard flow + PKCE S256, `fullScopeAllowed=false`, **audience mapper** → `drawboard-api` | SPA (`http://localhost:4200` dev server, `http://localhost:18090` image) and Swagger UI (`http://localhost:18081/swagger-ui/…`) |
| `drawboard-dev` | confidential, **only** direct access grant (password), secret `drawboard-dev-secret`, `fullScopeAllowed=false`, audience mapper | local only: tokens via curl/Postman |

**Keycloak needs the audience mapper.** Without an `oidc-audience-mapper` that puts
`drawboard-api` into `aud`, no token is accepted: the backend refuses every token whose
`aud` does not contain `OIDC_AUDIENCE`. (Both clients above have it; add it to every new client.)

Both clients also get the client scope `groups` (a *group membership* mapper, full path
**off**), so tokens carry `"groups": ["drawboard-admins"]` - the same shape Authelia sends.
Permissions on boards do **not** come from roles in the token; the groups are only used for
the instance-admin flag (`DRAWBOARD_ADMIN_GROUP`).

Test users (throwaway values, local only):

| User | Password | Group |
|---|---|---|
| `alice` | `alice-dev` | `drawboard-admins` (instance admin when the backend runs with the dev profile) |
| `bob` | `bob-dev` | `drawboard-users` |

`drawboard-web` allows exactly these local origins:

| Setting | Values |
|---|---|
| `redirectUris` | `http://localhost:4200/*`, `http://localhost:18090/*`, `http://localhost:18081/swagger-ui/oauth2-redirect.html` |
| `webOrigins` | `+` (= the redirect URIs, CORS of the token endpoint for exactly these origins) |
| `post.logout.redirect.uris` | `http://localhost:4200/*`, `http://localhost:18090/*` (Keycloak separates them with `##`) |

If the backend or the frontend runs locally on another port, add it there (and
re-run keycloak-config-cli, see below). Never add a wildcard redirect URI.

### Authelia (for reference)

Authelia can be bound directly (`OIDC_ISSUER_URI=https://auth…`). It issues **opaque** access
tokens unless the client sets `access_token_signed_response_alg: RS256` - the backend validates
JWTs, so set that, and make the `aud` of the access token contain `OIDC_AUDIENCE`
(`audience` of the client).

### Getting a token

```bash
dev/scripts/token.sh alice            # access token
dev/scripts/token.sh bob --claims     # decoded claims (aud, groups, name, email …)

curl -H "Authorization: Bearer $(dev/scripts/token.sh alice)" http://localhost:18081/api/users/me
```

Without the script:

```bash
curl -s -X POST http://localhost:18180/realms/drawboard/protocol/openid-connect/token \
  -d grant_type=password -d client_id=drawboard-dev -d client_secret=drawboard-dev-secret \
  -d username=alice -d password=alice-dev
```

Expected: `iss` = `http://localhost:18180/realms/drawboard`, `aud` = `drawboard-api`,
`groups` = `["drawboard-admins"]`. `drawboard-web` rejects the password grant
(`unauthorized_client`) - as intended.

### Backend configuration

| Variable | App on the Mac (profile `dev` sets it) | App as a container in the network `drawboard_default` |
|---|---|---|
| `OIDC_ISSUER_URI` | `http://localhost:18180/realms/drawboard` | `http://localhost:18180/realms/drawboard` (same, `iss` is fixed) |
| `OIDC_JWK_SET_URI` | - (found through the discovery document) | `http://keycloak:18180/realms/drawboard/protocol/openid-connect/certs` |
| `OIDC_AUDIENCE` | `drawboard-api` (**required**) | `drawboard-api` |
| `DRAWBOARD_ADMIN_GROUP` | `drawboard-admins` | `drawboard-admins` |

`KC_HOSTNAME=http://localhost:18180` makes sure that `iss` is always the same, no matter
whether the Mac or a container fetches the token.

### Changing the realm

Edit `dev/keycloak/drawboard-realm.json` and apply it again:

```bash
docker compose up -d keycloak-config-cli      # runs once, idempotent
docker compose logs keycloak-config-cli
```

keycloak-config-cli (`adorsys/keycloak-config-cli:6.5.1-26`) is the latest
version, but officially only built up to Keycloak 26.5.5; a 26.7 version is
still open upstream (adorsys/keycloak-config-cli#1668). Verified locally with this realm file
against 26.7.4: import, second run (unchanged, skipped),
tokens correct. For new realm fields the tool does not know, wait for the
next release.

## Frontend (local)

What the Angular frontend needs from this stack:

| What | Value |
|---|---|
| Backend URL (target of the `/api` proxy) | `http://localhost:18081` (from a container: `http://host.docker.internal:18081`) |
| Keycloak issuer | `http://localhost:18180/realms/drawboard` (the same inside containers, `KC_HOSTNAME` pins it) |
| Keycloak client (public, PKCE S256) | `drawboard-web` |
| API client (audience, permissions) | `drawboard-api` — permissions are `resource_access.drawboard-api.roles` |
| Faro receiver (target of the `/faro` proxy) | `http://localhost:12347` (from a container: `http://host.docker.internal:12347`); the SDK posts to `/faro/collect` |
| Test users | `alice`/`alice-dev` (read + write), `bob`/`bob-dev` (read only) |

The browser only talks to its own origin: `/api/*` and `/faro/*` are forwarded by
the dev server (`proxy.conf`) or by the image's nginx. No CORS on the backend,
no backend URL in the bundle. The Faro receiver additionally accepts direct
CORS posts from `http://localhost:4200` and `http://localhost:18090` (e.g. to
test without the proxy); every other origin gets no `Access-Control-Allow-Origin`.

Error codes `BAD_GATEWAY` (502) and `GATEWAY_TIMEOUT` (504) of the contract
(1.1.0) are written by that proxy when the backend is down or too slow; the
backend itself never sends them.

Order of starting things:

```bash
docker compose -f compose.yaml -f compose.observability.yaml up -d   # Postgres, Keycloak, observability
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 MANAGEMENT_OTLP_METRICS_EXPORT_ENABLED=true \
LOGGING_FILE_NAME=$PWD/dev/logs/drawboard-backend.log ./gradlew bootRun   # backend :18081
# frontend repository: ng serve (:4200) or the image on :18090
```

The image on 18090 (container port = the image's nginx port; variable names as
defined by the frontend's runtime config):

```bash
docker run --rm -p 18090:8080 \
  -e APP_ENVIRONMENT=local \
  -e BACKEND_URL=http://host.docker.internal:18081 \
  -e AUTH_ISSUER=http://localhost:18180/realms/drawboard -e AUTH_CLIENT_ID=drawboard-web \
  -e FARO_RECEIVER_URL=http://host.docker.internal:12347 \
  registry.dergeorg.at/samples/drawboard/frontend:<version>
```

Source maps: the image build writes hidden source maps; to get readable stack
traces in Loki, copy them to `dev/sourcemaps/<APP_VERSION>/` (Faro `app.release`
= the image version). `ng serve` output is not minified and needs none.

## Observability

```
App ──OTLP (traces, metrics)──► Alloy :4317/:4318 ─┬─ traces  ► Tempo ─ metrics-generator ─► Prometheus
                                                   ├─ metrics ► Prometheus /api/v1/otlp
                                                   └─ OTLP logs ► Loki /otlp (the app does not use this)
App container stdout (ECS JSON) ──► Alloy (Docker socket) ──► Loki
Browser (Faro Web SDK) ──/faro proxy──► Alloy faro.receiver :12347 ─┬─ logs, errors, web vitals, events ► Loki (job="faro")
                                                                    └─ traces ► Tempo (parent of the backend spans)
```

This is the planned production setup (research D) in miniature – the same
versions (Alloy v1.20.1, Tempo 3.1.0, Loki 3.7.8, Prometheus v3.13.4 LTS) and
the same configurations, so that this also tests the prod plan at the same time.

### Connecting the app

App on the Mac (`./gradlew bootRun`, profile `dev`, port 18081, management 18082):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 MANAGEMENT_OTLP_METRICS_EXPORT_ENABLED=true ./gradlew bootRun
```

The rest is already in `modules/core/src/main/resources/application*.yaml`:
`service.namespace=drawboard`, `deployment.environment.name` from `APP_ENVIRONMENT`
(profile dev: `dev`), `base-time-unit: seconds` (otherwise the metrics are named
`*_milliseconds_*`), sampling 100 %, in profile dev `step: 10s` instead of 1 min.
Without `MANAGEMENT_OTLP_METRICS_EXPORT_ENABLED=true` the profile dev sends no
metrics (so that `bootRun` without the observability stack does not export into the void).

Logs of an app on the Mac: Alloy reads container stdout, an app on the Mac
has none. That is why, with `LOGGING_FILE_NAME`, it additionally writes its ECS lines
to a file under `dev/logs/` (`logging.structured.format.file: ecs`
is set in `application.yaml`); Alloy reads `dev/logs/*.log` (mounted at
`/var/log/host-apps`) and treats the lines like those of a container with
`at.dergeorg.log-format=ecs`, `service_name` comes from the line's `service.name`:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 MANAGEMENT_OTLP_METRICS_EXPORT_ENABLED=true \
LOGGING_FILE_NAME=$PWD/dev/logs/drawboard-backend.log ./gradlew bootRun
```

`dev/logs/*.log*` is in `.gitignore`. Spring rotates the file itself (10 MB).

Running the app as a container in the Compose network works too – then without a file, Alloy reads
stdout (labels!):

```yaml
# Example of an app service in the Compose network
services:
  app:
    image: drawboard-backend:dev
    ports: ["18081:18081"]
    labels:
      at.dergeorg.service: drawboard-backend   # -> Loki label service_name
      at.dergeorg.log-format: ecs              # -> Alloy parses ECS JSON
    environment:
      SERVER_PORT: "18081"                     # never 8080, not even in the container
      APP_ENVIRONMENT: dev
      OTEL_EXPORTER_OTLP_ENDPOINT: http://alloy:4318
      MANAGEMENT_OTLP_METRICS_EXPORT_ENABLED: "true"
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_PASSWORD: drawboard
      OIDC_ISSUER_URI: http://localhost:18180/realms/drawboard
      OIDC_JWK_SET_URI: http://keycloak:18180/realms/drawboard/protocol/openid-connect/certs
      OIDC_AUDIENCE: drawboard-api
```

From the ECS lines Alloy makes: label `service_name`, `deployment_environment_name`
(from `service.environment`) and structured metadata `trace_id`, `span_id`,
`request_id`, `level`. You find a request in Grafana → Explore → Loki with
`{service_name="drawboard-backend"} | request_id="<X-Request-Id>"`.

### Grafana

<http://localhost:13000> – without login (anonymous, role Viewer, may use Explore).
For admin tasks use "Sign in" at the top right with `admin`/`admin`; the API also works with
`curl -u admin:admin …`.

Folder **Services** (home page = "10 · Services"):

| Dashboard | Contents |
|---|---|
| 10 · Services | services per environment: req/s, 5xx rate, p95, age of the latest telemetry; service map; alerts |
| 11 · HTTP (RED) | per route: req/s, 5xx, p50/p95/p99 with exemplars, heatmap, status codes, exceptions, slowest/most frequent routes |
| 12 · Spans & Service-Map | service map, RED per `@WithSpan` function (Tempo span-metrics and Micrometer `app.method`), RED per span, latest failed traces |
| 13 · JVM | heap/pools, GC, allocation, threads, CPU, classes, buffers, log events, restarts |
| 14 · Datenbank | R2DBC pool, HikariCP (MVC), query latency, DB spans, repository calls |
| 15 · Logs | log lines per level, errors, logs with search; `trace_id` → Tempo |
| 16 · Frontend | Faro: web vitals p75 (LCP/INP/CLS/FCP/TTFB) per view, JavaScript errors with source-mapped stack, API calls from the browser's view per route, page views, browser traces with errors |
| 17 · Drawboard usage | the product metrics of the application (architecture, section 3.11): boards, active users 24 h/7 d/30 d, open sessions, collaboration updates and their size, storage by kind, uploads and conversions by result, share links and guest sessions, planning poker rounds, votes and refusals |

**Alerts**: the local stack has none. The Drawboard rule `svc-drawboard-scan-unavailable`
(`increase(drawboard_scans_total{result="unavailable"}[15m]) > 0`, prod only) is kept in
`observability/grafana/drawboard_alert_rules.py` in the tuple format of `SERVICE_RULES` and moves into the homelab generator
(`monitoring/grafana/gen_alerts.py`) when the scanner goes to production.

Variables: `env` (`deployment_environment_name`), `service` (`service_name`), `route` (`uri`);
17 · Drawboard usage: `env`, `service`; 16 · Frontend: `env`, `app` (Faro `app.name` = `service_name`, e.g. `drawboard-frontend`), `view` (route template).

Faro data in Loki: `{job="faro", service_name="drawboard-frontend"}`, label `kind`
(`log`, `exception`, `measurement`, `event`), structured metadata `trace_id` and
`session_id`. The browser's fetch span is the parent of the backend's server
span, so Tempo shows one trace from the click to the SQL query, and the
backend's `X-Request-Id` is that trace id.

Cross-links: trace → logs (`trace_id` in Loki) and → metrics (span-metrics),
exemplar points in latency panels → trace, log line → trace ("Trace öffnen").

Changing dashboards: only via the generator, never in the UI (`allowUiUpdates: false`):

```bash
python3 dev/observability/grafana/gen_service_dashboards.py \
  dev/observability/grafana/provisioning/dashboards/services
# Grafana reloads the files within 30 s at the latest
```

The generator is written in the style of `gen_dashboards.py` (infra/portainerstacks)
and can be moved there.

### Smoke test

```bash
dev/scripts/smoke-observability.sh
```

Sends a trace, a log line and a metric to Alloy with `telemetrygen`
and checks via Grafana's datasource proxy API that they arrive in Tempo, Loki,
Prometheus and in the Tempo span-metrics.

Grafana 12.4 logs
`plugin route is not covered by RBAC … falling back to 403` (level error) on every call of the datasource proxy API –
the calls work anyway, the message is harmless.

Look directly:

```bash
curl -s localhost:19090/api/v1/label/__name__/values | grep -E 'http_server|jvm_|r2dbc|traces_'
curl -s localhost:13100/loki/api/v1/label/service_name/values
curl -s 'localhost:13200/api/search?tags=service.name%3Ddrawboard-backend'
```

### Checking the dashboards

```bash
python3 dev/scripts/check_panels.py                  # env=dev, service=drawboard-backend, last 15 min
python3 dev/scripts/check_panels.py --service <name> --env <env> --minutes 30
python3 dev/scripts/check_panels.py --app drawboard-frontend --minutes 60   # 16 · Frontend, after using the frontend
```

Sends every target of every dashboard in
`dev/observability/grafana/provisioning/dashboards/services` through Grafana's
`POST /api/ds/query` (variables `route`/`span`/`level` = `.+`) and prints the
number of rows per target. Generate traffic first (a few requests with
`dev/scripts/token.sh alice`, including 404/409/403). Some targets are empty on
purpose (for example HikariCP in a reactive app); anything else that is empty
is a wrong metric or label name. Exit code 1 only if a query fails.
`GRAFANA_URL`/`GRAFANA_AUTH` point it at another Grafana.

### Deviations from the production plan (deliberate)

- Alloy runs in the Compose network instead of `network_mode: host` and reaches the backends
  via service names (`tempo:4317` instead of `<note-IP>:4417`); `host.name` = `local`.
- Only the app pipeline in Alloy (no host, cAdvisor or syslog part).
- Faro receiver: published on the Mac and open for direct CORS posts from the local
  frontend origins; in prod it only gets same-origin `/faro` traffic forwarded by the
  frontend (no CORS list), and source maps come from CI instead of `dev/sourcemaps/`.
- Docker logs: in addition to the prod state, containers with the label
  `at.dergeorg.log-format=ecs` are parsed as ECS JSON (proposal for prod).
- Grafana 12.4.12 instead of 12.1.1 (12.1 no longer gets patches). Since 12.4, anonymous access
  can only be Viewer, hence additionally `admin`/`admin`.
- Prometheus data source: second exemplar target `traceID` – that is the name of the label in
  the exemplars of the Tempo span-metrics (the Micrometer exemplars are called `trace_id`).
- Shorter retention: Tempo 48 h, Loki 72 h, Prometheus 7 days.
