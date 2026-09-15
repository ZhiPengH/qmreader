"""Bounded remote.sh regression tests; never contact SSH or a real Docker daemon.

Activation failures intentionally preserve current data without automatic rollback:
startup may already have migrated the database. These mocks do not prove runtime
Docker, SQLite compatibility, network recovery, or manual UI acceptance.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


RUN = "20260915T120000Z-abcdef"
FILES = ("Dockerfile", ".dockerignore", "package.json", "package-lock.json",
         "server.js", "lib", "scripts", "public", "README.md", "LICENSE")
MOCK = r'''
import hashlib, json, os, pathlib, subprocess, sys
tool = pathlib.Path(sys.argv[0]).name
a = sys.argv[1:]
statefile = pathlib.Path(os.environ['MOCK_STATE'])
s = json.loads(statefile.read_text())
failure = os.environ.get('FAIL', '')
with open(os.environ['MOCK_CALLS'], 'a') as log:
    log.write(json.dumps([tool, *a]) + '\n')
def save(): statefile.write_text(json.dumps(s))
def die(): sys.exit(19)
if tool in ('ssh', 'scp'): raise RuntimeError('Network tools forbidden')
if tool == 'sleep': sys.exit(0)
if tool == 'flock': sys.exit(0)
if tool == 'tar':
    if failure == 'backup' and '-czf' in a: die()
    sys.exit(subprocess.call([os.environ['REAL_TAR'], *a]))
if tool == 'sha256sum':
    if a[0] == '-c':
        for line in pathlib.Path(a[1]).read_text().splitlines():
            digest, filename = line.split(None, 1)
            if hashlib.sha256(pathlib.Path(filename.strip()).read_bytes()).hexdigest() != digest: die()
    else:
        print(hashlib.sha256(pathlib.Path(a[0]).read_bytes()).hexdigest() + '  ' + a[0])
    sys.exit(0)
if tool == 'curl':
    if not s['running'] or (failure == 'health' and s['image'] == 'sha256:new'): die()
    print(json.dumps({'user': {'id': 'zonglan-personal'}}) if a[-1].endswith('/api/me') else 'ok')
    sys.exit(0)
if tool != 'docker': raise RuntimeError(tool)
if a[:2] == ['compose', 'version']: print('mock compose'); sys.exit(0)
if a[:2] == ['compose', 'config']:
    if '--services' in a: print('qmreader')
    elif '--images' in a: print('zonglan-news-qmreader')
    elif '--quiet' not in a: raise RuntimeError(a)
elif a[:2] == ['compose', 'ps']: print('container') if s['running'] else None
elif a[:2] == ['compose', 'stop']: s['running'] = False; save()
elif a[0] == 'start': s['running'] = True; save()
elif a[0] == 'inspect':
    if '-f' in a:
        print(str(s['running']).lower() if 'Running' in a[2] else s['image'])
    else:
        print(json.dumps([{'Mounts': [{'Source': os.environ['PROJECT'] + '/data', 'Destination': '/app/data', 'RW': True}], 'HostConfig': {'PortBindings': {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '3088'}]}}}]))
elif a[0] == 'tag': s['tags'][a[2]] = s['tags'].get(a[1], a[1]); save()
elif a[0] == 'build':
    if failure == 'build': die()
    s['tags'][a[2]] = 'sha256:new'; save()
elif a[:2] == ['image', 'inspect']: print(s['tags'][a[-1]])
elif a[:2] == ['compose', 'up']:
    s['running'] = False; save()
    if failure == 'activation': die()
    s['image'] = s['tags']['zonglan-news-qmreader']; s['running'] = True; save()
elif a[:2] == ['compose', 'logs']: print('mock container failure')
else: raise RuntimeError('Unexpected docker command: ' + repr(a))
'''


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="news-deploy-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.project = self.root / "zonglan-news"
        self.project.mkdir()
        self.backup = self.root / "zonglan-news-backups" / RUN
        self.make_sources(self.project, "old")
        (self.project / "lib/stale.js").write_text("old stale module")
        (self.project / ".env").write_text("SECRET=fixture-only\n")
        (self.project / "docker-compose.yml").write_text("fixture compose\n")
        (self.project / "data").mkdir()
        for name in ("qmreader.sqlite", "qmreader.sqlite-wal", "cache.json"):
            (self.project / "data" / name).write_bytes(b"preserve:" + name.encode())
        self.before = self.snapshot()
        self.statefile = self.root / "state.json"
        self.statefile.write_text(json.dumps({"running": True, "image": "sha256:old",
                                            "tags": {"zonglan-news-qmreader": "sha256:old"}}))
        binpath = self.root / "bin"
        binpath.mkdir()
        for name in ("docker", "curl", "flock", "sha256sum", "tar", "sleep", "ssh", "scp"):
            p = binpath / name
            p.write_text("#!" + sys.executable + "\n" + MOCK)
            p.chmod(0o700)
        self.env = dict(os.environ, PATH=str(binpath) + os.pathsep + os.environ["PATH"],
                        MOCK_STATE=str(self.statefile), MOCK_CALLS=str(self.root / "calls"),
                        PROJECT=str(self.project), REAL_TAR=shutil.which("tar"), FAIL="")
        self.script = self.root / "remote.sh"
        source = Path(__file__).with_name("remote.sh").read_text()
        source = source.replace("/home/cosiohzp/apps", str(self.root))
        self.assertNotIn("/home/cosiohzp/apps", source)
        self.script.write_text(source)

    @staticmethod
    def make_sources(root, version):
        for name in FILES:
            p = root / name
            if name in ("lib", "scripts", "public"):
                p.mkdir()
                (p / "main.js").write_text(version)
            else:
                p.write_text(version)

    def snapshot(self):
        return {str(p.relative_to(self.project)): p.read_bytes()
                for p in self.project.rglob("*") if p.is_file() and p.name != ".news-deploy.lock"}

    def state(self):
        return json.loads(self.statefile.read_text())

    def invoke(self, action, failure=""):
        return subprocess.run(["/bin/bash", str(self.script), action, RUN],
                              env=dict(self.env, FAIL=failure), capture_output=True,
                              text=True, timeout=30)

    def backup_ok(self):
        result = self.invoke("backup")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((self.backup / "backup-complete").exists())

    def upload(self):
        source = self.root / "upload"
        source.mkdir()
        self.make_sources(source, "new")
        archive = self.backup / "source.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for name in FILES:
                tar.add(source / name, arcname=name)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        (self.backup / "source.sha256").write_text(digest + "  source.tar.gz\n")

    def assert_data_preserved(self):
        now = self.snapshot()
        for name, value in self.before.items():
            if name.startswith("data/") or name in (".env", "docker-compose.yml"):
                self.assertEqual(now[name], value, name)

    def test_backup_success_contains_env_and_all_data(self):
        self.backup_ok()
        self.assertEqual(self.snapshot(), self.before)
        self.assertTrue(self.state()["running"])
        with tarfile.open(self.backup / "project.tar.gz") as tar:
            for name in (".env", "data/qmreader.sqlite", "data/qmreader.sqlite-wal", "data/cache.json"):
                self.assertEqual(tar.extractfile("./" + name).read(), self.before[name])

    def test_backup_failure_restarts_old_container(self):
        result = self.invoke("backup", "backup")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(self.state()["running"])
        self.assertEqual(self.state()["image"], "sha256:old")
        self.assertEqual(self.snapshot(), self.before)
        self.assertFalse((self.backup / "backup-complete").exists())

    def test_checksum_failure_leaves_old_deployment_unchanged(self):
        self.backup_ok()
        self.upload()
        (self.backup / "source.tar.gz").write_bytes(b"damaged upload")
        self.assert_old_after_failed_release()

    def test_build_failure_leaves_old_deployment_unchanged(self):
        self.backup_ok()
        self.upload()
        self.assert_old_after_failed_release("build")

    def assert_old_after_failed_release(self, failure=""):
        result = self.invoke("release", failure)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), self.before)
        self.assertTrue(self.state()["running"])
        self.assertEqual(self.state()["image"], "sha256:old")
        self.assertEqual(self.state()["tags"]["zonglan-news-qmreader"], "sha256:old")
        self.assertFalse((self.backup / "activation-attempted").exists())

    def test_success_replaces_source_removes_stale_modules_and_checks_identity(self):
        self.backup_ok()
        self.upload()
        result = self.invoke("release")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.project / "server.js").read_text(), "new")
        self.assertEqual((self.project / "lib/main.js").read_text(), "new")
        self.assertFalse((self.project / "lib/stale.js").exists())
        self.assert_data_preserved()
        self.assertEqual(self.state()["image"], "sha256:new")
        self.assertTrue(self.state()["running"])
        self.assertIn("manual-qa=pending", (self.backup / "result.txt").read_text())
        self.assertIn("/api/me", (self.root / "calls").read_text())

    def test_activation_failure_preserves_data_and_backup_without_rollback(self):
        self.assert_activation_failure("activation")

    def test_health_failure_preserves_data_and_backup_without_rollback(self):
        self.assert_activation_failure("health")

    def assert_activation_failure(self, failure):
        self.backup_ok()
        self.upload()
        result = self.invoke("release", failure)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No database rollback was performed", result.stdout)
        self.assertIn("Container activation attempted", result.stdout)
        self.assert_data_preserved()
        self.assertTrue((self.backup / "project.tar.gz").exists())
        self.assertTrue((self.backup / "activation-attempted").exists())
        self.assertFalse((self.backup / "result.txt").exists())
        self.assertEqual(self.state()["tags"]["zonglan-news-qmreader"], "sha256:new")
        if failure == "activation":
            self.assertFalse(self.state()["running"])
        else:
            self.assertEqual(self.state()["image"], "sha256:new")


if __name__ == "__main__":
    unittest.main(verbosity=2)
