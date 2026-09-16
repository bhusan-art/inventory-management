import { ValidationError } from '../utils/errors.js';

/**
 * Zod validation for params, query and body.
 *
 * Validated values REPLACE the raw ones on the request, so handlers downstream
 * receive coerced, trimmed, defaulted data and cannot accidentally read an
 * unvalidated field. Zod strips unknown keys by default, which also means a
 * client cannot mass-assign `tokenVersion` or `role` by adding them to a body.
 */
export function validate(schemas = {}) {
  return function validator(req, res, next) {
    const issues = [];

    for (const source of ['params', 'query', 'body']) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (!result.success) {
        issues.push(
          ...result.error.issues.map((i) => ({
            code: 'FIELD_INVALID',
            field: [source, ...i.path].join('.'),
            message: i.message,
          })),
        );
      } else {
        // req.query is a getter in Express 5; assign defensively.
        try {
          req[source] = result.data;
        } catch {
          Object.defineProperty(req, source, { value: result.data, writable: true });
        }
      }
    }

    if (issues.length > 0) return next(new ValidationError('Validation failed', issues));
    return next();
  };
}

export default validate;
