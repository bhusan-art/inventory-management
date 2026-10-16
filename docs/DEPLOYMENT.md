# Deployment

This is the first-run procedure, in order. The steps are not interchangeable:
the keyfile must exist before mongod starts, the database user must exist
before the backend connects, and the frontend must be built before nginx mounts
its output.

The production stack **refuses to start** on a bad configuration rather than
starting and failing later. If `docker compose up` exits with a list of
problems, that list is the whole answer — see [Boot refusals](#boot-refusals).

---

## 0. What you are deploying

| | |
|---|---|
| `mongo` | MongoDB 7, single-node replica set, `--auth` + keyfile |
| `backend` | API, Node 20, no source mounts |
| `worker` | Scheduled jobs (SLA checks, warranty expiry), same image |
| `nginx` | TLS termination, static frontend, `/api/` proxy |

There is no frontend container. The frontend builds to static files that nginx
serves directly.

---

## 1. The MongoDB keyfile

A replica set with authentication requires a keyfile so members can
authenticate to **each other** — even with a single member. mongod refuses to
start without it.

```bash
openssl rand -base64 756 > docker/mongo-keyfile
chmod 400 docker/mongo-keyfile
# mongod runs as uid 999 inside the container and rejects a file it cannot read.
sudo chown 999:999 docker/mongo-keyfile
```

> Permissions are checked, not advisory. mongod exits on a keyfile that is
> group- or world-readable, with a message about permissions that is easy to
> read past.

The keyfile is gitignored. Rotating it later means restarting the replica set,
so keep a copy somewhere you will still have in a year.

---

## 2. Database credentials

Set these in a `.env` beside `docker-compose.prod.yml` — compose reads that file
for variable substitution:

```bash
cat > .env <<'EOF'
MONGO_USER=ims
MONGO_PASSWORD=<a long random password>
EOF
chmod 600 .env
```

`MONGO_PASSWORD` has no default. Compose fails with a message naming it rather
than starting a database with a blank password.

Bring mongo up alone first so it initiates the replica set and creates the root
user:

```bash
docker compose -f docker-compose.prod.yml up -d mongo
docker compose -f docker-compose.prod.yml logs -f mongo    # wait for healthy
```

Then create the application user:

```bash
docker compose -f docker-compose.prod.yml exec mongo mongosh \
  "mongodb://${MONGO_USER}:${MONGO_PASSWORD}@localhost:27017/admin" --eval '
  db.getSiblingDB("ims").createUser({
    user: "ims_app",
    pwd: "<a different long random password>",
    roles: [{ role: "readWrite", db: "ims" }]
  })'
```

> The application does **not** use the root account. A compromised API should
> not be able to drop a database or create users. `readWrite` on `ims` is all
> it needs.

---

## 3. Backend environment

```bash
cp backend/.env.production.example backend/.env.production
chmod 600 backend/.env.production
```

Fill it in. Every value is checked at boot. Generate the two secrets
**separately** — the same value in both is refused:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
```

`MONGODB_URI` uses the application user from step 2:

```
mongodb://ims_app:<password>@mongo:27017/ims?replicaSet=rs0&authSource=ims
```

---

## 4. TLS certificates

nginx terminates TLS and exits at startup if the files are missing. It does
**not** fall back to http — deliberately: the refresh token is an HttpOnly
cookie with `Secure`, and a browser will not send it over plain http. Over http
every session silently fails to refresh and users are signed out every fifteen
minutes with nothing in the logs.

Place two files in `docker/certs/`:

```
docker/certs/fullchain.pem
docker/certs/privkey.pem
```

With Let's Encrypt, the http server block leaves `/.well-known/acme-challenge/`
unredirected for exactly this purpose. With certificates you already hold,
copy them in under those two names.

Check the config before bringing the stack up:

```bash
docker compose -f docker-compose.prod.yml run --rm nginx nginx -t
```

---

## 5. Build the frontend

```bash
cd frontend && npm ci && npm run build && cd ..
ls frontend/dist/index.html    # must exist
```

> An **empty** `frontend/dist` mounts cleanly and serves 404s for every page,
> which looks like a routing problem rather than a missing build. Check the
> file is there.

---

## 6. Start

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps        # all healthy
curl -sf https://your-host/api/v1/health/ready
```

Then seed the first company and administrator:

```bash
docker compose -f docker-compose.prod.yml exec backend node src/db/seed.js
```

`SEED_DEMO_DATA=false` in `.env.production` keeps the demo records out. Sign in
with the printed credentials and **change the password immediately** — the
account is created with `mustChangePassword`, so the app will insist.

---

## Boot refusals

The backend collects every configuration problem and prints them together, so a
first deployment learns everything wrong in one attempt instead of one restart
per mistake.

| Message | Meaning |
|---|---|
| `JWT_SECRET is a placeholder value` | Still the development value. |
| `JWT_SECRET is N characters; use at least 32` | The schema accepts 16; production does not. The token is the entire authorization model. |
| `must differ` | One leak must not compromise both. |
| `CLIENT_URL is unset` | Defaults to localhost, so CORS refuses the real site — which presents as a backend outage. |
| `still contains a localhost origin` | A development origin left in the list. |
| `needs https to be Secure` | See step 4. |
| `MONGODB_URI carries no credentials` | mongod runs with `--auth`; the failure would otherwise read as a database fault. |
| `names no replicaSet` | Transactions are unavailable without one, and every stock movement depends on them. Standalone does not error — the transactions silently do nothing. |
| `LOG_LEVEL is silent` | An incident would leave no trace. |

---

## Backup and restore

```bash
./scripts/backup.sh                      # → ./backups/<timestamp>/
./scripts/restore.sh ./backups/<stamp>   # prompts before replacing anything
```

Both parts are taken and restored **together**. A `mongodump` alone restores a
system where every document record points at a file that is not there — and the
failure is quiet, because the list screens render perfectly and only a download
404s.

Run it from cron on the host, not inside a container:

```cron
0 2 * * * cd /srv/inventory-management && ./scripts/backup.sh >> /var/log/ims-backup.log 2>&1
```

> **A backup you have never restored is not a backup.** Restore into a
> throwaway copy of the stack at least once, and finish by opening one document
> download — that is the step that proves the storage volume came back, and the
> only one the database counts cannot tell you.

`restore.sh` stops the backend and worker first (restoring underneath a running
application hands it a half-replaced database), clears the storage volume before
extracting (otherwise files deleted since the backup reappear), and then counts
what came back and checks readiness. "The command exited zero" is not a restore.

---

## Upgrading

```bash
./scripts/backup.sh                                        # first, always
git pull
cd frontend && npm ci && npm run build && cd ..
docker compose -f docker-compose.prod.yml up -d --build
```

> Rebuild with `--renew-anon-volumes` if a dependency was added. An anonymous
> volume from an earlier run shadows `node_modules` and the new package is
> missing at runtime while the build log says it installed — this cost a Phase
> 10 debugging session over `multer`.

Migrations are explicit and idempotent; run any the release notes name, e.g.:

```bash
docker compose -f docker-compose.prod.yml exec backend \
  node src/db/migrations/001-notification-read-state.mjs
```

---

## Operating notes

**Logs.** JSON lines from pino. `docker compose -f docker-compose.prod.yml logs -f backend`.
Every error response carries a `requestId` that appears in the matching log
line — ask a user for it rather than guessing which request was theirs.

**Health.** `/api/v1/health/live` says the process is up; `/api/v1/health/ready`
says it can reach the database. Point an uptime check at `ready`.

**API documentation.** `/api/v1/docs` is generated from the live router, so it
cannot describe an endpoint that does not exist. It is **off** in production:
a complete list of endpoints with the permission each one demands is a
reconnaissance gift. Set `DOCS_ENABLED=true` only behind a VPN or for a short
window.

**Load testing.** `backend/scripts/load-test.mjs` measures latency
distribution and the exact error codes returned under concurrency. The `read`
scenario is safe; the write scenarios mutate data and refuse to run without
`--i-know-this-writes`. It is a measurement tool and asserts no thresholds —
see `docs/PHASE-12.md` on the open dispatch conflict.

**What is not here.** No email transport, so password reset issues a token the
administrator conveys by hand and scheduled report delivery is unimplemented.
A second worker is *safe* — the jobs take an advisory Mongo lock with a TTL, so
each scheduled run happens once across however many workers exist, and a worker
that crashes mid-job does not block that job forever. What is missing is the
reason to run one: the jobs are not partitioned, so a second instance adds
redundancy, not throughput. Nothing in the stack publishes the database port,
and nothing should.
