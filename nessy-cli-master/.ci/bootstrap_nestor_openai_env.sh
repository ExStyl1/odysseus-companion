#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Скрипт для подготовки dp-auth окружения Nessy CLI integration/E2E тестов
# Используется в CI/CD и локально для получения DP токена, экспорта переменных
# окружения и записи ~/.nessy/dp_auth_creds.json для dp-auth сценариев
#
# Переменные окружения:
#   NESTOR_URL                        — URL сервиса Nestor
#                                       (по умолчанию https://code-completion-nestor.tcsbank.ru)
#   NESTOR_MODELS_URL                 — URL endpoint для списка CLI моделей
#                                       (по умолчанию "$NESTOR_URL/api/v1/cli/models")
#   OPENAI_BASE_URL_DEFAULT           — базовый URL OpenAI-compatible endpoint
#                                       (по умолчанию "$NESTOR_URL/api/v1/cli/openai-like/v1")
#   OPENAI_MODEL_DEFAULT              — модель по умолчанию для integration тестов
#                                       (по умолчанию tgpt/qwen35-397b-a17b-fp8)
#   NESSY_DP_AVAILABLE_MODELS         — явный override списка dp-auth моделей
#                                       через запятую
#   NESSY_DP_AVAILABLE_MODELS_DEFAULT — fallback список dp-auth моделей через запятую,
#                                       если endpoint моделей недоступен
#   DEVICE_ID                         — идентификатор устройства
#                                       (по умолчанию nessy-cli-ci)
#   DEFAULT_USERNAME                  — имя пользователя по умолчанию
#                                       (по умолчанию nessy-cli-e2e)
#   NESSY_CLI_E2E_SA_KEY              — путь к ключу сервисного аккаунта
#                                       для "dp auth service-acc"
#
# Результат:
# - экспортирует OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL,
#   NESSY_INTEGRATION_MODEL и NESSY_DP_AVAILABLE_MODELS в текущий shell
# - сохраняет ~/.nessy/dp_auth_creds.json для ACP и других dp-auth flow
#
# Пример локального запуска:
#   export NESSY_CLI_E2E_SA_KEY=/abs/path/to/sa.json
#   source ./.ci/bootstrap_nestor_openai_env.sh

set -euo pipefail

NESTOR_URL="${NESTOR_URL:-https://code-completion-nestor.tcsbank.ru}"
NESTOR_MODELS_URL="${NESTOR_MODELS_URL:-$NESTOR_URL/api/v1/cli/models}"
OPENAI_BASE_URL_DEFAULT="${OPENAI_BASE_URL_DEFAULT:-$NESTOR_URL/api/v1/cli/openai-like/v1}"
OPENAI_MODEL_DEFAULT="${OPENAI_MODEL_DEFAULT:-tgpt/qwen35-397b-a17b-fp8}"
NESSY_DP_AVAILABLE_MODELS_DEFAULT="${NESSY_DP_AVAILABLE_MODELS_DEFAULT:-tgpt/qwen35-397b-a17b-fp8,tgpt/qwen3-next-80b-a3b-instruct,tgpt/gpt-oss-120b}"
DEVICE_ID="${DEVICE_ID:-nessy-cli-ci}"
DEFAULT_USERNAME="${DEFAULT_USERNAME:-nessy-cli-e2e}"

: "${NESSY_CLI_E2E_SA_KEY:?Set NESSY_CLI_E2E_SA_KEY (GitLab file variable) for integration tests}"

if ! command -v dp >/dev/null 2>&1; then
  echo "dp CLI is required to bootstrap integration credentials" >&2
  exit 1
fi

# Service-account path:
# - raw DP token is exported for tests that still use the OpenAI-compatible
#   transport
# - exchanged Nessy JWT is written to ~/.nessy/dp_auth_creds.json for dp-auth
dp auth service-acc --key-file "$NESSY_CLI_E2E_SA_KEY"
DP_TOKEN="$(dp auth print-token)"
[[ -n "$DP_TOKEN" ]] || {
  echo "dp auth returned an empty token" >&2
  exit 1
}

