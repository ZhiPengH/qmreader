#!/bin/bash
# Run on Mac. No Git writes; deploy the current working tree, including uncommitted files.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ACTION=${1:-help}
case "$ACTION" in
  check|deploy) ;;
  *) echo 'Usage: bash ops/news/deploy.sh check|deploy'; exit 0 ;;
esac
cd "$ROOT"
for tool in ssh scp python3 npm git; do command -v "$tool" >/dev/null; done
RUN="$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets; print(secrets.token_hex(3))')"
LOCAL="$ROOT/.news-deploy/$RUN"
mkdir -p "$LOCAL"
chmod 700 "$ROOT/.news-deploy" "$LOCAL"
LOG="$LOCAL/deploy.log"
umask 077
trap 'echo "[news] Failed. Full log: $LOG"' ERR
step() { echo "[news] $*"; }
remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 linux bash -s -- "$@" < ops/news/remote.sh >> "$LOG" 2>&1; }
step 'Checking local tests'
npm test >> "$LOG" 2>&1
python3 - "$ROOT" "$LOCAL" <<'PY'
import hashlib, json, pathlib, subprocess, sys, tarfile
root, dest = map(pathlib.Path, sys.argv[1:])
paths = ['Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'server.js', 'lib', 'scripts', 'public', 'README.md', 'LICENSE']
for name in paths:
    p = root / name
    if not p.exists(): raise SystemExit(f'Missing deployment input: {name}')
    for item in [p, *(p.rglob('*') if p.is_dir() else [])]:
        if item.is_symlink(): raise SystemExit(f'Symlink not allowed in deployment inputs: {item}')
with tarfile.open(dest / 'source.tar.gz', 'w:gz') as archive:
    for name in paths: archive.add(root / name, arcname=name)
digest = hashlib.sha256((dest / 'source.tar.gz').read_bytes()).hexdigest()
(dest / 'source.sha256').write_text(f'{digest}  source.tar.gz\n')
def git(*args): return subprocess.check_output(['git', *args], cwd=root, text=True).strip()
(dest / 'release.json').write_text(json.dumps({'head':git('rev-parse','HEAD'), 'branch':git('branch','--show-current'), 'working_tree_status':git('status','--porcelain'), 'source_sha256':digest, 'manual_qa':'pending', 'commit':'not performed'}, ensure_ascii=False, indent=2)+'\n')
PY
step 'Checking Linux prerequisites (read only)'
remote check "$RUN"
if [ "$ACTION" = check ]; then
  step "Checks passed; no remote changes. Snapshot: $LOCAL"
  exit 0
fi
step 'Backing up Linux; old service resumes immediately after snapshot'
remote backup "$RUN"
REMOTE="/home/cosiohzp/apps/zonglan-news-backups/$RUN"
step 'Uploading source snapshot using SCP (no .env or data)'
scp -q "$LOCAL/source.tar.gz" "$LOCAL/source.sha256" "$LOCAL/release.json" "linux:$REMOTE/" >> "$LOG" 2>&1
step 'Building image, installing sources, recreating container and checking HTTP'
remote release "$RUN"
step "Deployment checks passed. Backup: $REMOTE"
step "Log: $LOG"
step 'Manual QA pending: Hermes/iPhone read, star, unstar, refresh. No Git commit or push performed.'
