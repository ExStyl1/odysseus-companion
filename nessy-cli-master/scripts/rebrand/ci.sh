#!/usr/bin/env bash
set -euo pipefail

controller_root="$(git rev-parse --show-toplevel)"
case "${1:-}" in
  prepare)
    node --test "$controller_root/scripts/rebrand/rebrand.test.mjs" "$controller_root/scripts/rebrand/pipeline.test.mjs"
    node "$controller_root/scripts/rebrand/pipeline.mjs" prepare
    ;;
  verify)
    bash "$controller_root/scripts/rebrand/verify.sh"
    ;;
  publish)
    node "$controller_root/scripts/rebrand/pipeline.mjs" restore
    : "${GITLAB_NESTOR_DEVELOPER:?Project CI service-account file is required}"
    dp auth service-acc --key-file "$GITLAB_NESTOR_DEVELOPER"
    export REBRAND_GIT_PASSWORD
    REBRAND_GIT_PASSWORD="$(dp auth print-token)"
    export GIT_ASKPASS="$controller_root/scripts/rebrand/git-askpass.sh" GIT_TERMINAL_PROMPT=0
    node "$controller_root/scripts/rebrand/pipeline.mjs" publish
    ;;
  *)
    echo 'Usage: bash scripts/rebrand/ci.sh prepare|verify|publish' >&2
    exit 1
    ;;
esac
