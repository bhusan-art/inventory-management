#!/usr/bin/env bash
#
# Backup: the database AND the uploaded documents.
#
# Both, always. A mongodump alone restores a system in which every document
# record points at a file that is not there — and the failure is quiet, because
# the list screens render perfectly and only a download 404s. The two must be
# captured together or the restore is incomplete in a way nobody notices until
# somebody needs a warranty certificate.
#
# Usage:
#   ./scripts/backup.sh [destination-directory]
#
# Default destination: ./backups
#
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DEST="${1:-./backups}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
OUT="${DEST}/${STAMP}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH." >&2
  exit 1
fi

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "No $COMPOSE_FILE here. Run this from the project root." >&2
  exit 1
fi

mkdir -p "$OUT"
echo "Backing up to ${OUT}"

# ---------------------------------------------------------------- database
#
# Credentials come from the backend's own env file rather than being passed on
# the command line: an argument is visible in `ps` to every user on the host.
echo "  mongodump…"
docker compose -f "$COMPOSE_FILE" exec -T mongo sh -c '
  mongodump --archive --gzip --db=ims \
    --username="${MONGO_USER:-ims}" --password="${MONGO_PASSWORD}" \
    --authenticationDatabase=admin 2>/dev/null
' > "${OUT}/mongo.archive.gz"

if [ ! -s "${OUT}/mongo.archive.gz" ]; then
  echo "mongodump produced an empty archive — check MONGO_USER/MONGO_PASSWORD in the mongo service." >&2
  exit 1
fi

# ---------------------------------------------------------------- documents
echo "  documents…"
docker compose -f "$COMPOSE_FILE" exec -T backend tar -cz -C /app/storage . \
  > "${OUT}/storage.tar.gz"

# ---------------------------------------------------------------- manifest
#
# What was taken, from where, and with which image. A restore six months from
# now needs to know whether the archive predates a schema migration.
cat > "${OUT}/MANIFEST.txt" <<EOF
taken          ${STAMP}
host           $(hostname)
compose file   ${COMPOSE_FILE}
mongo image    $(docker compose -f "$COMPOSE_FILE" images mongo --format json 2>/dev/null | head -c 400)
db archive     $(du -h "${OUT}/mongo.archive.gz" | cut -f1)
storage        $(du -h "${OUT}/storage.tar.gz" | cut -f1)

Restore with:  ./scripts/restore.sh ${OUT}
EOF

echo
cat "${OUT}/MANIFEST.txt"
echo
echo "Done. A backup you have never restored is not a backup — see docs/DEPLOYMENT.md."