export OPENAI_API_KEY="$DP_TOKEN"
export OPENAI_BASE_URL="$OPENAI_BASE_URL_DEFAULT"
export OPENAI_MODEL="$OPENAI_MODEL_DEFAULT"
export NESSY_INTEGRATION_MODEL="$OPENAI_MODEL_DEFAULT"

DP_CREDS_PATH=""
# Exchange the DP bearer token for a Nessy JWT used by dp-auth flows.
AUTH_JSON="$(
  curl -fsS -X POST "$NESTOR_URL/api/v2/token" \
    -H "Accept: application/json" \
    -H "device-id: $DEVICE_ID" \
    -H "Authorization: Bearer $DP_TOKEN" \
    -H "user-agent: nessy-cli-ci-bootstrap" \
    -H "ext-preferred-username: $DEFAULT_USERNAME"
)"

NESSY_JWT="$(printf '%s' "$AUTH_JSON" | node -e "const fs=require('node:fs');const auth=JSON.parse(fs.readFileSync(0,'utf8'));if(!auth.jwt){process.exit(1)};process.stdout.write(auth.jwt);")"

FETCHED_MODELS_CSV="$(
  curl -fsS "$NESTOR_MODELS_URL" \
    -H "Accept: application/json" \
    -H "Nestor-Token: $NESSY_JWT" \
    -H "user-agent: nessy-cli-ci-bootstrap" \
  | node -e "const fs=require('node:fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));const models=(Array.isArray(data)?data:(data.models||[])).map((item)=>item.name).filter(Boolean);process.stdout.write(models.join(','));" \
  || true
)"

export NESSY_DP_AVAILABLE_MODELS="$(
  printf '%s' "${NESSY_DP_AVAILABLE_MODELS:-${FETCHED_MODELS_CSV:-$NESSY_DP_AVAILABLE_MODELS_DEFAULT}}"
)"

export AUTH_JSON DEFAULT_USERNAME OPENAI_BASE_URL_DEFAULT OPENAI_MODEL_DEFAULT
BOOTSTRAP_OUTPUT="$(node <<'NODE'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const authJson = process.env.AUTH_JSON;
if (!authJson) {
  throw new Error('AUTH_JSON is not set');
}

const auth = JSON.parse(authJson);
if (!auth.jwt) {
  throw new Error(`JWT is missing in token exchange response: ${authJson}`);
}

const jwt = auth.jwt;
const payloadBase64Url = jwt.split('.')[1];
if (!payloadBase64Url) {
  throw new Error('JWT payload is missing');
}

const payloadBase64 = payloadBase64Url.replace(/-/g, '+').replace(/_/g, '/');
const payloadJson = Buffer.from(payloadBase64.padEnd(Math.ceil(payloadBase64.length / 4) * 4, '='), 'base64').toString('utf8');
const payload = JSON.parse(payloadJson);
const expiresAt = typeof payload.exp === 'number'
  ? payload.exp * 1000
  : Date.now() + 60 * 60 * 1000;
const username = payload.preferred_username || process.env.DEFAULT_USERNAME || 'nessy-cli-e2e';
const userId = payload.sub || username;
const cachedModels = (process.env.NESSY_DP_AVAILABLE_MODELS || '')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean)
  .map((id) => ({
    id,
    name: id,
    default: id === process.env.OPENAI_MODEL_DEFAULT,
  }));

const credentialsPath = path.join(os.homedir(), '.nessy', 'dp_auth_creds.json');
fs.mkdirSync(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  credentialsPath,
  JSON.stringify({ jwt, expiresAt, username, userId, cachedModels }, null, 2),
  { encoding: 'utf8', mode: 0o600 },
);

process.stdout.write(JSON.stringify({
  jwt,
  baseUrl: process.env.OPENAI_BASE_URL_DEFAULT,
  model: process.env.OPENAI_MODEL_DEFAULT,
  credentialsPath,
}));
NODE
)"
DP_CREDS_PATH="$(printf '%s' "$BOOTSTRAP_OUTPUT" | node -e "const fs=require('node:fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(data.credentialsPath);")"

echo "Bootstrapped integration credentials from DP service account"
echo "Exported OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL for this shell"
echo "Wrote DP cached credentials to $DP_CREDS_PATH"
