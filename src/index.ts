// Public API of @framework/openapi.
// Convention: every interface/type lives in `./types`; runtime values stay
// in their modules.
export {
  checkOperations,
  defineOperations,
  errorEnvelopeSchema,
  generateOpenApiDocument,
  joinPath,
  toOpenApiPath,
} from './document';

// Grouped conventions: every type in ./types.
export type {
  DocumentOptions,
  ErrorStatusCode,
  HttpMethod,
  Operation,
  OperationSpec,
} from './types';
