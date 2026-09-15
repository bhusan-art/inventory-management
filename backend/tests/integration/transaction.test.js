/**
 * PHASE 0 EXIT CRITERION.
 *
 * Everything this system promises about inventory accuracy rests on
 * multi-document transactions actually working. These tests prove three
 * things against the real database:
 *
 *   1. The deployment is a replica set (a standalone mongod would make every
 *      later transaction a silent no-op).
 *   2. A committed transaction persists all of its writes.
 *   3. A failed transaction persists none of them — including writes made
 *      before the failure.
 *
 * Test 3 is the one that matters. It is the property a GRN posting depends on:
 * if step 6e throws, steps 6a through 6d must not have happened.
 */
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase, assertReplicaSet } from '../../src/config/db.js';
import { withTransaction } from '../../src/services/shared/transaction.js';
import { Counter, nextSequence } from '../../src/models/Counter.js';

beforeAll(async () => {
  await connectDatabase({ retries: 3, delayMs: 1000 });
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDatabase();
});

beforeEach(async () => {
  await Counter.deleteMany({});
});

describe('database topology', () => {
  it('is a replica set, so transactions are available', async () => {
    const setName = await assertReplicaSet();
    expect(setName).toBeTruthy();
  });
});

describe('withTransaction', () => {
  it('commits all writes when the callback succeeds', async () => {
    const result = await withTransaction(async ({ session }) => {
      const a = await nextSequence('TEST:commit', { session });
      const b = await nextSequence('TEST:commit', { session });
      return { a, b };
    });

    expect(result).toEqual({ a: 1, b: 2 });

    const counter = await Counter.findById('TEST:commit');
    expect(counter.seq).toBe(2);
  });

  it('rolls back every write when the callback throws', async () => {
    const boom = new Error('simulated failure at step 6e');

    await expect(
      withTransaction(async ({ session }) => {
        // Two successful writes...
        await nextSequence('TEST:rollback', { session });
        await Counter.create([{ _id: 'TEST:rollback-sibling', seq: 99 }], { session });
        // ...then a failure. Neither write may survive.
        throw boom;
      }),
    ).rejects.toThrow('simulated failure at step 6e');

    expect(await Counter.findById('TEST:rollback')).toBeNull();
    expect(await Counter.findById('TEST:rollback-sibling')).toBeNull();
  });

  it('runs onCommit tasks only after a successful commit', async () => {
    const ran = [];

    await withTransaction(async ({ session, onCommit }) => {
      await nextSequence('TEST:hooks', { session });
      onCommit(() => ran.push('audit'));
      onCommit(() => ran.push('notify'));
      expect(ran).toEqual([]); // not yet — still inside the transaction
    });

    expect(ran).toEqual(['audit', 'notify']);
  });

  it('does not run onCommit tasks when the transaction aborts', async () => {
    const ran = [];

    await expect(
      withTransaction(async ({ session, onCommit }) => {
        await nextSequence('TEST:hooks-abort', { session });
        onCommit(() => ran.push('audit'));
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    expect(ran).toEqual([]);
    expect(await Counter.findById('TEST:hooks-abort')).toBeNull();
  });

  it('survives a post-commit task failing', async () => {
    await expect(
      withTransaction(async ({ session, onCommit }) => {
        await nextSequence('TEST:hook-failure', { session });
        onCommit(() => {
          throw new Error('audit sink unavailable');
        });
      }),
    ).resolves.not.toThrow();

    // The business fact is durable even though the side effect failed.
    const counter = await Counter.findById('TEST:hook-failure');
    expect(counter.seq).toBe(1);
  });
});

describe('nextSequence', () => {
  it('never issues the same number twice under concurrency', async () => {
    const CONCURRENT = 50;

    const numbers = await Promise.all(
      Array.from({ length: CONCURRENT }, () => nextSequence('TEST:concurrent')),
    );

    expect(new Set(numbers).size).toBe(CONCURRENT);
    expect(Math.max(...numbers)).toBe(CONCURRENT);
  });
});
