import { codesForStatus, type JsonObject } from '@framework/core';
import { z } from 'zod/v4';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type ErrorStatusCode = 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 422 | 429 | 500 | 503;

export interface OperationSpec {
  readonly method: HttpMethod;
  /** Hono-style path relative to the group prefix, e.g. `/:id`. */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  /** `public` is explicit; otherwise list security scheme names. */
  readonly security: 'public' | readonly string[];
  readonly request?: {
    readonly params?: z.ZodObject;
    readonly query?: z.ZodObject;
    readonly body?: z.ZodType;
  };
  readonly responses: Readonly<Record<number, { readonly description: string; readonly schema?: z.ZodType }>>;
  readonly errors?: readonly ErrorStatusCode[];
}

export interface Operation extends OperationSpec {
  readonly fullPath: string;
  readonly tag: string;
}

export interface DocumentOptions {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  readonly operations: readonly Operation[];
  readonly securitySchemes?: Readonly<Record<string, object>>;
}

/** Attaches a mount prefix and tag to a module's operation list. */
export function defineOperations(prefix: string, tag: string, specs: readonly OperationSpec[]): Operation[] {
  return specs.map((spec) => ({ ...spec, tag, fullPath: joinPath(prefix, spec.path) }));
}

export function joinPath(prefix: string, path: string): string {
  const joined = `${prefix.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`.replace(/\/+$/, '');
  return joined === '' ? '/' : joined;
}

/** `/products/:id` -> `/products/{id}` */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

const ERROR_DESCRIPTIONS: Record<ErrorStatusCode, string> = {
  400: 'Malformed request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Resource not found',
  405: 'Method not allowed',
  409: 'Conflict',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Validation failed',
  429: 'Too many requests',
  500: 'Internal server error',
  503: 'Service unavailable',
};

/**
 * One envelope schema per status: `error.code` is an enum of exactly the
 * catalog codes that can be returned with that status. Only 422 carries
 * `fields` — it is the only status that ever produces them.
 */
export function errorEnvelopeSchema(status: ErrorStatusCode) {
  const codes = codesForStatus(status);
  return z.object({
    error: z.object({
      code: codes.length > 0 ? z.enum(codes) : z.string(),
      message: z.string(),
      ...(status === 422
        ? { fields: z.array(z.object({ path: z.string(), message: z.string(), code: z.string() })).optional() }
        : {}),
      requestId: z.string().optional(),
    }),
  });
}

/**
 * Zod -> JSON Schema (2020-12, as used by OpenAPI 3.1). Refinements and
 * transforms cannot be represented; they are emitted as unconstrained and
 * remain enforced at runtime.
 */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonObject {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonObject;
  return rest;
}

function parameters(location: 'path' | 'query', schema: z.ZodObject | undefined) {
  if (!schema) return [];
  const object = jsonSchema(schema, 'input') as { properties?: Record<string, object>; required?: string[] };
  return Object.entries(object.properties ?? {}).map(([name, property]) => ({
    name,
    in: location,
    required: location === 'path' || (object.required ?? []).includes(name),
    schema: property,
  }));
}

function operationObject(operation: Operation) {
  const responses: Record<string, object> = {};
  for (const [status, response] of Object.entries(operation.responses)) {
    responses[status] = response.schema
      ? {
          description: response.description,
          content: { 'application/json': { schema: jsonSchema(response.schema, 'output') } },
        }
      : { description: response.description };
  }
  for (const status of operation.errors ?? []) {
    responses[String(status)] = {
      description: ERROR_DESCRIPTIONS[status],
      content: { 'application/json': { schema: { $ref: `#/components/schemas/ErrorEnvelope${status}` } } },
    };
  }
  return {
    operationId: operation.operationId,
    summary: operation.summary,
    tags: [operation.tag],
    security: operation.security === 'public' ? [] : operation.security.map((name) => ({ [name]: [] })),
    parameters: [...parameters('path', operation.request?.params), ...parameters('query', operation.request?.query)],
    ...(operation.request?.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: jsonSchema(operation.request.body, 'input') } },
          },
        }
      : {}),
    responses,
  };
}

export function generateOpenApiDocument(options: DocumentOptions) {
  const ids = new Set<string>();
  const paths: Record<string, Record<string, object>> = {};
  const errorStatuses = new Set<ErrorStatusCode>();
  for (const operation of options.operations) {
    if (ids.has(operation.operationId)) throw new Error(`Duplicate operationId "${operation.operationId}"`);
    ids.add(operation.operationId);
    const path = toOpenApiPath(operation.fullPath);
    paths[path] = { ...paths[path], [operation.method]: operationObject(operation) };
    for (const status of operation.errors ?? []) errorStatuses.add(status);
  }
  const errorSchemas: Record<string, object> = {};
  for (const status of [...errorStatuses].sort((a, b) => a - b)) {
    errorSchemas[`ErrorEnvelope${status}`] = jsonSchema(errorEnvelopeSchema(status), 'output');
  }
  return {
    openapi: '3.1.0',
    info: {
      title: options.title,
      version: options.version,
      ...(options.description ? { description: options.description } : {}),
    },
    paths,
    components: {
      schemas: errorSchemas,
      ...(options.securitySchemes ? { securitySchemes: options.securitySchemes } : {}),
    },
  };
}

/** Reports routes without documentation and documentation without routes. */
export function checkOperations(
  routes: readonly { readonly method: string; readonly path: string }[],
  operations: readonly Operation[],
): string[] {
  const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;
  const routeKeys = new Set(routes.map((route) => key(route.method, route.path)));
  const documented = new Set(operations.map((op) => key(op.method, op.fullPath)));
  return [
    ...[...routeKeys].filter((k) => !documented.has(k)).map((k) => `Undocumented route: ${k}`),
    ...[...documented].filter((k) => !routeKeys.has(k)).map((k) => `Documented operation has no route: ${k}`),
  ];
}
