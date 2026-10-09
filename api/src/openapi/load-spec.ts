import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export type JsonSchema = Record<string, unknown>;

export type OpenApiSpec = {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, JsonSchema>;
    parameters?: Record<string, JsonSchema>;
  };
};

export function specPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/openapi.yaml');
}

export function loadOpenApiSpec(): OpenApiSpec {
  const raw = fs.readFileSync(specPath(), 'utf8');
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OpenAPI spec is empty or invalid');
  }
  return parsed as OpenApiSpec;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function componentSchema(spec: OpenApiSpec, name: string): JsonSchema {
  const schema = spec.components.schemas[name];
  if (!schema) {
    throw new Error(`Missing OpenAPI schema ${name}`);
  }
  return deref(clone(schema), spec);
}

function deref(node: unknown, spec: OpenApiSpec): JsonSchema {
  if (Array.isArray(node)) {
    return node.map((item) => deref(item, spec)) as unknown as JsonSchema;
  }
  if (!node || typeof node !== 'object') {
    return node as JsonSchema;
  }
  const record = node as JsonSchema;
  if (typeof record.$ref === 'string') {
    return componentSchema(spec, refName(record.$ref));
  }
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = deref(value, spec);
  }
  return out;
}

function refName(ref: string): string {
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix)) {
    throw new Error(`Unsupported $ref: ${ref}`);
  }
  return ref.slice(prefix.length);
}
