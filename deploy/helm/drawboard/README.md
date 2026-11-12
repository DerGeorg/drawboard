# Drawboard Helm chart

**Drawboard** is a self-hosted collaborative whiteboard: boards with sticky notes, shapes, connectors,
frames and tables, live collaboration, Mermaid diagrams, kanban and planning poker, file embeds,
folders and sharing, guest links, plugins. Sign-in through any OIDC provider.

```sh
helm install drawboard oci://ghcr.io/dergeorg/charts/drawboard --version <version> \
  -n drawboard -f my-values.yaml
```

Images: `ghcr.io/dergeorg/drawboard-backend`, `ghcr.io/dergeorg/drawboard-frontend`.

**Licence:** [AGPL-3.0](LICENSE). Source: <https://github.com/DerGeorg/drawboard>. The images contain
open-source components under their own licences (frontend: `/3rdpartylicenses.txt`). Numbers like
(S7.8) below refer to the security decisions in `deploy/docs/architecture.md` of the source.

What the chart deploys:

| Component | Kind | Notes |
|---|---|---|
| backend | Deployment, **1 replica (fixed)**, Service `:8080` | API and collaboration WebSocket. Tickets, rooms and sequence numbers are in memory (architecture 3.1), so there is no `replicaCount`. Strategy `Recreate`. Management port `8081` is used for the probes only, it is in no Service and not in the Ingress |
| frontend | Deployment, Service `:8080` | nginx-unprivileged; serves the SPA and proxies `/api`, the WebSocket and `/faro` to the backend |
| Gotenberg | Deployment, 1 replica, Service `:3000` (optional, on by default) | LibreOffice -> PDF for Office uploads (S4.10); only the backend may connect, no egress |
| Files | PVC mounted at `/data/files` | `files.persistence.*`, or `existingClaim` |
| Key Secret | referenced by name (or created from values) | `file_url_keys`, `plugin_pseudonym_key`, `guest_signing_keys` as files under `/run/secrets` |
| PostgreSQL | external (default) or built-in StatefulSet | built-in: `postgres:18-alpine` + PVC, ClusterIP only |
| Ingress | everything -> frontend only | ingress-nginx: one Ingress for `/` plus one per upload route, each with its own body limit |
| NetworkPolicies | default deny + explicit flows | on by default |

**No Bitnami dependency, on purpose.** Bitnami restricted its free container images and chart
catalog in 2025, so a chart that depends on them would carry a licence and availability risk. The
built-in PostgreSQL is a plain upstream-image StatefulSet, good for labs and small installs; for
anything else use an external or operator-managed database (CloudNativePG, a managed service) and keep
backups with a tested restore (S7.7).

## Requirements

