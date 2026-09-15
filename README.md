# Enterprise Inventory, Warehouse, Serial Number and Warranty Management System

Traceability for every unit of stock from purchase order to warranty expiry.
No pricing, costing or financial data is stored anywhere in this system by
design — see `docs/ARCHITECTURE.md` §0.

**Status: Phase 0 (foundation) complete.**

## Quick start

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
docker compose up --build
```

- API — http://localhost:5000/api/v1/health/ready
- App — http://localhost:5173

The app shows the live API health contract. If it reports `ready`, the stack is
wired correctly and MongoDB is running as a replica set.

## Why MongoDB runs as a replica set

Every stock movement in this system is a multi-document transaction: the
inventory row, the ledger entry, the serial number records and the source
document all change together or not at all. `mongod` in standalone mode does
not support transactions — it accepts `startSession()` and then fails, or
worse, appears to work.

The application therefore **refuses to start** against a standalone deployment
(`src/config/db.js`), the readiness probe reports transaction availability
separately from connectivity, and `docker-compose.yml` initiates the replica
set automatically on first boot.

## Layout

```
backend/    Express API + background worker (same image, different command)
frontend/   React SPA (Vite)
docker/     nginx config, mongo helpers
docs/       architecture, setup, operations
```

## Scripts

| Location | Command | Does |
|---|---|---|
| backend | `npm run dev` | API with file watching |
| backend | `npm run worker:dev` | scheduled-job worker |
| backend | `npm test` | unit + integration (needs a replica set) |
| backend | `npm run lint` | ESLint, including the architectural guardrails |
| frontend | `npm run dev` | Vite dev server with `/api` proxy |
| frontend | `npm run build` | production bundle |

## Documentation

- `docs/ARCHITECTURE.md` — the approved design. Read §0 first.
- `docs/SETUP.md` — local setup, including running without Docker.
- `docs/PHASE-0.md` — what this phase delivered and how it was verified.
