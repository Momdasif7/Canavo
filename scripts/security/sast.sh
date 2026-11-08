#!/usr/bin/env sh
# SAST (semgrep, Docker) over apps/ and packages/. Triaged exclusions: .semgrepignore
# and inline `nosemgrep` comments (each with a reason). Fails on any ERROR/WARNING finding.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${SEMGREP_IMAGE:-semgrep/semgrep:latest}"
docker run --rm -v "$ROOT:/src" -w /src "$IMAGE" semgrep scan \
  --config p/javascript --config p/typescript --config p/nodejs --config p/react \
  --config p/secrets --config p/owasp-top-ten \
  --metrics off --error --severity ERROR --severity WARNING ${SEMGREP_ARGS:-} apps packages
