import { jest } from '@jest/globals';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { DomainError, NotFoundError } from '../../src/utils/errors.js';

/**
 * What the CLIENT receives — not what the error object holds.
 *
 * `errors.test.js` already asserted that a DomainError carries `code`. It
 * passed throughout, while the response body carried no code at all: the
 * middleware logged it and dropped it. A test on the error object cannot see
 * that, because the object was never the thing that was broken.
 *
 * So these assertions run the real middleware and read the real body. The
 * lesson generalises: test the boundary the consumer reads, not the value on
 * the way there.
 */
function capture(err) {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  const req = { originalUrl: '/api/v1/test', method: 'POST', context: { requestId: 'req-1' } };

  errorHandler(err, req, res, jest.fn());
  return res;
}

describe('error response shape', () => {
  it('sends the machine code in the body, not only to the log', () => {
    const res = capture(new DomainError('Stock is insufficient', 'INSUFFICIENT_STOCK'));

    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
    expect(res.body.success).toBe(false);
  });

  it('gives a code to every error, including ones with no details', () => {
    // The gap only showed on errors without `details`, because a client could
    // otherwise read the code out of `errors[0]`.
    const res = capture(new DomainError('Unit still at the service centre', 'UNIT_STILL_HELD'));

    expect(res.body.errors).toEqual([]);
    expect(res.body.code).toBe('UNIT_STILL_HELD');
  });

  it('keeps the request id for correlating a report with the log', () => {
    expect(capture(new NotFoundError('Warranty not found')).body.requestId).toBe('req-1');
  });

  it('does not leak an internal cause into the message', () => {
    const res = capture(new Error('connection string: mongodb://user:hunter2@host/db'));

    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).toBe('An unexpected error occurred');
    expect(JSON.stringify(res.body.message)).not.toContain('hunter2');
  });

  it('maps a duplicate key to a conflict with a named field', () => {
    const duplicate = Object.assign(new Error('E11000'), {
      code: 11000,
      keyPattern: { serialNumber: 1 },
    });
    const res = capture(duplicate);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_KEY');
    expect(res.body.errors[0].field).toBe('serialNumber');
  });

  it('maps a surviving transient transaction failure to a retryable conflict', () => {
    const transient = Object.assign(new Error('write conflict'), {
      errorLabels: ['TransientTransactionError'],
    });
    const res = capture(transient);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('TRANSACTION_CONFLICT');
  });
});
