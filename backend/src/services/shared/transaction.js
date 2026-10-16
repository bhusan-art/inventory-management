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
/**
 * Five attempts, with jittered backoff.
 *
 * Three was chosen when the only expected conflict was genuine contention —
 * two users claiming the same stock — where a third failure means the caller
 * really should be told. Slow storage changes the arithmetic: on a filesystem
 * where a majority write costs 50–160ms, these transactions sit idle 93% of
 * their lifetime (mongod reports ~143ms inactive against ~11ms active), and the
 * window for a transient failure is correspondingly wide.
 *
 * The jitter matters as much as the count. A fixed 25ms × attempt backoff makes
 * two colliding requests retry in lockstep and collide again; randomising
 * breaks the synchronisation.
 */
const MAX_ATTEMPTS = 5;

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
          // Exponential with full jitter: 0–50ms, 0–100ms, 0–200ms, 0–400ms.
          const ceiling = 25 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, Math.random() * ceiling));
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
