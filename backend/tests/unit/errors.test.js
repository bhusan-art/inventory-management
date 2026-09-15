import {
  AppError,
  DomainError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
} from '../../src/utils/errors.js';

describe('error hierarchy', () => {
  it('carries a stable machine code alongside the HTTP status', () => {
    const err = new DomainError('Stock is insufficient', 'INSUFFICIENT_STOCK');
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('INSUFFICIENT_STOCK');
    expect(err.isOperational).toBe(true);
    expect(err).toBeInstanceOf(AppError);
  });

  it('defaults each error type to its correct status', () => {
    expect(new NotFoundError().statusCode).toBe(404);
    expect(new ForbiddenError().statusCode).toBe(403);
    expect(new ConflictError().statusCode).toBe(409);
  });

  it('preserves the underlying cause for logging', () => {
    const cause = new Error('driver exploded');
    const err = new AppError('wrapped', { cause });
    expect(err.cause).toBe(cause);
  });
});
