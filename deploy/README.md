# drawboard-deploy

Deployment of **Drawboard**: the Helm chart [`helm/drawboard`](helm/drawboard) and a Docker Compose
setup for one host with a five-minute local trial ([`compose/`](compose)). Its
[README](helm/drawboard/README.md) is the user documentation and is shipped inside the chart package
(Artifact Hub, `helm show readme`). Concept, security decisions (S-numbers) and phases:
`docs/architecture.md` (section 5 Deployment, section 8 Security decisions). The compose stacks for
Portainer live next to the code (`backend/deploy/`, `frontend/deploy/`); the chart is the Kubernetes
counterpart and uses the same images, variables, ports and hardening.

Licence: AGPL-3.0 ([`LICENSE`](LICENSE)). Published for others: the source as a daily snapshot of
`main` of all five repositories in <https://github.com/DerGeorg/drawboard> (job `sync:github`,
[`scripts/github-sync.sh`](scripts/github-sync.sh); [`public/`](public) holds its root README and the
gitleaks allowlist), the chart (`oci://ghcr.io/dergeorg/charts/drawboard`) and the images
(`ghcr.io/dergeorg/drawboard-{backend,frontend}`). What the sync drops or rewrites (agent notes, LAN
addresses, data paths) and why: the script header and `docs/architecture.md`, "Publishing the source".

## Checks

```sh
cd deploy
for f in test-values test-values-postgresql test-values-create-secret; do
  helm lint --strict helm/drawboard -f helm/drawboard/ci/$f.yaml
  helm template rel helm/drawboard -f helm/drawboard/ci/$f.yaml > $f.out.yaml
done
kubeconform -strict -summary -kubernetes-version 1.32.0 test-values*.out.yaml
# or: docker run --rm -v "$PWD":/w ghcr.io/yannh/kubeconform:v0.7.0 -strict -summary -kubernetes-version 1.32.0 /w/test-values.out.yaml ...
```

`test-values.yaml` is the minimum (defaults: Gotenberg on, guests off, PVC created, existing key Secret),
`test-values-postgresql.yaml` has everything on (built-in database, OTLP, Faro, guests, existing claim,
ClamAV fail closed, own origins, trusted proxies, upload annotations), `test-values-create-secret.yaml`
the lab path (`secrets.create`, no Gotenberg, no PVC, no ingress-nginx annotations).

The checks render only; nothing was applied to a cluster when the chart was written.

## CI and publishing

`.gitlab-ci.yml` uses the `helm-chart` component of `ci/components`:

* every pipeline: `chart:lint` (`helm lint --strict` and `helm template` with every `ci/*.yaml`) and
  `chart:package` (the `.tgz` with the next version as artifact);
* `main`: `release` (tag and GitLab release) when a `feat:` or `fix:` is due - `docs:` and `chore:`
  release nothing;
* publishing: one click on `chart:publish` in a release pipeline on `main` pushes the chart to
  `oci://ghcr.io/dergeorg/charts`. Never without asking Georg.

Releasing a new app version for others: click `publish:image` in the backend and frontend release
pipelines (ghcr.io), set `backend.image.tag` / `frontend.image.tag` here with a `feat(helm):` commit,
then `chart:publish`. A new package on ghcr.io is private until it is switched to Public once on GitHub
(Package settings -> Change visibility). Credentials: group variables `GHCR_USER` / `GHCR_TOKEN`
(gitlab-devops `scripts/31-drawboard-ghcr.sh`).
