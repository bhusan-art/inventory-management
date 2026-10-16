#!/usr/bin/env bash
#
# Restore a backup taken by ./scripts/backup.sh.
#
# THIS REPLACES THE `ims` DATABASE AND THE STORAGE VOLUME. It asks before doing
# either, and the prompt names the target, because the single most likely way
# to lose this system is to restore a staging backup onto production while
# reading a different terminal.
#
# Usage:
#   ./scripts/restore.sh ./backups/2026-10-15_143000
#
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
SRC="${1:-}"

if [ -z "$SRC" ]; then
  echo "Usage: ./scripts/restore.sh <backup-directory>" >&2
  exit 2
fi

for f in mongo.archive.gz storage.tar.gz; do
  if [ ! -s "${SRC}/${f}" ]; then
    echo "Missing or empty: ${SRC}/${f}" >&2
    echo "Both parts are required — a database without its documents restores" >&2
    echo "records that point at files which are not there." >&2
    exit 1
  fi
done

[ -f "${SRC}/MANIFEST.txt" ] && { echo; cat "${SRC}/MANIFEST.txt"; echo; }

echo "This will REPLACE:"
echo "  - the 'ims' database in the mongo service of ${COMPOSE_FILE}"
echo "  - everything under /app/storage in the backend service"
echo
read -r -p "Type the word RESTORE to continue: " confirm
if [ "$confirm" != "RESTORE" ]; then
  echo "Aborted; nothing was changed."
  exit 1
fi

# ---------------------------------------------------------------- stop writers
#
# The API and worker are stopped first. Restoring underneath a running
# application gives it a half-replaced database to read, and the worker may
# write into the middle of the restore.
echo "Stopping backend and worker…"
docker compose -f "$COMPOSE_FILE" stop backend worker >/dev/null

# ---------------------------------------------------------------- database
echo "Restoring database…"
docker compose -f "$COMPOSE_FILE" exec -T mongo sh -c '
  mongorestore --archive --gzip --drop --nsInclude="ims.*" \
    --username="${MONGO_USER:-ims}" --password="${MONGO_PASSWORD}" \
    --authenticationDatabase=admin
' < "${SRC}/mongo.archive.gz"

# ---------------------------------------------------------------- documents
#
# Cleared before extracting. Without that, files deleted since the backup
# reappear, and a document deleted for a reason is back with no record of it.
echo "Restoring documents…"
docker compose -f "$COMPOSE_FILE" start backend >/dev/null
docker compose -f "$COMPOSE_FILE" exec -T backend sh -c '
  rm -rf /app/storage/* && tar -xz -C /app/storage
' < "${SRC}/storage.tar.gz"

echo "Starting worker…"
docker compose -f "$COMPOSE_FILE" start worker >/dev/null

# ---------------------------------------------------------------- verify
#
# "The command exited zero" is not a restore. This counts what came back and
# checks the application can actually read it.
echo
echo "Verifying…"
docker compose -f "$COMPOSE_FILE" exec -T mongo sh -c '
  mongosh --quiet "mongodb://${MONGO_USER:-ims}:${MONGO_PASSWORD}@localhost:27017/ims?authSource=admin" --eval "
    [\"users\", \"products\", \"inventories\", \"stockledgerentries\", \"auditlogs\"]
      .forEach(c => print(\"  \" + c.padEnd(22) + db.getCollection(c).countDocuments()));
  "'

echo
echo -n "  readiness             "
docker compose -f "$COMPOSE_FILE" exec -T backend node -e '
  fetch("http://localhost:5000/api/v1/health/ready")
    .then(r => r.json())
    .then(j => console.log(j.data?.status ?? JSON.stringify(j)))
    .catch(e => { console.log("UNREACHABLE: " + e.message); process.exit(1); });
' || true

echo
echo "Restored from ${SRC}."
echo "Sign in and open one document download before calling this verified."
