/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// [nessy-fork] tool-arg-simple-type-coercion

type JsonSchema = Record<string, unknown>;

export function structuredCloneWithToolArgCoercion<T extends object>(
  value: T,
  schema: unknown,
): T {
  const clone = structuredClone(value);
  coerceToolArgsBySchema(schema, clone);
  return clone;
}

export function coerceToolArgsBySchema(schema: unknown, data: unknown): void {
  if (!isMutableContainer(data)) return;
  coerceValueForSchema(data, schema);
}

function coerceValueForSchema(value: unknown, schema: unknown): unknown {
  const schemaRecord = asSchemaRecord(schema);
  if (!schemaRecord) return value;

  if (typeof value === 'string') {
    return coerceStringScalar(value, schemaRecord);
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      for (const itemSchema of getItemSchemas(schemaRecord, index)) {
        const coerced = coerceValueForSchema(value[index], itemSchema);
        if (coerced !== value[index]) {
          value[index] = coerced;
        }
      }
    }
    return value;
  }

  if (isPlainRecord(value)) {
    for (const key of Object.keys(value)) {
      for (const propSchema of getPropertySchemas(schemaRecord, key)) {
        const coerced = coerceValueForSchema(value[key], propSchema);
        if (coerced !== value[key]) {
          value[key] = coerced;
        }
      }
    }
  }

  return value;
}

function coerceStringScalar(value: string, schema: JsonSchema): unknown {
  const acceptedTypes = getAcceptedTypes(schema);
  if (!acceptedTypes || acceptedTypes.has('string')) {
    return value;
  }

  const trimmed = value.trim();
  if (acceptedTypes.has('boolean')) {
    const lower = trimmed.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }

  if (acceptedTypes.has('integer') || acceptedTypes.has('number')) {
    if (trimmed === '') return value;
    const numberValue = Number(trimmed);
    if (!Number.isFinite(numberValue)) return value;
    if (acceptedTypes.has('integer') && Number.isInteger(numberValue)) {
      return numberValue;
    }
    if (acceptedTypes.has('number')) {
      return numberValue;
    }
  }

  return value;
}

function getAcceptedTypes(schema: JsonSchema): Set<string> | null {
  const types = new Set<string>();
  addTypeKeyword(types, schema['type']);

  for (const keyword of ['anyOf', 'oneOf']) {
    const variants = schema[keyword];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      const variantSchema = asSchemaRecord(variant);
      if (variantSchema) {
        addTypeKeyword(types, variantSchema['type']);
      }
    }
  }

  return types.size > 0 ? types : null;
}

function addTypeKeyword(types: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    types.add(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const typeName of value) {
    if (typeof typeName === 'string') {
      types.add(typeName);
    }
  }
}

function getPropertySchemas(schema: JsonSchema, key: string): JsonSchema[] {
  const propertySchemas: JsonSchema[] = [];
  for (const variant of getSchemaVariants(schema)) {
    const properties = variant['properties'];
    if (!isPlainRecord(properties)) continue;
    const propSchema = asSchemaRecord(properties[key]);
    if (propSchema) {
      propertySchemas.push(propSchema);
    }
  }
  return propertySchemas;
}

function getItemSchemas(schema: JsonSchema, index: number): JsonSchema[] {
  const itemSchemas: JsonSchema[] = [];
  for (const variant of getSchemaVariants(schema)) {
    const items = variant['items'];
    if (Array.isArray(items)) {
      const itemSchema = asSchemaRecord(items[index]);
      if (itemSchema) {
        itemSchemas.push(itemSchema);
      }
    } else {
      const itemSchema = asSchemaRecord(items);
      if (itemSchema) {
        itemSchemas.push(itemSchema);
      }
    }
  }
  return itemSchemas;
}

function getSchemaVariants(schema: JsonSchema): JsonSchema[] {
  const variants = [schema];
  for (const keyword of ['anyOf', 'oneOf']) {
    const value = schema[keyword];
    if (!Array.isArray(value)) continue;
    for (const variant of value) {
      const variantSchema = asSchemaRecord(variant);
      if (variantSchema) {
        variants.push(variantSchema);
      }
    }
  }
  return variants;
}

function asSchemaRecord(value: unknown): JsonSchema | null {
  return isPlainRecord(value) ? value : null;
}

function isMutableContainer(value: unknown): value is JsonSchema | unknown[] {
  return isPlainRecord(value) || Array.isArray(value);
}

function isPlainRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
