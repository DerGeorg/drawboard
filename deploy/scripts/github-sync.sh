#!/bin/sh
# =============================================================================
# github-sync.sh - publish a snapshot of the four Drawboard repos on GitHub
#
# One public repository (https://github.com/DerGeorg/drawboard) holds the GitLab repos
# api, backend, frontend and deploy as folders. It is NOT a mirror: every run takes the
# `main` trees from GitLab, assembles them, checks them and commits ONE snapshot commit if
# anything changed (Fable review "Publishing the source", 2026-11-12, decision (c)):
#   - source: `main` of the GitLab repos only (git archive = tracked files only), never a
#     working folder - nothing untracked, no other branch, no history leaves GitLab
#   - root files: deploy/public/README.md -> README.md, deploy/LICENSE -> LICENSE (AGPL-3.0)
#   - scrub (SHOULD 4/5): agent notes (CLAUDE.md, .claude/) dropped; LAN addresses and data
#     paths in docs and deploy files (never in src/, the tests use addresses on purpose)
#     replaced by documentation values
#   - gate (MUST 3): gitleaks over the assembled tree with deploy/public/gitleaks.toml; any
#     finding stops the run before anything is pushed
#
# In CI (job sync:github of the deploy pipeline): clones with CI_JOB_TOKEN, pushes with the
# fine-grained GitHub token in GITHUB_SYNC_TOKEN (masked, protected; Contents read/write on this one
# repository only; gitlab-devops scripts/32-drawboard-github-sync.sh). The token never appears in a
# URL, an argument or .git/config: a credential helper reads it from the environment.
# Locally, for a dry run: SYNC_SOURCE=git@gitlab.dergeorg.at:apps/drawboard DRY_RUN=1 sh github-sync.sh
# =============================================================================
set -eu

GITHUB_REPO="${GITHUB_REPO:-https://github.com/DerGeorg/drawboard.git}"
REPOS="api backend frontend deploy"
DRY_RUN="${DRY_RUN:-0}"
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256_X64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080

if [ -n "${SYNC_SOURCE:-}" ]; then
  # a folder with the four local clones, or a GitLab base like git@gitlab.dergeorg.at:apps/drawboard
  source_url() { if [ -d "$SYNC_SOURCE/$1" ]; then echo "file://$SYNC_SOURCE/$1"; else echo "$SYNC_SOURCE/$1.git"; fi; }
else
  : "${CI_JOB_TOKEN:?outside CI set SYNC_SOURCE}"
  # always https: the instance's external_url still says http
  source_url() { echo "https://gitlab-ci-token:${CI_JOB_TOKEN}@${CI_SERVER_HOST}/apps/drawboard/$1.git"; }
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
TREE="$WORK/tree"
mkdir -p "$TREE"

# ---- 1. the main trees ------------------------------------------------------------
SUMMARY=""
for r in $REPOS; do
  # SYNC_BRANCH_<repo> is for dry runs of an unmerged branch only; the CI job never sets it
  eval "branch=\${SYNC_BRANCH_$r:-main}"
  [ "$branch" = main ] || [ "$DRY_RUN" = 1 ] || { echo "SYNC_BRANCH_$r only with DRY_RUN=1" >&2; exit 1; }
  git clone -q --depth 1 --branch "$branch" "$(source_url "$r")" "$WORK/src/$r"
  sha=$(git -C "$WORK/src/$r" rev-parse --short=10 HEAD)
  release=$(git -C "$WORK/src/$r" ls-remote --tags --sort=-v:refname origin 'v*' 2>/dev/null \
    | sed -n '1s#.*refs/tags/##p' | sed 's/\^{}$//')
  mkdir -p "$TREE/$r"
  git -C "$WORK/src/$r" archive HEAD | tar -x -C "$TREE/$r"
  SUMMARY="${SUMMARY}${r} ${sha}${release:+ (latest release $release)}
"
  echo "$r: $sha ${release:-no release}"
done

