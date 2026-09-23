# Setup

## With Docker (recommended)

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
docker compose up --build
```

The `mongo` service starts with `--replSet rs0` and its healthcheck runs
`rs.initiate()` on first boot. The backend waits for that healthcheck, so
ordering is handled for you.

Verify:

```bash
curl -s localhost:5000/api/v1/health/ready | jq
```

Expect `checks.transactions.status: "available"`. If it says `unavailable`, the
replica set did not initiate — see Troubleshooting.

## Without Docker

You still need a replica set. A single-node one is fine:

```bash
mkdir -p ~/data/ims
mongod --dbpath ~/data/ims --replSet rs0 --bind_ip 127.0.0.1
```

In a second terminal, once only:

```bash
mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"
```

Then:

```bash
cd backend  && cp .env.example .env && npm install && npm run dev
cd frontend && cp .env.example .env && npm install && npm run dev
```

## Running tests

Tests run against a real MongoDB, not an in-memory mock — the properties being
tested (transaction rollback, atomic increment under concurrency) do not exist
in a mock.

```bash
cd backend
MONGODB_URI="mongodb://localhost:27017/ims_test?replicaSet=rs0&directConnection=true" npm test
```

The test database is dropped after each run. Point it at a throwaway database
name; never at your development data.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | `development` / `test` / `production` |
| `PORT` | no | default 5000 |
| `LOG_LEVEL` | no | `debug` in dev, `info` in production |
| `MONGODB_URI` | yes | must point at a replica set |
| `CLIENT_URL` | yes | comma-separated allowed browser origins |
| `JWT_SECRET` | yes | `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | yes | must differ from `JWT_SECRET` |
| `JWT_ACCESS_TTL` | no | default `15m` |
| `JWT_REFRESH_TTL_DAYS` | no | default 7 |
| `UPLOAD_PATH` | no | default `./storage` |
| `MAX_UPLOAD_BYTES` | no | default 10 MB |
| `PROCESS_ROLE` | no | `api` or `worker` |

Configuration is validated at boot. A missing or malformed value exits the
process with a readable message rather than failing later inside a request.

In production the process additionally refuses to start if the JWT secrets are
still placeholders, or if the two secrets are identical.

## Troubleshooting

**`MongoDB is running standalone`** — the replica set was never initiated. With
Docker: `docker compose down -v && docker compose up`. Without: run the
`rs.initiate()` command above.

**`checks.transactions.status: "unavailable"` but the database is connected** —
same cause. Connectivity and transaction capability are reported separately on
purpose.

**Frontend loads but shows `unreachable`** — the backend is not up yet, or
`VITE_API_PROXY` points at the wrong host. Inside Docker the proxy target must
be the service name, not `localhost`.

**Backend exits with `Cannot find module` after adding a dependency** — the
anonymous volume in `docker-compose.yml` (`- /app/node_modules`) persists across
`docker compose up --build`, so a rebuilt image mounts stale modules over the
new ones. Fix with `docker compose down -v` (this also wipes MongoDB, so re-run
the seed), or name the volume so it can be removed on its own:

```yaml
    volumes:
      - ./backend:/app
      - backend-node-modules:/app/node_modules
```

then `docker volume rm <project>_backend-node-modules` after any dependency
change, with no data loss.

**Locked out of an account after five wrong passwords** — login failures are
deliberately indistinguishable (see docs/PHASE-1.md), so a lockout looks like a
wrong password. Check the audit log for `ACCOUNT_LOCKED`, then:

```
docker compose exec mongo mongosh ims
db.users.updateOne({email:"..."},{$set:{lockedUntil:null,failedLoginAttempts:0}})
```

On Windows, use the interactive `mongosh` shell rather than `--eval`: PowerShell
strips the quotes before Docker sees them.

**`npm install` fails in frontend/ with ERESOLVE** — `@vitejs/plugin-react` v4
only supports Vite 4 and 5. On Vite 7 you need `@vitejs/plugin-react` ^5.
Similarly, `eslint-plugin-react-hooks` v4 will not install alongside ESLint 9;
v5 supports both.

**Seed fails with `CastError ... at path "_id" for model "Permission"`** — an
old copy of `config/db.js` still has `mongoose.set('sanitizeFilter', true)`.
That setting mangles developer-written query operators and must stay off; see
docs/PHASE-1.md.

**Tests hang on connection** — the test `MONGODB_URI` is missing
`?replicaSet=rs0&directConnection=true`. Without `directConnection`, the driver
tries to discover replica set members by their advertised hostnames, which do
not resolve from outside the container.
