#!/bin/bash
# Supplied to Linux via stdin; never run directly on Mac.
set -euo pipefail
umask 077
ACTION=${1:?}
RUN=${2:?}
[[ "$RUN" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{6}$ ]] || exit 2
PROJECT=/home/cosiohzp/apps/zonglan-news
BACKUP="/home/cosiohzp/apps/zonglan-news-backups/$RUN"
cd "$PROJECT"
for tool in docker tar sha256sum curl flock python3; do command -v "$tool" >/dev/null; done
[ -f .env ] && [ -f docker-compose.yml ] && [ -d data ]
docker compose version >/dev/null
docker compose config --quiet
if [ "$ACTION" != check ]; then
  exec 9> .news-deploy.lock
  flock -n 9 || { echo 'Another deployment is running'; exit 1; }
fi
CID=$(docker compose ps -q qmreader)
[ -n "$CID" ] && [ "$(docker inspect -f '{{.State.Running}}' "$CID")" = true ]
# Require the known single-service deployment layout. Never print expanded env configuration.
[ "$(docker compose config --services)" = qmreader ]
IMAGE=$(docker inspect -f '{{.Image}}' "$CID")
TARGET=$(docker compose config --images)
[[ "$TARGET" =~ ^[a-zA-Z0-9._/:@-]+$ ]] && [[ "$TARGET" != *@* ]]
docker inspect "$CID" | python3 -c '
import json,sys
c=json.load(sys.stdin)[0]
assert any(m.get("Source")=="/home/cosiohzp/apps/zonglan-news/data" and m.get("Destination")=="/app/data" and m.get("RW") for m in c["Mounts"]), "Unexpected data mount"
assert c["HostConfig"]["PortBindings"] == {"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"3088"}]}, "Unexpected published ports"
'
curl -fsS --max-time 10 http://127.0.0.1:3088/ >/dev/null
if [ "$ACTION" = check ]; then echo '[news] Linux prerequisites passed'; exit 0; fi
# flock is released even if this SSH session fails; concurrent deployment mutations are rejected.
NEED_START=0
INSTALLING=0
ACTIVATING=0
FILES=(Dockerfile .dockerignore package.json package-lock.json server.js lib scripts public README.md LICENSE)
finish() {
  code=$?
  trap - EXIT
  if [ "$NEED_START" = 1 ]; then docker start "$CID" || code=1; fi
  if [ "$code" != 0 ] && [ "$INSTALLING" = 1 ] && [ "$ACTIVATING" = 0 ]; then
    # Restore only runtime source files, never .env/data. Old container still uses its old image.
    for name in "${FILES[@]}"; do
      if [ -f "$BACKUP/previous-source/$name.absent" ]; then
        rm -rf -- "$PROJECT/$name"
      elif [ -e "$BACKUP/previous-source/$name" ]; then
        rm -rf -- "$PROJECT/$name"
        mv -- "$BACKUP/previous-source/$name" "$PROJECT/$name" || true
      fi
    done
  fi
  if [ "$code" != 0 ]; then
    echo "[news] FAILED; keep backup $BACKUP. No database rollback was performed."
    if [ "$ACTIVATING" = 1 ]; then echo '[news] Container activation attempted: inspect compose ps/logs before any retry or rollback.'; fi
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
case "$ACTION" in
backup)
  [ ! -e "$BACKUP" ]
  mkdir -p "$BACKUP"
  chmod 700 "$BACKUP"
  printf '%s\n' "$IMAGE" > "$BACKUP/old-image-id.txt"
  printf '%s\n' "$TARGET" > "$BACKUP/target-image.txt"
  docker tag "$IMAGE" "zonglan-news-rollback:$RUN"
  NEED_START=1
  docker compose stop -t 60 qmreader
  [ "$(docker inspect -f '{{.State.Running}}' "$CID")" = false ]
  tar --exclude=./node_modules --exclude=./.git --exclude=./.news-deploy.lock -czf "$BACKUP/project.tar.gz" .
  (cd "$BACKUP"; sha256sum project.tar.gz > project.sha256; sha256sum -c project.sha256)
  tar -tzf "$BACKUP/project.tar.gz" >/dev/null
  docker start "$CID"
  NEED_START=0
  ready=0
  for attempt in $(seq 1 30); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$CID")" = true ] && curl -fsS --max-time 3 http://127.0.0.1:3088/ >/dev/null; then ready=1; break; fi
    sleep 2
  done
  [ "$ready" = 1 ] || { echo 'Old service did not recover after backup'; exit 1; }
  touch "$BACKUP/backup-complete"
  echo "[news] Backup complete: $BACKUP"
  ;;
