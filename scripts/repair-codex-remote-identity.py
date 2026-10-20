#!/usr/bin/env python3
"""Split a cloned Codex Remote identity, preserving login and session data."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import uuid

root = Path.home() / ".codex"
identity = root / "installation_id"
global_state = root / ".codex-global-state.json"
database = root / "state_5.sqlite"
auth = root / "auth.json"
old_id = identity.read_text().strip()
state = json.loads(global_state.read_text())
assert state.get("electron-local-remote-control-installation-id") == old_id
assert old_id == "8697190e-3c7d-4ee2-8cc8-adcbc13b3485", "Identity already changed; refusing another reset"
auth_hash = hashlib.sha256(auth.read_bytes()).hexdigest()
backup = root / "backups" / ("remote-identity-" + time.strftime("%Y%m%d-%H%M%S"))
backup.mkdir(parents=True, mode=0o700)
for source in (identity, global_state):
    target = backup / source.name
    target.write_bytes(source.read_bytes())
    target.chmod(0o600)
connection = sqlite3.connect(database, timeout=15)
with sqlite3.connect(backup / database.name) as saved:
    connection.backup(saved)
(backup / database.name).chmod(0o600)
new_id = str(uuid.uuid4())
state["electron-local-remote-control-installation-id"] = new_id
state.pop("electron-local-remote-control-environment-id", None)
def atomic_write(target, data):
    temporary = target.with_name(target.name + ".remote-repair-tmp")
    with open(temporary, "w") as handle:
        os.chmod(temporary, 0o600)
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
with connection:
    # Only cloned Remote enrollment metadata is reset. Sessions/auth are untouched.
    connection.execute("DELETE FROM remote_control_enrollments")
    atomic_write(identity, new_id + "\n")
    atomic_write(global_state, json.dumps(state, ensure_ascii=False, separators=(",", ":")) + "\n")
connection.close()
assert hashlib.sha256(auth.read_bytes()).hexdigest() == auth_hash
print(json.dumps({"oldInstallationId": old_id, "newInstallationId": new_id,
                  "loginUnchanged": True, "backup": str(backup)}))
