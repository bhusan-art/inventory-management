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
