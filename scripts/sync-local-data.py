"""Refresh the ignored local account snapshot after the package has stopped."""
import os
import shutil
import sqlite3
import subprocess
from pathlib import Path

os.umask(0o077)
root = Path(__file__).resolve().parent.parent
source_dir = Path.home() / ".9router"
target_dir = root / "data" / "production"
source_db = source_dir / "db" / "data.sqlite"
target_db = target_dir / "db" / "data.sqlite"


def require_closed(args, message):
    check = subprocess.run(["lsof", *args], capture_output=True, text=True)
    if check.returncode == 0 and check.stdout.strip():
        raise SystemExit(message)
    if check.stderr.strip() or check.returncode not in (0, 1):
        raise SystemExit("Cannot verify router state; refusing to modify account data")


if not source_db.is_file():
    raise SystemExit("Package account database is missing")
require_closed(["-nP", "-iTCP:20128", "-sTCP:LISTEN", "-t"], "Stop the package/local router before synchronizing")
require_closed(["-t", str(source_db)], "Package account database is still open")
if target_db.exists():
    require_closed(["-t", str(target_db)], "Local account database is still open")

# This is a one-time pre-cutover import, not an ongoing two-way synchronization.
marker = target_dir / "snapshot-pending-refresh"
if target_db.exists() and not marker.is_file():
    raise SystemExit("Local import was already finalized; refusing to overwrite possibly rotated local credentials")
ignored = subprocess.run(["git", "-C", str(root), "check-ignore", "--quiet", "data/production/db/data.sqlite"])
tracked = subprocess.run(["git", "-C", str(root), "ls-files", "data/production"], capture_output=True, text=True)
if ignored.returncode != 0 or tracked.returncode != 0 or tracked.stdout.strip():
    raise SystemExit("Account directory must remain ignored and untracked")

(target_dir / "db").mkdir(parents=True, exist_ok=True, mode=0o700)
target_dir.chmod(0o700)
source = sqlite3.connect(source_db.as_uri() + "?mode=ro", uri=True, timeout=15)
source.execute("PRAGMA query_only=ON")
target = sqlite3.connect(str(target_db))
try:
    source.backup(target, pages=512, sleep=0.05)
    if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise SystemExit("Snapshot integrity check failed")
    counts = {table: target.execute("SELECT count(*) FROM " + table).fetchone()[0]
              for table in ("providerConnections", "apiKeys", "settings")}
finally:
    target.close()
    source.close()
target_db.chmod(0o600)
secret = source_dir / "jwt-secret"
if secret.is_file():
    shutil.copy2(secret, target_dir / "jwt-secret")
    (target_dir / "jwt-secret").chmod(0o600)
marker.unlink(missing_ok=True)
print("Local account data refreshed; integrity_check=ok")
print("Record counts:", counts)
print("DATA_DIR:", target_dir)
print("Do not start the package against its old OAuth snapshot after local token rotation")
