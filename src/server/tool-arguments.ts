import { ModelError } from './model-config.ts';
import type { ToolSchema } from './proxy-model-bridge.ts';

type UnknownRecord = Record<string, unknown>;
const fault = (message: string): never => {
  throw new ModelError(message);
};
const object = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function validateToolArguments(value: unknown, schema: ToolSchema, depth = 0): void {
  if (depth > 30) fault('Tool arguments are nested too deeply.');
  if (schema.enum && !schema.enum.includes(value))
    fault('Tool argument is outside the allowed choices.');
  if (schema.type === 'object') {
    const record = object(value) ? value : fault('Tool arguments must be an object.');
    for (const key of schema.required || [])
      if (!Object.hasOwn(record, key)) fault('Required tool argument is missing.');
    for (const [key, child] of Object.entries(record)) {
      if (!Object.hasOwn(schema.properties || {}, key)) {
        if (schema.additionalProperties === false) fault('Unknown tool argument.');
      } else {
        const childSchema = schema.properties?.[key];
        if (childSchema) validateToolArguments(child, childSchema, depth + 1);
      }
    }
  } else if (schema.type === 'array') {
    const values = Array.isArray(value) ? value : fault('Invalid tool argument array.');
    if (values.length < (schema.minItems || 0) || values.length > (schema.maxItems ?? 10000))
      fault('Invalid tool argument array.');
    for (const child of values) validateToolArguments(child, schema.items || {}, depth + 1);
  } else if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length < (schema.minLength || 0) ||
      value.length > (schema.maxLength ?? 1000000)
    )
      fault('Invalid tool argument text.');
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isSafeInteger(value)) ||
      (typeof value === 'number' && value < (schema.minimum ?? -Infinity)) ||
      (typeof value === 'number' && value > (schema.maximum ?? Infinity))
    )
      fault('Invalid numeric tool argument.');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean')
    fault('Invalid boolean tool argument.');
}
