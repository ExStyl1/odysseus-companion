const NESSY_DISPLAY_NAME_KEY = '_displayName';
const NESSY_INTENT_KEY = '_intent';

const NESSY_DISPLAY_NAME_SCHEMA = {
  type: 'string',
  description: 'Nessy UI metadata: human-friendly action name for display only.',
};

const NESSY_INTENT_SCHEMA = {
  type: 'string',
  description: 'Nessy UI metadata: concise tool-call intent for display only.',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneWithDescriptors<T extends object>(value: T): T {
  const clone = Object.create(Object.getPrototypeOf(value));
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(value));
  return clone;
}

/**
 * Return a Pi tool schema that accepts Nessy's root-level metadata fields.
 *
 * Pi validates tool arguments before Nessy's pre-tool-use hook can strip
 * `_displayName` / `_intent`. Built-in Pi tools often use strict schemas with
 * `additionalProperties: false`, so we add those fields as optional root
 * properties at the adapter boundary. Unknown schema shapes are returned
 * unchanged, and upstream-defined metadata properties win if Pi adds them later.
 */
export function allowNessyMetadataProperties<T>(schema: T): T {
  if (!isRecord(schema)) return schema;

  const properties = schema.properties;
  if (!isRecord(properties)) return schema;

  const nextSchema = cloneWithDescriptors(schema);
  const nextProperties = cloneWithDescriptors(properties);

  if (!(NESSY_DISPLAY_NAME_KEY in nextProperties)) {
    nextProperties[NESSY_DISPLAY_NAME_KEY] = NESSY_DISPLAY_NAME_SCHEMA;
  }
  if (!(NESSY_INTENT_KEY in nextProperties)) {
    nextProperties[NESSY_INTENT_KEY] = NESSY_INTENT_SCHEMA;
  }

  Object.defineProperty(nextSchema, 'properties', {
    value: nextProperties,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return nextSchema as T;
}

/** Strip Nessy-only metadata before invoking the upstream Pi tool implementation. */
export function stripNessyMetadata<T>(input: T): T {
  if (!isRecord(input)) return input;
  if (!(NESSY_DISPLAY_NAME_KEY in input) && !(NESSY_INTENT_KEY in input)) return input;

  const cleanInput = { ...input };
  delete cleanInput[NESSY_DISPLAY_NAME_KEY];
  delete cleanInput[NESSY_INTENT_KEY];

  return cleanInput as T;
}