* Kubernetes >= 1.27, Helm 3 or 4 (rendering was tested with Helm v4.3.0 only)
* An OIDC provider (see [OIDC](#binding-an-oidc-provider))
* An ingress controller (ingress-nginx is the default; others work with `ingress.nginx.enabled=false`)
* A CNI that enforces NetworkPolicy (Cilium, Calico, ...), otherwise the policies are silently ignored
* Images `ghcr.io/dergeorg/drawboard-{backend,frontend}` (public, linux/amd64); a mirror in your own
  registry works with `backend.image.repository` / `frontend.image.repository` and `imagePullSecrets`

## Install

```sh
kubectl create namespace drawboard

# 1. The key files of the backend (required, S7.8). Create the Secret BEFORE the first install:
#    the backend does not start without file_url_keys and plugin_pseudonym_key.
#    Two different 32-byte keys; the file URL keys may be a comma or line separated list (first signs,
#    all verify). The files are mounted under /run/secrets, never as environment variables.
head -c 32 /dev/urandom | base64 > file_url_keys
head -c 32 /dev/urandom | base64 > plugin_pseudonym_key
#    Only when guests.enabled=true (S1.5): EC P-256 private key(s), PKCS#8 PEM, first signs, all verify.
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out guest_signing_keys
kubectl -n drawboard create secret generic drawboard-keys \
  --from-file=file_url_keys --from-file=plugin_pseudonym_key --from-file=guest_signing_keys
#    (leave out the last --from-file and the openssl line while guests stay off; add the key later with
#     `kubectl -n drawboard create secret generic drawboard-keys --from-file=... --dry-run=client -o yaml | kubectl apply -f -`)
shred -u file_url_keys plugin_pseudonym_key guest_signing_keys 2>/dev/null \
  || rm -P file_url_keys plugin_pseudonym_key guest_signing_keys

# 2. Database password (always a secret, never a value)
kubectl -n drawboard create secret generic drawboard-db \
  --from-literal=password="$(openssl rand -base64 32)"

# 3. Values (only the required ones here)
cat > my-values.yaml <<'YAML'
publicUrl: https://draw.example.org
oidc:
  issuerUri: https://sso.example.org
  audience: drawboard-api
secrets:
  existingSecret: drawboard-keys
# Pod CIDR(s) of the ingress controller and the frontend pods, see "Trusted proxies" below
trustedProxies: ["10.244.0.0/16"]
ingress:
  host: draw.example.org
  tls:
    - secretName: drawboard-tls
      hosts: [draw.example.org]
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
postgresql:
  external:
    host: postgres.db.svc
    existingSecret: drawboard-db
YAML

helm install drawboard oci://ghcr.io/dergeorg/charts/drawboard --version <version> \
  -n drawboard -f my-values.yaml
```

The chart refuses to render without a key Secret (`secrets.existingSecret`, or `secrets.create=true`).
With the built-in database instead of `postgresql.external`:

```yaml
postgresql:
  enabled: true
  auth:
    existingSecret: drawboard-db
  persistence:
    size: 8Gi
```

**Lab shortcut:** `secrets.create=true` lets the chart create the Secret from `secrets.values.*`. Pass the
values on the command line so they never land in a file in git, and use two different keys:

```sh
helm install drawboard oci://ghcr.io/dergeorg/charts/drawboard --version <version> \
  -n drawboard -f my-values.yaml \
  --set secrets.existingSecret= --set secrets.create=true \
  --set-string secrets.values.fileUrlKeys="$(head -c 32 /dev/urandom | base64)" \
  --set-string secrets.values.pluginPseudonymKey="$(head -c 32 /dev/urandom | base64)"
```

The values are then stored in the Helm release secret too; an existing Secret you manage yourself is
the recommended way. The chart does not generate keys (a template that generated them would change
them on every upgrade).

**Rotation.** File URL keys: put the new key first, remove the old one after one hour. Guest keys: new key
first, old one out after 12 h. Edit the Secret, then `kubectl -n drawboard rollout restart
deploy/<release>-drawboard-backend` (a Secret change alone does not restart the pod; with
`secrets.create` the chart restarts it itself). The pseudonym key must not be rotated casually: it
changes the user ids plugins see.

### Trusted proxies

`trustedProxies` becomes `DRAWBOARD_TRUSTED_PROXIES` (S7.3): the backend believes `X-Forwarded-For` only when
the direct peer is listed. The backend's direct peer is the **frontend pod** (its nginx forwards `/api`),
behind it is the **ingress controller**. List the **pod CIDR(s)** the controller and the frontend pods get
their addresses from (`kubectl get nodes -o jsonpath='{.items[*].spec.podCIDR}'`, or the CNI's pool), or
the exact addresses if they are fixed. With the value empty (default) nobody is trusted, every client
looks like the proxy and the rate limits count all users together; with a too wide value a client can
name its own address. If the controller is behind a load balancer, make sure the controller itself passes
the real client address on (`externalTrafficPolicy: Local` or proxy protocol). Verify once: open a share link and
check the `ip` of the audit event `library.share.exchange-failed`.

### Files, spool and uploads

* **Files** live on a PVC at `/data/files` (`DRAWBOARD_FILES_DIR`): `files.persistence.size`,
  `.storageClassName`, `.accessModes`; or `files.persistence.existingClaim` to use a claim you made (it must
  be writable for gid 10001; the pod sets `fsGroup`). The PVC is annotated `helm.sh/resource-policy: keep`:
  `helm uninstall` leaves it. Back it up together with the database (S7.7).
* **Upload spool** `DRAWBOARD_UPLOAD_SPOOL_DIR=/spool/uploads`: a disk-backed emptyDir
  (`backend.uploadSpool.sizeLimit`, default `5Gi`), deliberately not `medium: Memory`. At most 8 uploads of
  500 MB + 1 MiB are in flight (4 GiB at worst), so keep about 5 GB free on the node's disk; the sizeLimit
  evicts the pod before it can fill the disk.
* `/tmp` is a separate emptyDir (`backend.tmp.sizeLimit`); the root file system is read-only.

### Gotenberg, ClamAV, own origins

* `gotenberg.enabled` (default `true`): `gotenberg/gotenberg:8.40.0` with exactly the compose flags
  (`--chromium-disable-routes=true`, `--pdfengines-disable-routes=true`, `--webhook-disable=true`,
  `--api-timeout=60s`, `--api-disable-health-check-logging=true`, `--libreoffice-restart-after=20`), uid 1001,
  read-only root file system, emptyDirs for `/tmp` (768Mi) and `/home/gotenberg` (128Mi), no capabilities,
  memory limit 2Gi. `DRAWBOARD_GOTENBERG_URL` points at its Service. Off = Office documents are stored with
  `conversion: FAILED`.
* `clamav.host` (empty = no scan): the chart does **not** deploy clamd, point it at yours (run it where
  nothing can route out of it, like Gotenberg). With `clamav.failClosed=true` an upload that could not be
  scanned is refused, and `clamav.maxBytes` **must be at least the video cap (500 MiB = 524288000)**, the
  chart refuses to render otherwise. clamd's own `StreamMaxLength`, `MaxFileSize` and `MaxScanSize`
  (`clamd.conf`) must each be at least the video cap too; the chart cannot check them, and a clamd with lower
  limits answers with an error that fail closed turns into a 503 for every large video. Set
  `networkPolicy.clamav.cidrs` to clamd's address.
* `files.origin` / `plugins.origin` become `DRAWBOARD_FILES_ORIGIN` / `DRAWBOARD_PLUGIN_ORIGIN` and, unless
  `frontend.filesOrigin` / `frontend.pluginOrigin` say otherwise, the frontend's `FILES_ORIGIN` /
  `PLUGIN_ORIGIN` (they widen its CSP, S7.5). They only describe the origins; serving files and plugin assets
  from them is an Ingress/DNS task of yours.
* `guests.enabled` = `DRAWBOARD_GUESTS_ENABLED` (default `false`). See [Before enabling guest links](#before-enabling-guest-links);
  needs `guest_signing_keys` in the key Secret.

## Before enabling guest links

Guest links let people without an account open a board through a shared link (view, comment or edit,
as the link says). The release itself has every control in place; these conditions are yours as the
operator. Do all of them before `guests.enabled=true`:

1. **Trusted proxies set and verified.** `trustedProxies` lists exactly the pod CIDR(s) of the ingress
   controller and the frontend pods (see [Trusted proxies](#trusted-proxies)). Verify it once: open a
   guest link with a wrong token and check the audit event `library.share.exchange-failed` - its `ip`
   must be your real client address, not a pod or node address. The per-IP limits on guest exchanges
   and the guest session cap only work when this is right.
2. **Signing key only as a Secret file.** `guest_signing_keys` (EC P-256, PKCS#8 PEM) in the key Secret,
   never as a value in a file in git. Rotation: put the new key first, remove the old one after 12 h.
3. **TLS and headers verified end to end.** TLS is terminated in front of the frontend. Check through
   your ingress (controllers may override headers) that a board page answers with
   `Referrer-Policy: no-referrer` and the frontend's `Content-Security-Policy`
   (`curl -sI https://<host>/s/x | grep -iE 'referrer-policy|content-security-policy'`).
4. **Backups with a tested restore** of the database and the files PVC (S7.7). A guest with an EDITOR
   link can change and delete content like a signed-in editor.
5. **Know what an EDITOR link allows.** Guests on EDITOR links edit the board and use the per-IP limits;
   hand out VIEWER or COMMENTER links unless editing is the point, and revoke links you no longer need.
6. **Third-party plugins** additionally need `plugins.origin` on a separate hostname (S3.4, see
   [Gotenberg, ClamAV, own origins](#gotenberg-clamav-own-origins)); a plugin can still send what it
   is shown to its own servers - install only plugins you trust.

## Upgrade, rollback, uninstall

```sh
helm upgrade drawboard oci://ghcr.io/dergeorg/charts/drawboard --version <new> -n drawboard -f my-values.yaml
helm rollback drawboard -n drawboard                                      # Flyway migrations are not rolled back
helm uninstall drawboard -n drawboard
```

* Every chart version names the backend and frontend releases it was checked with (`backend.image.tag`,
  `frontend.image.tag` in `values.yaml`); override them only to pin or roll back one side.
* The backend is `Recreate`: an upgrade means a short outage and all WebSocket sessions reconnect
  (clients back off and lose nothing, every accepted update is in the log).
* `helm uninstall` keeps the built-in database's PVC (`postgresql.persistence.retentionPolicy:
  Retain`). Delete it deliberately: `kubectl -n drawboard delete pvc -l app.kubernetes.io/component=postgresql`.
  The files PVC (`helm.sh/resource-policy: keep`) and Secrets you created are not touched either.

## Binding an OIDC provider

The code speaks standard OIDC only; a provider is bound by values (architecture 3.4, S6).

| What | Value | Rule |
|---|---|---|
| Issuer | `oidc.issuerUri` (backend) and `frontend.oidc.issuer` (default: same) | equals `iss` of the access tokens byte for byte |
| Audience | `oidc.audience` | **required**. `aud` of every access token must contain it. One audience per environment; **never equal to the SPA client id** (the chart refuses that) |
| SPA client | `frontend.oidc.clientId`, `frontend.oidc.scope` | public client, authorization code + PKCE (S256), exact redirect URIs (printed by `helm install`): `<publicUrl>/auth/callback`, post-logout `<publicUrl>/`, `<publicUrl>/silent-renew.html` |
| Claims | `oidc.claimUsername`, `oidc.claimGroups` | dot paths allowed (`resource_access.drawboard-api.roles`) |
| Admins | `adminGroup` | group value in the current token; empty = nobody; admin does not grant board access |
| Keys | `oidc.jwkSetUri` | only when the backend reaches the provider under another address than the browser |

Access tokens must be **signed JWTs** (RS256, ES256 or PS256; never `none` or HS*). The token header
type may be `JWT`, `at+jwt` (RFC 9068, what Authelia issues) or absent.

**Keycloak:** add an *Audience* mapper to the client (included client audience = `oidc.audience`) and a
*Group Membership* mapper (full path off) for the `groups` claim. Issuer is
`https://<host>/realms/<realm>`.

**Authelia:** set `access_token_signed_response_alg: RS256` on the client (otherwise the access tokens are
opaque and every call is a 401), put `oidc.audience` into the client's `audience`, make
`username`/`groups` part of the access token, and allow **CORS for the SPA origin** (`<publicUrl>`) on the
token, revocation and userinfo endpoints of the client (`allowed_origins`; the SPA calls them from the
browser). The client is public, PKCE S256, scopes `openid profile email groups offline_access`.
Refresh-token rotation must be on (S6.1).

## Secrets

Only references, never values:

| Value | Secret key | Used for |
|---|---|---|
| `postgresql.external.existingSecret` / `.passwordKey` (default `password`) | password | `DB_PASSWORD` of the backend |
| `postgresql.auth.existingSecret` / `.passwordKey` | password | built-in PostgreSQL (`POSTGRES_PASSWORD`) and the backend |
| `secrets.existingSecret` + `secrets.keys.fileUrlKeys` (`file_url_keys`) | base64 key list | file `/run/secrets/file_url_keys` -> `DRAWBOARD_FILE_URL_KEYS_FILE`, required |
| same Secret, `secrets.keys.pluginPseudonymKey` (`plugin_pseudonym_key`) | base64 key | file `/run/secrets/plugin_pseudonym_key` -> `DRAWBOARD_PLUGIN_PSEUDONYM_KEY_FILE`, required, differs from the file URL keys |
| same Secret, `secrets.keys.guestSigningKeys` (`guest_signing_keys`) | EC P-256 PKCS#8 PEM list | file `/run/secrets/guest_signing_keys` -> `DRAWBOARD_GUEST_SIGNING_KEYS_FILE`, only mounted when `guests.enabled=true` |

Key material is never in a default value. `secrets.create=true` is the opt-in lab path (see Install).

## Hardening (S7.8, S7.9)

Every pod (backend, frontend, Gotenberg, built-in PostgreSQL): `runAsNonRoot`, explicit uid/gid (backend 10001,
frontend 101, Gotenberg 1001, PostgreSQL 70), `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`,
`capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`, `automountServiceAccountToken: false`, an
own ServiceAccount, requests and limits. Writable paths are emptyDirs with a `sizeLimit`: backend `/tmp`
(JVM) and `/spool` (multipart spool of all uploads, S2.8), the files PVC, Gotenberg `/tmp` and
`/home/gotenberg`, frontend `/tmp` and `/etc/nginx/conf.d`
(nginx temp files and the rendered template), PostgreSQL `/tmp` and `/var/run/postgresql`.

The frontend's nginx streams the upload bodies (`proxy_request_buffering off`), so its `/tmp` stays small;
`frontend.tmp.sizeLimit` is `256Mi` for nginx's other temp files.

NetworkPolicies (`networkPolicy.enabled`, default on): the pods of the release are denied by default,
then open: ingress controller -> frontend:8080; frontend -> backend:8080 (+ DNS, + Faro receiver if set);
backend -> PostgreSQL:5432, -> OIDC provider :443 (`networkPolicy.oidc.cidrs`, default any), -> DNS,
-> Gotenberg:3000, -> clamd if set, -> OTLP if set; PostgreSQL accepts only the backend and has no egress.
Gotenberg accepts only the backend and has **no egress at all** (not even DNS: it converts on localhost;
stricter than the compose network, where it can still reach the backend). Set
`networkPolicy.ingressController.namespaceSelector` to where your controller runs (default namespace
`ingress-nginx`) and narrow `networkPolicy.oidc.cidrs`. The management port 8081 is not opened for any
pod (kubelet probes are node-local).

Ingress: everything -> frontend only. ingress-nginx has one body size limit per Ingress **object**, not per
path, so with `ingress.nginx.enabled` (default) the chart renders four Ingress objects for the same host
(regex paths, `use-regex`, the longer path wins), all with `proxy-request-buffering: "off"`
(`ingress.nginx.requestBuffering`):

| Ingress | Path | `proxy-body-size` (value) |
|---|---|---|
| `<release>-drawboard` | `/` (Prefix) | `2m` (`ingress.nginx.bodySize.default`) |
| `<release>-drawboard-files` | `/api/boards/[^/]+/files$` | `500m` (`.files`) |
| `<release>-drawboard-plugins` | `/api/admin/plugins` (Exact) | `21m` (`.plugins`) |
| `<release>-drawboard-snapshot` | `/api/boards/[^/]+/snapshot$` | `51m` (`.snapshot`, **S2.8, a MUST**) |

All carry `proxy-read-timeout` / `proxy-send-timeout` of 3600 s (WebSocket, S7.9). The frontend's nginx
enforces the same caps a second time. `ingress.annotations` (cert-manager, ...) go to the `/` Ingress only,
`ingress.uploadAnnotations` to the three upload Ingresses; `tls` is on all of them. ingress-nginx applies
`use-regex` to the whole host, which is why every Ingress of the chart sets it. The backend requires a
`Content-Length` on uploads, so do not turn on a controller feature that makes the body chunked. For another
controller set `ingress.nginx.enabled=false` (only the `/` Ingress is rendered) and configure the same
per-path limits and unbuffered request bodies there. The collaboration WebSocket needs no extra Ingress:
the timeouts above cover it.

## Values

Required values are **bold**. Everything else has a default in [`values.yaml`](helm/drawboard/values.yaml)
and is checked by [`values.schema.json`](helm/drawboard/values.schema.json).

| Value | Default | Meaning |
|---|---|---|
| **`publicUrl`** | - | `DRAWBOARD_PUBLIC_URL`: browser origin (scheme + host [+ port]); the WebSocket Origin check; must contain `ingress.host` |
| **`oidc.issuerUri`** | - | `OIDC_ISSUER_URI` |
| **`oidc.audience`** | - | `OIDC_AUDIENCE` |
| `oidc.jwkSetUri` | `""` | `OIDC_JWK_SET_URI` |
| `oidc.claimUsername` / `oidc.claimGroups` | `preferred_username` / `groups` | `OIDC_CLAIM_USERNAME` / `OIDC_CLAIM_GROUPS` |
| `adminGroup` | `""` | `DRAWBOARD_ADMIN_GROUP` |
| `environment` | `prod` | `APP_ENVIRONMENT` of both images |
| `timezone` | `""` | `TZ` of the backend |
| `guests.enabled` | `false` | `DRAWBOARD_GUESTS_ENABLED`; only after [Before enabling guest links](#before-enabling-guest-links); needs `guest_signing_keys` in the key Secret |
| `trustedProxies` | `[]` | `DRAWBOARD_TRUSTED_PROXIES`: list (or comma separated string) of CIDRs, the pod CIDR(s) of ingress controller and frontend; empty = nobody trusted (warning) |
| **`secrets.existingSecret`** | `""` | Secret with the key files (or `secrets.create`) |
| `secrets.create` | `false` | the chart creates the Secret from `secrets.values.{fileUrlKeys,pluginPseudonymKey,guestSigningKeys}`; exclusive with `existingSecret` |
| `secrets.keys.fileUrlKeys` / `.pluginPseudonymKey` / `.guestSigningKeys` | `file_url_keys` / `plugin_pseudonym_key` / `guest_signing_keys` | key names inside the Secret |
| `files.persistence.enabled` | `true` | PVC at `/data/files`; `false` = emptyDir (files lost on reschedule) |
| `files.persistence.existingClaim` | `""` | use this PVC instead of creating one |
| `files.persistence.size` / `.storageClassName` / `.accessModes` / `.annotations` | `10Gi` / cluster default / `[ReadWriteOnce]` / `helm.sh/resource-policy: keep` | PVC |
| `files.origin` | `""` | `DRAWBOARD_FILES_ORIGIN` (and default of `frontend.filesOrigin`) |
| `plugins.origin` | `""` | `DRAWBOARD_PLUGIN_ORIGIN` (and default of `frontend.pluginOrigin`) |
| `clamav.host` / `.port` | `""` / `3310` | `DRAWBOARD_CLAMAV_HOST` / `_PORT`; empty host = no scan |
| `clamav.maxBytes` / `.timeoutSeconds` | `""` / `""` | `DRAWBOARD_CLAMAV_MAX_BYTES` / `_TIMEOUT_SECONDS`; empty = backend default (25 MiB / 60 s) |
| `clamav.failClosed` | `false` | `DRAWBOARD_CLAMAV_FAIL_CLOSED`; true needs `maxBytes` >= 524288000 (render fails otherwise) and clamd limits at least as high |
| `gotenberg.enabled` | `true` | Gotenberg Deployment, Service, NetworkPolicy and `DRAWBOARD_GOTENBERG_URL` |
| `gotenberg.image.*`, `.runAsUser/Group` | `gotenberg/gotenberg` `8.40.0`, `1001` | |
| `gotenberg.resources` | 100m / 512Mi requests, memory limit 2Gi | |
| `gotenberg.tmp.sizeLimit`, `.home.sizeLimit` | `768Mi`, `128Mi` | emptyDirs `/tmp`, `/home/gotenberg` |
| `gotenberg.podAnnotations`, `podLabels`, `serviceAccount.annotations`, `nodeSelector`, `affinity`, `tolerations` | empty | scheduling and metadata |
| `imagePullSecrets` | `[]` | pull secrets for all pods |
| `nameOverride`, `fullnameOverride` | `""` | naming |
| `backend.image.repository` / `.tag` / `.pullPolicy` | registry path / `1.12.1` / `IfNotPresent` | image (empty tag = appVersion) |
| `backend.runAsUser` / `.runAsGroup` | `10001` | uid/gid |
| `backend.resources` | 250m / 512Mi requests, 2 / 1Gi limits | |
| `backend.tmp.sizeLimit` | `1Gi` | `/tmp` emptyDir |
| `backend.uploadSpool.sizeLimit` | `5Gi` | emptyDir behind `DRAWBOARD_UPLOAD_SPOOL_DIR` (`/spool/uploads`) |
| `backend.otlp.endpoint` | `""` | `OTEL_EXPORTER_OTLP_ENDPOINT`; set = metrics and trace export on, empty = off |
| `backend.collab` | `{}` | map of `COLLAB_*` variables (backend README) |
| `backend.files` | `{}` | map of `FILES_*` limits (backend README, "Files"), e.g. `FILES_MAX_VIDEO_BYTES` |
| `backend.extraEnv` | `[]` | further env entries |
| `backend.probes.*` | see file | startup / readiness / liveness timing |
| `backend.podAnnotations`, `podLabels`, `serviceAccount.annotations`, `nodeSelector`, `affinity`, `tolerations` | empty | scheduling and metadata |
| `frontend.replicaCount` | `1` | the frontend is stateless |
| `frontend.image.*`, `frontend.runAsUser/Group` | registry path, tag `1.17.0`, `101` | |
| `frontend.filesOrigin` / `.pluginOrigin` | `""` | `FILES_ORIGIN` / `PLUGIN_ORIGIN` runtime env; empty = `files.origin` / `plugins.origin` |
| `frontend.resources` | 50m / 64Mi requests, 500m / 128Mi limits | |
| `frontend.tmp.sizeLimit`, `frontend.confd.sizeLimit` | `256Mi`, `1Mi` | emptyDirs |
| `frontend.oidc.issuer` | `""` (= `oidc.issuerUri`) | `OIDC_ISSUER` |
| `frontend.oidc.clientId` | `drawboard-web` | `OIDC_CLIENT_ID` (public SPA client) |
| `frontend.oidc.scope` | `openid profile email groups offline_access` | `OIDC_SCOPE` |
| `frontend.faro.receiverUrl` | `""` | `FARO_RECEIVER_URL`; empty = Faro off |
| `frontend.faro.appName` / `.namespace` / `.samplingRate` | `""` / `""` / `"1"` | `FARO_APP_NAME` / `FARO_NAMESPACE` / `FARO_SAMPLING_RATE` |
| `frontend.extraEnv` and scheduling values | | as for the backend |
| `postgresql.enabled` | `false` | `true` = built-in StatefulSet |
| **`postgresql.external.host`**, `.port` (5432), **`.database`**, **`.user`**, **`.existingSecret`**, `.passwordKey` | database `drawboard`, user `drawboard` | external server (required when not `enabled`) |
| **`postgresql.auth.existingSecret`**, `.database`, `.username`, `.passwordKey` | `drawboard`, `drawboard`, `password` | built-in database (secret required when `enabled`) |
| `postgresql.image.*`, `.runAsUser/Group` | `postgres:18-alpine`, `70` | built-in |
| `postgresql.persistence.size` / `.storageClassName` / `.accessModes` / `.retentionPolicy` | `8Gi` / cluster default / `[ReadWriteOnce]` / `Retain` | PVC |
| `postgresql.resources`, `.tmp.sizeLimit` | 100m / 256Mi, 1 / 512Mi; `256Mi` | |
| `ingress.enabled` | `true` | |
| `ingress.className` | `nginx` | |
| **`ingress.host`** | - | required when enabled |
| `ingress.tls` | `[]` | standard Ingress TLS list |
| `ingress.nginx.enabled` | `true` | ingress-nginx annotations and the three extra upload Ingresses |
| `ingress.nginx.bodySize.default` / `.files` / `.plugins` / `.snapshot` | `2m` / `500m` / `21m` / `51m` | `proxy-body-size` per route |
| `ingress.nginx.requestBuffering` | `false` | `proxy-request-buffering` (`off`) |
| `ingress.nginx.timeoutSeconds` | `3600` | `proxy-read-timeout` / `proxy-send-timeout` |
| `ingress.annotations` / `ingress.uploadAnnotations` | `{}` / `{}` | extra annotations of the `/` Ingress (cert-manager, ...) / of the three upload Ingresses |
| `networkPolicy.enabled` | `true` | |
| `networkPolicy.ingressController.*`, `.dns.*` | `ingress-nginx`, `kube-system` / `kube-dns` | where the controller and DNS run |
| `networkPolicy.oidc.cidrs` / `.port` | `["0.0.0.0/0"]` / `443` | backend egress to the provider |
| `networkPolicy.externalPostgres.cidrs` | `[]` (any) | backend egress to the external database |
| `networkPolicy.otlp.*`, `networkPolicy.faro.*` | `4318`, `12347` | only when the endpoint is set |
| `networkPolicy.clamav.cidrs` | `[]` (any) | backend egress to clamd (port `clamav.port`), only when `clamav.host` is set |
