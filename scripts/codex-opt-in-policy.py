#!/usr/bin/env python3
"""Idempotently install the Codex-side Synrex opt-in rule on this host.

Run once on each Codex host; Synrex's coordinator also rejects recognizable
Codex MCP clients by default, independently of this advisory instruction.
"""

import argparse
import os
from pathlib import Path
import shutil
import time

BEGIN = "<!-- synrex-codex-opt-in:begin -->"
END = "<!-- synrex-codex-opt-in:end -->"
OLD = (
    "Codex must not invoke Synrex or its `mcp__codex_apps__synrex_*` tools. "
    "Use native local engineering tools for tasks instead."
)
RULE = (
    f"{BEGIN}\n"
    "Codex must NOT use Synrex, Synrex MCP tools, or Synrex durable-task tools "
    "by default, on this computer or any remote host. A request to use Codex "
    "means native Codex tools only. Do not silently fall back to Synrex.\n"
    "Exception: only when the user explicitly asks to use Synrex for the "
    "current task may Codex attempt Synrex; the Synrex owner must separately "
    "enable Codex MCP client access on the coordinator.\n"
    f"{END}"
)


def desired(current: str) -> str:
    current = current.replace(OLD, "").rstrip()
    if BEGIN in current or END in current:
        if current.count(BEGIN) != 1 or current.count(END) != 1:
            raise ValueError("Malformed Synrex Codex opt-in markers; refusing to overwrite")
        head, tail = current.split(BEGIN, 1)
        _, suffix = tail.split(END, 1)
        current = (head.rstrip() + "\n" + suffix.lstrip()).strip()
    return (current + "\n\n" if current else "") + RULE + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Install the policy with backup")
    parser.add_argument("--path", type=Path, default=Path.home() / ".codex" / "AGENTS.md")
    args = parser.parse_args()
    path = args.path.expanduser()
    old = path.read_text(encoding="utf-8") if path.exists() else ""
    new = desired(old)
    if old == new:
        print(f"OK existing policy: {path}")
        return
    if not args.apply:
        print(f"NEEDS_UPDATE {path} (pass --apply to install)")
        raise SystemExit(1)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup = path.with_name(path.name + f".before-synrex-opt-in-{int(time.time())}")
        shutil.copy2(path, backup)
        print(f"BACKUP {backup}")
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    try:
        temporary.write_text(new, encoding="utf-8")
        if path.exists():
            os.chmod(temporary, path.stat().st_mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"APPLIED {path}")


if __name__ == "__main__":
    main()
