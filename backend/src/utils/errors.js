/**
 * Domain error hierarchy.
 *
 * Every error carries a stable machine `code` alongside the HTTP status. The
 * frontend and the tests match on the code, never on the message text, so
 * message wording can change without breaking anything.
 */
export class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', details = [], cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details = []) {
    super(message, { statusCode: 400, code: 'VALIDATION_ERROR', details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    super(message, { statusCode: 401, code });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', code = 'FORBIDDEN', details = []) {
    super(message, { statusCode: 403, code, details });
  }
}

/**
 * Also used when a record exists but sits outside the actor's warehouse scope.
 * Returning 404 rather than 403 there is deliberate: 403 confirms the record
 * exists, which is itself a disclosure.
 */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', code = 'NOT_FOUND') {
    super(message, { statusCode: 404, code });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT', details = []) {
    super(message, { statusCode: 409, code, details });
  }
}

/** Business rule violation — the request was well-formed but the domain says no. */
export class DomainError extends AppError {
  constructor(message, code = 'DOMAIN_RULE_VIOLATION', details = []) {
    super(message, { statusCode: 422, code, details });
  }
}

/**
 * Rate limiting, as an error rather than a special case.
 *
 * express-rate-limit's `message` option writes its own response and never
 * reaches the error handler, so a 429 was the one reply in the system with no
 * top-level `code` — the exact defect Phase 8 fixed everywhere else. A client
 * matching on `code === 'RATE_LIMITED'`, which is what the contract tells it to
 * do, got `undefined` and fell through to a generic failure.
 */
export class RateLimitedError extends AppError {
  constructor(message = 'Too many requests. Try again shortly.', code = 'RATE_LIMITED') {
    super(message, { statusCode: 429, code });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service temporarily unavailable', code = 'SERVICE_UNAVAILABLE') {
    super(message, { statusCode: 503, code });
  }
}