release)
  [ -f "$BACKUP/backup-complete" ] && [ ! -e "$BACKUP/activation-attempted" ]
  [ "$IMAGE" = "$(cat "$BACKUP/old-image-id.txt")" ] || { echo 'Running image changed since backup; start a new deployment'; exit 1; }
  [ "$TARGET" = "$(cat "$BACKUP/target-image.txt")" ] || { echo 'Compose image target changed; start a new deployment'; exit 1; }
  (cd "$BACKUP"; sha256sum -c source.sha256)
  mkdir "$BACKUP/source"
  # Reject traversal, links and unknown root entries before extracting the uploaded archive.
  python3 - "$BACKUP/source.tar.gz" <<'PY'
import sys, tarfile, pathlib
allowed = {'Dockerfile','.dockerignore','package.json','package-lock.json','server.js','lib','scripts','public','README.md','LICENSE'}
with tarfile.open(sys.argv[1]) as archive:
    for m in archive:
        p = pathlib.PurePosixPath(m.name)
        if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] not in allowed or not (m.isfile() or m.isdir()):
            raise SystemExit('Unsafe deployment archive')
PY
  tar -xzf "$BACKUP/source.tar.gz" -C "$BACKUP/source"
  NEW="zonglan-news-release:$RUN"
  docker build -t "$NEW" "$BACKUP/source" > "$BACKUP/build.log" 2>&1
  docker image inspect -f '{{.Id}}' "$NEW" > "$BACKUP/new-image-id.txt"
  mkdir "$BACKUP/previous-source"
  INSTALLING=1
  for name in "${FILES[@]}"; do
    if [ -e "$PROJECT/$name" ]; then
      mv -- "$PROJECT/$name" "$BACKUP/previous-source/$name"
    else
      touch "$BACKUP/previous-source/$name.absent"
    fi
    cp -a -- "$BACKUP/source/$name" "$PROJECT/$name"
  done
  docker tag "$NEW" "$TARGET"
  ACTIVATING=1
  touch "$BACKUP/activation-attempted"
  docker compose up -d --no-build qmreader
  ok=0
  for attempt in $(seq 1 30); do
    NEWCID=$(docker compose ps -q qmreader)
    if [ -n "$NEWCID" ] && [ "$(docker inspect -f '{{.Image}}' "$NEWCID")" = "$(cat "$BACKUP/new-image-id.txt")" ] &&
       curl -fsS --max-time 3 http://127.0.0.1:3088/ > /dev/null &&
       curl -fsS --max-time 3 http://127.0.0.1:3088/api/me | python3 -c 'import json,sys; d=json.load(sys.stdin); assert (d.get("user") or {}).get("id")=="zonglan-personal"'; then
      ok=1; break
    fi
    sleep 2
  done
  [ "$ok" = 1 ] || { docker compose logs --tail=30 qmreader; exit 1; }
  printf 'http-and-identity=passed\nmanual-qa=pending\n' > "$BACKUP/result.txt"
  echo '[news] HTTP, personal identity and running image checks passed'
  ;;
*) echo 'Invalid remote action'; exit 2 ;;
esac
