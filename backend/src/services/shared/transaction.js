import mongoose from 'mongoose';
import logger from '../../config/logger.js';

/**
 * Transaction helper. Every multi-step write in this system goes through here.
 *
 * Three things it gives you that a bare `session.withTransaction` does not:
 *
 *  1. Retry on TransientTransactionError. Under concurrency MongoDB will abort
 *     a transaction and label it retryable; the correct response is to run the
 *     whole callback again, not to fail the request.
 *  2. A post-commit queue. Audit logs, notifications and cache invalidation
 *     must run only if the transaction actually committed, and must not be
 *     inside it — an audit write that fails should never roll back a stock
 *     movement, and a notification sent for a rolled-back GRN is a lie.
 *  3. A single place to enforce that the session is threaded through. Every
 *     repository call inside the callback receives `session` explicitly; a
 *     write that forgets it silently escapes the transaction, which is the
 *     hardest bug in this class of system to find later.
 */
const MAX_ATTEMPTS = 3;

export async function withTransaction(fn, { maxAttempts = MAX_ATTEMPTS } = {}) {
  const session = await mongoose.startSession();
  const afterCommit = [];
  const ctx = {
    session,
    /** Defer work until the transaction has committed. */
    onCommit(task) {
      afterCommit.push(task);
    },
  };

  let attempt = 0;
  let result;

  try {
    for (;;) {
      attempt += 1;
      afterCommit.length = 0;
      try {
        session.startTransaction({
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });
        result = await fn(ctx);
        await session.commitTransaction();
        break;
      } catch (err) {
        if (session.inTransaction()) {
          await session.abortTransaction().catch(() => {});
        }

        const retryable =
          err?.errorLabels?.includes('TransientTransactionError') ||
          err?.errorLabels?.includes('UnknownTransactionCommitResult');

        if (retryable && attempt < maxAttempts) {
          logger.warn({ attempt, code: err.code }, 'Transaction conflict — retrying');
          await new Promise((r) => setTimeout(r, 25 * attempt));
          continue;
        }
        throw err;
      }
    }
  } finally {
    await session.endSession();
  }

  // Post-commit side effects. Failures here are logged, never thrown: the
  // business fact is already durable and reversing it would be worse.
  for (const task of afterCommit) {
    try {
      await task();
    } catch (err) {
      logger.error({ err }, 'Post-commit task failed');
    }
  }

  return result;
}

export default withTransaction;
