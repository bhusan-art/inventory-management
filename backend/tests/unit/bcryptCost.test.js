import bcrypt from 'bcryptjs';
import { hashPassword } from '../../src/models/User.js';

/**
 * The test-only cost reduction must not be reachable from production.
 *
 * Lowering bcrypt cost for speed is safe only while the condition is exactly
 * NODE_ENV === 'test'. If it ever keyed on anything configurable — a flag, an
 * env var someone could set — a production deployment could be talked into
 * storing cost-4 hashes, and nobody would notice until a breach.
 */
describe('password hashing cost', () => {
  it('uses the reduced cost under test', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    const hash = await hashPassword('TestPassword123xyz');
    // bcrypt encodes the cost in the hash: $2a$04$...
    expect(hash.split('$')[2]).toBe('04');
  });

  it('still produces a verifiable hash', async () => {
    const hash = await hashPassword('TestPassword123xyz');
    await expect(bcrypt.compare('TestPassword123xyz', hash)).resolves.toBe(true);
    await expect(bcrypt.compare('wrong-password', hash)).resolves.toBe(false);
  });

  it('is keyed on NODE_ENV alone, with no configurable override', async () => {
    // Read the source rather than trusting the comment: the cost expression
    // must mention NODE_ENV and 'test', and must not read any other variable.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../src/models/User.js', import.meta.url), 'utf8');
    const line = source.split('\n').find((l) => l.includes('const BCRYPT_COST'));

    expect(line).toContain("process.env.NODE_ENV === 'test'");
    expect(line).toContain('12');
    // No second env var, no settings lookup, no flag.
    expect(line.match(/process\.env\.\w+/g)).toEqual(['process.env.NODE_ENV']);
  });
});
