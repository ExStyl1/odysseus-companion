export const NESTOR_GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';

export const NESTOR_GATEWAY_QWEN_MODELS = Object.freeze([
  'tgpt/qwen35-397b-a17b-fp8',
  'tgpt/qwen36-35b-a3b-fp8',
]);

export const NESTOR_GATEWAY_QWEN_DIALECT_V1 = Object.freeze({
  id: 'nessy-gateway-qwen',
  version: 1,
});

type JsonRecord = Record<string, unknown>;

export function isNestorGatewayUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const candidate = new URL(baseUrl.trim());
    const prefix = new URL(NESTOR_GATEWAY_BASE_URL);
    const path = candidate.pathname.replace(/\/+$/, '');
    const basePath = prefix.pathname.replace(/\/+$/, '');
    return candidate.origin === prefix.origin
      && (path === basePath || path.startsWith(`${basePath}/`));
  } catch {
    return false;
  }
}

/** The two ids whose tool-schema handling needs weakening, wherever they run. */
export function isNestorGatewayQwenModel(model: unknown): boolean {
  return NESTOR_GATEWAY_QWEN_MODELS.includes(String(model));
}

/**
 * Keyed on the MODEL, not the URL: the same Qwen ids are reachable through a
 * BYO llm-proxy connection, and the schema weakening is a quality mitigation
 * for those two ids rather than a property of the gateway. Deliberately NOT
 * widened to every model — strict schemas and forced `tool_choice` work
 * unadapted through llm-proxy (verified live 2026-08-14).
 */
export function adaptToolRequestForDialect(
  body: unknown,
  options: {
    dialect: typeof NESTOR_GATEWAY_QWEN_DIALECT_V1;
    /**
     * Apply regardless of the model id (E6). The id allowlist above cannot see
     * a Qwen model an endpoint serves under its own house name, and that model
     * needs the weakening just as much — this is the user saying so explicitly
     * on their own connection.
     */
    force?: boolean;
  },
): unknown {
  if (!isRecord(body)
    || options.dialect.id !== NESTOR_GATEWAY_QWEN_DIALECT_V1.id
    || options.dialect.version !== NESTOR_GATEWAY_QWEN_DIALECT_V1.version
    || !(options.force || isNestorGatewayQwenModel(body.model))) return body;

  const clone = structuredClone(body) as JsonRecord;
  delete clone.tool_choice;
  if (Array.isArray(clone.tools)) {
    for (const tool of clone.tools) {
      if (!isRecord(tool) || !isRecord(tool.function)) continue;
      weakenSchema(tool.function.parameters);
    }
  }
  return clone;
}

function weakenSchema(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const value of schema) weakenSchema(value);
    return;
  }
  if (!isRecord(schema)) return;
  delete schema.required;
  if (schema.additionalProperties === false) delete schema.additionalProperties;

  for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']) {
    const map = schema[key];
    if (isRecord(map)) for (const value of Object.values(map)) weakenSchema(value);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const values = schema[key];
    if (Array.isArray(values)) for (const value of values) weakenSchema(value);
  }
  for (const key of ['items', 'contains', 'not', 'if', 'then', 'else', 'propertyNames', 'unevaluatedProperties']) {
    weakenSchema(schema[key]);
  }
  if (isRecord(schema.additionalProperties)) weakenSchema(schema.additionalProperties);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
