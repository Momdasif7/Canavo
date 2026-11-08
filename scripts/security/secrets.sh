#!/usr/bin/env sh
# Secret scan (gitleaks, Docker): working tree + full git history of all refs.
# Fails (exit 1) on any finding not allowlisted in .gitleaks.toml.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GITDIR="$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd)"
IMAGE="${GITLEAKS_IMAGE:-zricethezav/gitleaks:v8.30.1}"
echo "gitleaks: working tree"
docker run --rm -v "$ROOT:/repo:ro" "$IMAGE" dir /repo --config /repo/.gitleaks.toml --redact --no-banner
echo "gitleaks: git history (all refs)"
docker run --rm -v "$GITDIR:/repo.git:ro" -v "$ROOT/.gitleaks.toml:/gitleaks.toml:ro" "$IMAGE" \
  git /repo.git --log-opts="--all" --config /gitleaks.toml --redact --no-banner