# ---- 2. root files ----------------------------------------------------------------
cp "$TREE/deploy/public/README.md" "$TREE/README.md"
cp "$TREE/deploy/LICENSE" "$TREE/LICENSE"

# ---- 3. scrub ---------------------------------------------------------------------
find "$TREE" -name CLAUDE.md -type f -delete
find "$TREE" -name .claude -type d -prune -exec rm -rf {} +
find "$TREE" -type f \( -name '*.md' -o -name '*.yml' -o -name '*.yaml' -o -name '*.conf' -o -name '*.template' \) \
  ! -path '*/src/*' -print | while IFS= read -r f; do
  if grep -qE '192\.168\.1\.(1|4|5|29)([^0-9]|$)|/mnt/cache/appdata/drawboard' "$f"; then
    sed -i -E \
      -e 's#192\.168\.1\.(1|4|5|29)([^0-9]|$)#192.0.2.\1\2#g' \
      -e 's#/mnt/cache/appdata/drawboard#/srv/drawboard#g' "$f"
    echo "scrubbed: ${f#"$TREE"/}"
  fi
done

# ---- 4. gate: gitleaks over the assembled tree --------------------------------------
if command -v gitleaks >/dev/null 2>&1 && gitleaks version 2>/dev/null | grep -q "$GITLEAKS_VERSION"; then
  GL=gitleaks
else
  # the binary of this machine: an emulated x64 binary crashes on arm64 (mac-docker runner)
  case "$(uname -m)" in
    aarch64|arm64) arch=arm64; sum=$GITLEAKS_SHA256_ARM64 ;;
    *)             arch=x64;   sum=$GITLEAKS_SHA256_X64 ;;
  esac
  curl -fsSLo "$WORK/gitleaks.tgz" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${arch}.tar.gz"
  echo "${sum}  $WORK/gitleaks.tgz" | sha256sum -c - >/dev/null
  tar -xzf "$WORK/gitleaks.tgz" -C "$WORK" gitleaks
  GL="$WORK/gitleaks"
fi
if ! (cd "$TREE" && "$GL" dir . --config deploy/public/gitleaks.toml --redact --no-banner); then
  echo "STOP: gitleaks found something in the assembled tree - nothing was pushed." >&2
  exit 1
fi

# ---- 5. snapshot commit -------------------------------------------------------------
PUB="$WORK/public"
if [ "$DRY_RUN" = 1 ]; then
  echo "DRY_RUN: tree assembled and checked ($(find "$TREE" -type f | wc -l) files), not pushed."
  [ -n "${KEEP_TREE:-}" ] && cp -R "$TREE" "$KEEP_TREE"
  exit 0
fi
: "${GITHUB_SYNC_TOKEN:?the GitHub token (variable GITHUB_SYNC_TOKEN) is missing}"
export GITHUB_SYNC_TOKEN
# every git call below: the token comes from the environment through a credential helper
gh_git() {
  git -c credential.helper= \
      -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_SYNC_TOKEN"; }; f' "$@"
}

if gh_git clone -q "$GITHUB_REPO" "$PUB" && git -C "$PUB" rev-parse -q --verify HEAD >/dev/null; then
  git -C "$PUB" checkout -q main
else
  # the first run: the GitHub repository is still empty
  rm -rf "$PUB" && mkdir -p "$PUB" && git -C "$PUB" init -q -b main
  git -C "$PUB" remote add origin "$GITHUB_REPO"
fi
find "$PUB" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$TREE/." "$PUB/"
git -C "$PUB" add -A
if git -C "$PUB" rev-parse -q --verify HEAD >/dev/null && git -C "$PUB" diff --cached --quiet; then
  echo "No change since the last snapshot."
  exit 0
fi
git -C "$PUB" -c user.name="Drawboard sync" -c user.email="noreply@dergeorg.at" \
  commit -q -F - <<EOF
Sync from GitLab

$SUMMARY
EOF
gh_git -C "$PUB" push -q origin main
echo "Pushed $(git -C "$PUB" rev-parse --short HEAD) to $GITHUB_REPO"
