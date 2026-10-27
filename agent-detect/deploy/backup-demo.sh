#!/bin/sh
# Backs up the Docker demo's reports database (compose.yaml, deploy/DOCKER.md).
# Uses SQLite's online backup, so the app keeps running; checks the copy before keeping it,
# and deletes all but the newest BACKUP_KEEP copies.
#
#   deploy/backup-demo.sh                          # -> ~/agent-demo-backups/demo-YYYY-MM-DD.db
#   BACKUP_DIR=/srv/backups BACKUP_KEEP=12 deploy/backup-demo.sh
#
# Weekly from cron (crontab -e), Sundays at 03:15:
#   15 3 * * 0 $HOME/agent-demo/agent-detect/deploy/backup-demo.sh >> $HOME/agent-demo-backups/backup.log 2>&1
set -eu

cd "$(dirname "$0")/.."   # agent-detect/, where compose.yaml is
dest=${BACKUP_DIR:-$HOME/agent-demo-backups}
keep=${BACKUP_KEEP:-8}
case "$keep" in ''|*[!0-9]*|0) echo "BACKUP_KEEP must be a positive number" >&2; exit 1 ;; esac

# Reports include visitors' IP addresses: only this user can read the backups.
umask 077
mkdir -p "$dest"

file="$dest/demo-$(date +%F).db"
echo "$(date -Is) backing up to $file"

# -T: no terminal under cron. The copy goes in /data because docker cp can't read the app's tmpfs.
cleanup() { docker compose exec -T app rm -f /data/backup.db /data/backup.db-wal /data/backup.db-shm; }
trap "cleanup 2>/dev/null || true" EXIT
cleanup
docker compose exec -T app node -e '
  const sqlite = require("node:sqlite");
  sqlite.backup(new sqlite.DatabaseSync("/data/demo.db"), "/data/backup.db").then(() => {
    const copy = new sqlite.DatabaseSync("/data/backup.db");
    copy.exec("PRAGMA journal_mode = DELETE"); // one self-contained file, no -wal/-shm beside it
    const check = copy.prepare("PRAGMA integrity_check").get().integrity_check;
    if (check !== "ok") throw new Error("integrity check failed: " + check);
    console.log("reports in backup:", copy.prepare("SELECT count(*) AS n FROM reports").get().n);
    copy.close();
  }).catch((err) => { console.error(err.message); process.exit(1); });'
docker compose cp app:/data/backup.db "$file" >/dev/null
chmod 600 "$file"   # docker cp keeps the container's file mode, ignoring umask

# Newest first; remove everything after the first $keep.
ls -1t "$dest"/demo-*.db | tail -n +"$((keep + 1))" | while read -r old; do rm -f "$old"; echo "removed $old"; done
echo "$(date -Is) done"
