# Phase 0 — Foundation

## Exit criteria (from the roadmap)

> `rs.status()` healthy; a test transaction commits and rolls back correctly.

## What was delivered

**Repository and tooling**
- Monorepo layout matching ARCHITECTURE.md §10.
- ESLint flat config for both packages.
- Jest with coverage thresholds (raised each phase).
- GitHub Actions CI: lint + test on a real replica set, frontend lint + build.

**Runtime**
- `docker-compose.yml` with MongoDB as a single-node replica set, initiated
  automatically by an idempotent healthcheck.
- `docker-compose.prod.yml` with auth, keyfile, nginx and a separate worker.
- Multi-stage Dockerfiles for backend (dev/prod, non-root in prod) and frontend.

**Backend foundation**
- Boot-time environment validation (Zod), with production guards against
  placeholder and duplicated JWT secrets.
- MongoDB connection with retry, plus an explicit **replica set assertion** that
  refuses to start against a standalone deployment.
- Structured logging (pino) with redaction configured centrally.
- `requestContext` via `AsyncLocalStorage` — request id, IP, user agent, actor.
- Centralized error handling with a stable machine-code taxonomy, translating
  Mongoose validation, cast and duplicate-key errors into domain errors.
- `withTransaction` helper: retry on transient conflicts, post-commit task
  queue, session threading.
- `Counter` model with atomic `nextSequence`.
- Health endpoints separating liveness from readiness, with transaction
  availability reported independently of connectivity.
- Worker process entrypoint and a TTL-backed Mongo advisory lock.

**Frontend foundation**
- Vite + React + Tailwind, dev proxy on `/api`, multi-stage Docker build.
- A placeholder page that renders the live API health contract.

## Verification

`backend/tests/integration/transaction.test.js` asserts, against a real
replica set:

1. the deployment is a replica set;
2. a committed transaction persists every write;
3. a failing transaction persists **none** of its writes, including those made
   before the failure;
4. `onCommit` tasks run after commit and never after an abort;
5. a failing post-commit task does not undo the committed business fact;
6. 50 concurrent `nextSequence` calls produce 50 distinct numbers.

Item 3 is the property every later phase depends on. Item 6 is the reason
document numbers are not derived from a count.

## Two guardrails worth knowing about

**The ESLint rule in `backend/eslint.config.js`** forbids `.select('+field')`
outside `src/repositories/`. Restricted fields are `select: false` at the schema
level, so that projection is the only way to read one. Confining it to the
repository layer means access control cannot be quietly bypassed later.

**The application refuses to start against a standalone MongoDB.** Failing at
boot with a clear message costs a minute; discovering in Phase 3 that months of
"transactional" code was never transactional costs an audit of every service.

## Not in this phase

No domain models beyond `Counter`, no authentication, no business logic. Phase 1
adds authentication, users, roles, permissions, scope enforcement, the
restricted-field registry and the audit writer.

## Blocking question for Phase 1

Single company, or will this ever serve a second legal entity? Phase 1 writes
the `User` model and the scope middleware — a tenant discriminator costs about a
day now and weeks after Phase 8.
