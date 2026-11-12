# Drawboard

A self-hosted collaborative whiteboard - an open alternative to Miro for teams that want to keep
their boards on their own servers.

* **Boards:** sticky notes, text, shapes, connectors, pen, frames and tables; copy and paste; zoom out
  to 2 % on large boards
* **Live collaboration:** everyone edits at the same time (Yjs), sees cursors and selections, can
  follow another participant or bring everyone to their view
* **Planning:** kanban boards with story cards, planning poker (with or without a story card)
* **Diagrams and files:** Mermaid blocks, images, PDFs and Office documents on the board
* **Organising:** folders, sharing with people and groups, export and import
* **Guest links:** share a board with people without an account (view, comment or edit)
* **Plugins:** own block types and tools in a sandboxed iframe, also from third parties
* **Sign-in with any OIDC provider** (Keycloak, Authelia, Authentik, Zitadel, Entra ID ...)
* **Operations:** Helm chart and Docker images, OpenTelemetry, Grafana Faro, hardened defaults

## Install

Try it on your machine in five minutes (Docker Compose with a bundled Keycloak and test users):
[`deploy/compose/README.md`](deploy/compose/README.md), "Local trial". The same folder has the setup
for one server behind your reverse proxy.

Kubernetes with Helm:

```sh
helm install drawboard oci://ghcr.io/dergeorg/charts/drawboard --version <version> \
  -n drawboard -f my-values.yaml
```

Images: `ghcr.io/dergeorg/drawboard-backend`, `ghcr.io/dergeorg/drawboard-frontend`. What the values
need (OIDC, keys, database, ingress) and what to do before guest links or third-party plugins are
switched on: [the chart README](deploy/helm/drawboard/README.md).

## What is in this repository

| Folder | What | Built with |
|---|---|---|
| [`api/`](api) | The OpenAPI contract (single source for backend and frontend), the collaboration protocol | Redocly, openapi-generator (`scripts/build.sh`) |
| [`backend/`](backend) | Spring Boot 4 service in Kotlin: WebFlux, R2DBC/PostgreSQL, the collaboration WebSocket | Gradle, JDK 25 |
| [`frontend/`](frontend) | Angular app with its own board engine (Yjs), served by nginx | Node 24, Angular CLI |
| [`deploy/`](deploy) | Helm chart, architecture and security decisions, engine design | Helm |

Read first: [`deploy/docs/architecture.md`](deploy/docs/architecture.md) (concept and the security
decisions, section 8), [`deploy/docs/board-engine.md`](deploy/docs/board-engine.md),
[`api/docs/collab-protocol.md`](api/docs/collab-protocol.md).

## How this repository is made

Development happens in a private GitLab with four repositories; this repository is a **snapshot** of
their `main` branches, refreshed daily. Each commit names the source commits and releases it was
built from. History, merge requests and pipelines stay in GitLab.

Building from source works per folder (see each README), with one limitation for now: the builds
fetch the generated contract packages and the house lint rules from the private GitLab package
registry. Build the contract from `api/` first and point the backend and frontend at the local
artifacts, or use the published images.

## Issues and security

Bugs and ideas: GitHub issues are welcome. Security problems: please report them privately through
GitHub ("Security" -> "Report a vulnerability"), not as a public issue.

## Licence

[GNU Affero General Public License v3.0](LICENSE). If you run a modified Drawboard for others over a
network, you must offer them the source of your version. The images contain open-source components
under their own licences.
