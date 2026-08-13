#!/usr/bin/env bash
# Stops the local test Postgres cluster started by db-start.sh. Data
# directory is left in place; pass --wipe to also delete it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/.pgdata/data"

if pg_ctl -D "$DATA_DIR" status >/dev/null 2>&1; then
  pg_ctl -D "$DATA_DIR" stop -m fast
else
  echo "Postgres not running for $DATA_DIR"
fi

if [ "${1:-}" = "--wipe" ]; then
  rm -rf "$ROOT/.pgdata"
  echo "Wiped $ROOT/.pgdata"
fi
