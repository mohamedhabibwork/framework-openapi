import { describe, expect, test } from 'bun:test';
import { z } from 'zod/v4';
import {
  checkOperations,
  defineOperations,
  errorEnvelopeSchema,
  generateOpenApiDocument,
  joinPath,
  toOpenApiPath,
} from '../src';

const item = z.object({ id: z.uuid(), name: z.string() });
const operations = defineOperations('/api/v1/items', 'Items', [
  {
    method: 'post',
    path: '/',
    operationId: 'createItem',
    summary: 'Create',
    security: 'public',
    request: { body: item.pick({ name: true }) },
    responses: { 201: { description: 'Created', schema: item } },
    errors: [400, 401, 422],
  },
  {
    method: 'get',
    path: '/:id',
    operationId: 'showItem',
    summary: 'Show',
    security: ['bearerAuth'],
    request: { params: z.object({ id: z.uuid() }), query: z.object({ expand: z.string().optional() }) },
    responses: { 200: { description: 'Item', schema: item } },
    errors: [404, 503],
  },
]);

describe('OpenAPI', () => {
  test('converts Hono paths', () => {
    expect(toOpenApiPath('/a/:id/b/:slug')).toBe('/a/{id}/b/{slug}');
  });

  test('generates a 3.1 document with explicit operation ids, auth and errors', () => {
    const doc = generateOpenApiDocument({ title: 'Test', version: '1.0.0', operations });
    expect(doc.openapi).toBe('3.1.0');
    const create = doc.paths['/api/v1/items']?.post as Record<string, unknown>;
    expect(create.operationId).toBe('createItem');
    expect(create.security).toEqual([]);
    expect(Object.keys(create.responses as object).sort()).toEqual(['201', '400', '401', '422']);
    const show = doc.paths['/api/v1/items/{id}']?.get as {
      parameters: { name: string; in: string; required: boolean }[];
      security: unknown;
    };
    expect(show.security).toEqual([{ bearerAuth: [] }]);
    expect(show.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
      expect.objectContaining({ name: 'expand', in: 'query', required: false }),
    ]);
  });

  test('rejects duplicate operation ids', () => {
    expect(() =>
      generateOpenApiDocument({ title: 'T', version: '1', operations: [...operations, ...operations] }),
    ).toThrow(/Duplicate operationId/);
  });

  test('detects drift between routes and documentation', () => {
    const problems = checkOperations(
      [
        { method: 'POST', path: '/api/v1/items' },
        { method: 'DELETE', path: '/api/v1/items/:id' },
      ],
      operations,
    );
    expect(problems).toEqual([
      'Undocumented route: DELETE /api/v1/items/:id',
      'Documented operation has no route: GET /api/v1/items/:id',
    ]);
  });

  test('clean routes produce no drift findings', () => {
    expect(checkOperations([{ method: 'POST', path: '/api/v1/items' }], operations.slice(0, 1))).toEqual([]);
  });

  test('emits one error-envelope component per declared status', () => {
    const doc = generateOpenApiDocument({ title: 'Test', version: '1.0.0', operations });
    const schemas = doc.components.schemas as Record<string, { properties?: Record<string, unknown> }>;
    expect(Object.keys(schemas).sort()).toEqual([
      'ErrorEnvelope400',
      'ErrorEnvelope401',
      'ErrorEnvelope404',
      'ErrorEnvelope422',
      'ErrorEnvelope503',
    ]);
    const create = doc.paths['/api/v1/items']?.post as {
      responses: Record<string, { content: { 'application/json': { schema: { $ref: string } } } }>;
    };
    expect(create.responses['422']?.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/ErrorEnvelope422',
    );
  });

  test('error codes are catalogued enums scoped to the status', () => {
    const codes = (status: number): string[] => {
      const schema = errorEnvelopeSchema(status as never);
      const code = (schema.shape.error as z.ZodObject).shape.code as z.ZodEnum;
      return code.options as string[];
    };
    expect(codes(400).sort()).toEqual(['BAD_REQUEST', 'MALFORMED_JSON']);
    expect(codes(400)).not.toContain('NOT_FOUND');
    expect(codes(501)).toEqual(['CAPABILITY_UNSUPPORTED']);
    expect(codes(503).sort()).toEqual(['SEARCH_ENGINE_UNAVAILABLE', 'SERVICE_UNAVAILABLE']);
    expect(codes(401)).toEqual(['UNAUTHENTICATED']);
  });

  test('only 422 carries field errors; every envelope allows a request id', () => {
    const fields422 = errorEnvelopeSchema(422).shape.error as z.ZodObject;
    expect('fields' in fields422.shape).toBe(true);
    const fields400 = errorEnvelopeSchema(400).shape.error as z.ZodObject;
    expect('fields' in fields400.shape).toBe(false);
    expect('requestId' in fields400.shape).toBe(true);
  });

  test('a status outside the catalog degrades to a string code', () => {
    const schema = errorEnvelopeSchema(418 as never);
    const code = (schema.shape.error as z.ZodObject).shape.code;
    expect(code.def.type).toBe('string');
  });

  test('joins prefixes and normalizes slashes', () => {
    expect(joinPath('/api/v1', '/')).toBe('/api/v1');
    expect(joinPath('/api/v1/', ':id')).toBe('/api/v1/:id');
    expect(joinPath('', '')).toBe('/');
    expect(toOpenApiPath('/a/:id')).toBe('/a/{id}');
  });

  test('renders security schemes and request bodies', () => {
    const doc = generateOpenApiDocument({
      title: 'Test',
      version: '1.0.0',
      operations,
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    });
    expect(doc.components.securitySchemes).toEqual({ bearerAuth: { type: 'http', scheme: 'bearer' } });
    const create = doc.paths['/api/v1/items']?.post as {
      requestBody: { required: boolean; content: { 'application/json': { schema: Record<string, unknown> } } };
    };
    expect(create.requestBody.required).toBe(true);
    expect(create.requestBody.content['application/json'].schema.properties).toHaveProperty('name');
  });
});
