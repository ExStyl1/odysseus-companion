#!/usr/bin/env bash
set -euo pipefail

controller_root="$(git rev-parse --show-toplevel)"
output_dir="$controller_root/.rebrand"
source_dir="$output_dir/source"
node "$controller_root/scripts/rebrand/pipeline.mjs" restore
cd "$source_dir"
export CI=true HUSKY=0
export NESSY_HOME="$output_dir/home" NESSY_RUNTIME_DIR="$output_dir/runtime"
mkdir -p "$NESSY_HOME"
printf '%s\n' '{"general":{"enableAutoUpdate":false}}' > "$NESSY_HOME/settings.json"
# upstream/0.19.1 uses npm; its prepare lifecycle builds all CLI/web/IDE
# workspaces and the CLI bundle. Keep native dependency install scripts enabled.
npm ci
npm run typecheck --workspace=packages/core --workspace=packages/cli --workspace=packages/webui
npm run check-types --workspace=packages/vscode-ide-companion
npx --no-install tsc --noEmit -p packages/web-shell/tsconfig.json
node "$controller_root/scripts/rebrand/rebrand.mjs" --root "$source_dir" --mode check --report "$output_dir/reports/check-after-build.json"
node "$controller_root/scripts/rebrand/verify-product.mjs" > "$output_dir/reports/product-checks.txt"
node scripts/cli-entry.js --version > "$output_dir/reports/version.txt"
node scripts/cli-entry.js --help > "$output_dir/reports/help.txt"
# The real provider ID remains public; see the oauth-provider config exception.
if sed '/--auth-type /s/"qwen-oauth"//g' "$output_dir/reports/help.txt" | grep -qi qwen; then
  echo 'Unreviewed upstream branding in --help' >&2
  exit 1
fi

unit_failed=0
for package in core cli sdk-typescript acp-bridge audio-capture webui web-shell \
  vscode-ide-companion channels/base channels/telegram channels/weixin \
  channels/dingtalk channels/feishu channels/qqbot scripts; do
  report_name="${package//\//-}"
  test_home="$output_dir/test-home/$report_name"
  test_tmp="$(mktemp -d)"
  mkdir -p "$test_home"
  if ! (
    args=()
    if [[ "$package" == scripts ]]; then
      cd "$source_dir"
      args+=(--config ./scripts/tests/vitest.config.ts)
    else
      cd "$source_dir/packages/$package"
    fi
    env -u NESSY_HOME -u NESSY_RUNTIME_DIR -u QWEN_HOME -u QWEN_RUNTIME_DIR \
      HOME="$test_home" TMPDIR="$test_tmp" \
      npx --no-install vitest run "${args[@]}" \
      --coverage.enabled=false --dangerouslyIgnoreUnhandledErrors=false --retry=0 \
      --maxWorkers=2 --minWorkers=1 --reporter=default --reporter=junit \
      --outputFile.junit="$output_dir/reports/$report_name-junit.xml"
  ); then
    unit_failed=1
  fi
done
if [[ "$unit_failed" != 0 ]]; then
  echo 'Unit tests failed; see the package JUnit reports.' >&2
  exit 1
fi
cd "$source_dir"
TEST_CLI_PATH="$source_dir/dist/cli.js" NESSY_SANDBOX=false npx --no-install vitest run --root ./integration-tests \
  --retry=0 --dangerouslyIgnoreUnhandledErrors=false cli/nessy-serve-streaming.test.ts --reporter=default --reporter=junit --outputFile.junit="$output_dir/reports/integration-junit.xml"
npm run prepare:package
npm pack ./dist --ignore-scripts --pack-destination "$output_dir/reports"
# Exercise the actual archive without changing the user/global installation.
npm install --prefix "$output_dir/installed" --omit=optional --no-audit --no-fund "$output_dir"/reports/*.tgz
"$output_dir/installed/node_modules/.bin/nessy" --version > "$output_dir/reports/installed-version.txt"
"$output_dir/installed/node_modules/.bin/nessy" --help > "$output_dir/reports/installed-help.txt"

# The receipt is written only after every check and archive-install smoke passed.
cd "$controller_root"
node "$controller_root/scripts/rebrand/pipeline.mjs" verified
