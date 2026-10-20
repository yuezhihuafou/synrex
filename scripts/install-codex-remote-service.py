#!/usr/bin/env python3
"""Use the managed Codex release for the persistent Remote services."""
import os
from pathlib import Path
import subprocess
import argparse
parser = argparse.ArgumentParser()
parser.add_argument("--desktop-owner", action="store_true")
arguments = parser.parse_args()
home = Path.home()
binary = home / ".codex/packages/standalone/current/bin/codex"
assert binary.is_file()
if arguments.desktop_owner:
    desktop_file = Path("/usr/share/applications/chatgpt.desktop")
    autostart = home / ".config/autostart/chatgpt.desktop"
    if desktop_file.is_file() and not autostart.exists():
        autostart.parent.mkdir(parents=True, exist_ok=True)
        autostart.write_text(desktop_file.read_text())
for unit in ("codex-remote-control.service", "codex-remote-control-watchdog.service"):
    source = home / ".config/systemd/user" / unit
    if not source.exists():
        continue
    folder = source.with_name(unit + ".d")
    folder.mkdir(parents=True, exist_ok=True)
    command = " app-server daemon start" if arguments.desktop_owner else " remote-control start --json"
    override = "[Service]\nExecStart=\nExecStart=" + str(binary) + command + "\n"
    if unit == "codex-remote-control.service":
        override += "ExecStop=\nExecStop=" + str(binary) + " app-server daemon stop\n"
    target = folder / "50-managed-release.conf"
    target.write_text(override)
subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
subprocess.run(["systemctl", "--user", "reset-failed", "codex-remote-control.service"], check=True)
subprocess.run(["systemctl", "--user", "enable", "--now", "codex-remote-control.service"], check=True)
print("Managed Remote service installed")
