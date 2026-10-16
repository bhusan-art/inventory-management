import rateLimit from 'express-rate-limit';
import env from '../config/env.js';
import { RateLimitedError } from '../utils/errors.js';

/**
 * One factory for every rate limiter in the system.
 *
 * Two things were wrong with declaring them inline per router.
 *
 * First, `message:` makes express-rate-limit write the response itself. That
 * bypasses `errorHandler`, so the 429 was the only reply in the system with no
 * top-level `code` and no `requestId` — while the spec published this phase
 * states plainly that every error carries a stable machine code to match on. A
 * client doing the documented thing got `undefined`. Passing a
 * `RateLimitedError` to `next` instead puts the 429 through the same handler as
 * everything else, so there is one error shape and it cannot drift again.
 *
 * Second, the limits were written as `env.isTest ? 100_000 : 5` at each call
 * site. The production number was therefore never exercised by anything, and a
 * test asserting the 429 path could only assert the relaxed branch. Here the
 * real limit is kept and `env.isTest` only *raises* it, so a test that wants
 * the limiter can ask for it by passing an explicit limit.
 */
export function createRateLimiter({
  windowMs = 60_000,
  limit,
  message,
  skipSuccessfulRequests = false,
  force = false,
} = {}) {
  return rateLimit({
    windowMs,
    limit: env.isTest && !force ? 100_000 : limit,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // `handler` replaces `message`: the limiter decides *that* the request is
    // refused, the error handler decides what a refusal looks like on the wire.
    handler: (req, res, next) => next(new RateLimitedError(message)),
  });
}

/** The global ceiling. Volume, not credential stuffing. */
export const globalLimiter = (overrides = {}) =>
  createRateLimiter({ limit: 300, message: 'Too many requests. Try again shortly.', ...overrides });

/**
 * Credential endpoints, far tighter. The threat is thousands of attempts
 * spread across many accounts, which sits comfortably inside 300/min.
 * `skipSuccessfulRequests` means a legitimate user is never locked out by
 * their own successful sign-ins.
 */
export const credentialLimiter = (overrides = {}) =>
  createRateLimiter({
    limit: 5,
    skipSuccessfulRequests: true,
    message: 'Too many attempts. Try again shortly.',
    ...overrides,
  });

export default createRateLimiter;
