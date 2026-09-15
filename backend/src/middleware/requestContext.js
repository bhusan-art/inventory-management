import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Ambient per-request context.
 *
 * The audit writer needs the actor, IP and request id, and it runs after the
 * service layer has returned. Threading those four values through every service
 * signature to get them there would pollute the entire codebase, so they live
 * here instead.
 */
const storage = new AsyncLocalStorage();

export function requestContext(req, res, next) {
  const requestId = req.get('x-request-id') || randomUUID();
  const context = {
    requestId,
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
    actor: null, // populated by the authenticate middleware in Phase 1
  };
  req.context = context;
  res.set('x-request-id', requestId);
  storage.run(context, () => next());
}

export function getContext() {
  return storage.getStore() ?? null;
}

export function setActor(actor) {
  const store = storage.getStore();
  if (store) store.actor = actor;
}

export default requestContext;
