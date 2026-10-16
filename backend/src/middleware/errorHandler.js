import mongoose from 'mongoose';
import { AppError } from '../utils/errors.js';
import logger from '../config/logger.js';
import env from '../config/env.js';

/**
 * Translates driver- and ODM-level failures into domain errors.
 *
 * Kept in one place so that a duplicate key on a serial number produces the
 * same shaped response no matter which service triggered it.
 */
function normalize(err) {
  if (err instanceof AppError) return err;

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({
      code: 'FIELD_INVALID',
      field: e.path,
      message: e.message,
    }));
    return new AppError('Validation failed', { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }

  if (err instanceof mongoose.Error.CastError) {
    return new AppError(`Invalid value for ${err.path}`, {
      statusCode: 400,
      code: 'INVALID_IDENTIFIER',
      details: [{ code: 'INVALID_IDENTIFIER', field: err.path }],
    });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'field';
    return new AppError(`A record with this ${field} already exists`, {
      statusCode: 409,
      code: 'DUPLICATE_KEY',
      details: [{ code: 'DUPLICATE_KEY', field }],
    });
  }

  /**
   * body-parser failures. These are the CLIENT's fault and were being reported
   * as 500 INTERNAL_ERROR — so a truncated upload or a stray comma woke
   * whoever was on call, burned the error budget, and told the client nothing
   * it could act on because production replaces a 5xx message with "An
   * unexpected error occurred".
   *
   * They never reach a validator: express.json throws while reading the body,
   * before any route or schema has been chosen.
   */
  if (err.type === 'entity.too.large') {
    return new AppError('Request body is too large', {
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      details: [{ code: 'PAYLOAD_TOO_LARGE', limit: err.limit }],
    });
  }

  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return new AppError('Request body is not valid JSON', {
      statusCode: 400,
      code: 'MALFORMED_BODY',
    });
  }

  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return new AppError('Unsupported request encoding', { statusCode: 415, code: 'UNSUPPORTED_ENCODING' });
  }

  // Transient transaction failures that survived the retry helper.
  if (err.errorLabels?.includes('TransientTransactionError')) {
    return new AppError('The operation could not be completed due to concurrent activity. Please retry.', {
      statusCode: 409,
      code: 'TRANSACTION_CONFLICT',
    });
  }

  return new AppError('An unexpected error occurred', { statusCode: 500, code: 'INTERNAL_ERROR', cause: err });
}

// Express identifies error handlers by arity — the fourth parameter must stay.
export function errorHandler(err, req, res, _next) {
  const error = normalize(err);
  const requestId = req.context?.requestId;

  const logPayload = {
    requestId,
    code: error.code,
    statusCode: error.statusCode,
    path: req.originalUrl,
    method: req.method,
    actor: req.context?.actor?.id ?? null,
    err: error.cause ?? error,
  };

  if (error.statusCode >= 500) logger.error(logPayload, error.message);
  else logger.warn(logPayload, error.message);

  const body = {
    success: false,
    // The stable machine code travels in the RESPONSE, not just the log.
    //
    // ARCHITECTURE.md says clients and tests match on codes and never on
    // message text — but until Phase 8 the code was only ever logged, so there
    // was nothing to match on unless the error happened to carry `details`.
    // Phase 8's tests were the first thing to actually try, and they got
    // `undefined`. Wording stays free to change only if the code ships with it.
    code: error.code,
    message: error.statusCode >= 500 && env.isProduction ? 'An unexpected error occurred' : error.message,
    errors: error.details ?? [],
  };
  if (requestId) body.requestId = requestId;
  if (!env.isProduction && error.statusCode >= 500 && error.cause) {
    body.debug = { name: error.cause.name, message: error.cause.message };
  }

  return res.status(error.statusCode).json(body);
}

export default errorHandler;
