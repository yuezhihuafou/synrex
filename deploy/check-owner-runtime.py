#!/usr/bin/env python3
"""Read-only owner runtime check suitable for a systemd timer.

Never issues tokens, registers clients, restarts services or accesses tasks.
"""
import argparse
import json
import sqlite3
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen


def probe(url: str, expected: int) -> None:
    request = Request(url, headers={"User-Agent": "DevSpace-owner-health/1"})
    with urlopen(request, timeout=9) as response:
        if response.status != expected:
            raise RuntimeError(f"{url}: HTTP {response.status}; expected {expected}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--public-url", required=True)
    parser.add_argument("--port", type=int, default=7676)
    args = parser.parse_args()
    with sqlite3.connect(
        f"file:{args.state_dir / 'devspace.sqlite'}?mode=ro", uri=True
    ) as database:
        if database.execute("pragma quick_check").fetchone()[0] != "ok":
            raise RuntimeError("Authoritative SQLite integrity check failed")
    probe(f"http://127.0.0.1:{args.port}/healthz", 200)
    probe(args.public_url.rstrip("/") + "/.well-known/oauth-authorization-server", 200)
    print(json.dumps({"ownerRuntime": "healthy", "sqlite": "ok", "httpsDiscovery": 200}))


if __name__ == "__main__":
    main()
