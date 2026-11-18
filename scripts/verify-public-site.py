#!/usr/bin/env python3
"""Validate the dependency-free GitHub Pages site; optionally smoke-test Firefox."""

from __future__ import annotations

import argparse
import base64
import http.server
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import threading
import time
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "docs"


class SiteHTML(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: set[str] = set()
        self.anchors: list[str] = []
        self.local_assets: list[str] = []
        self.translation_keys: set[str] = set()
        self.main_count = 0
        self.h1_count = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if "id" in values:
            name = values["id"]
            assert name and name not in self.ids, f"Duplicate or empty ID: {name}"
            self.ids.add(name)
        if "data-i18n" in values:
            assert values["data-i18n"]
            self.translation_keys.add(values["data-i18n"])
        if tag == "main":
            self.main_count += 1
        if tag == "h1":
            self.h1_count += 1
        if tag == "img":
            assert values.get("alt") is not None, "Images need alt text"
        if tag == "a":
            href = values.get("href") or ""
            assert href, "Anchor missing href"
            if href.startswith("#"):
                self.anchors.append(href[1:])
            if values.get("target") == "_blank":
                rel = (values.get("rel") or "").split()
                assert "noopener" in rel, f"External link missing noopener: {href}"
        if tag in ("script", "link"):
            url = values.get("src") or values.get("href") or ""
            if url.startswith("./"):
                self.local_assets.append(url)
        assert not any(key.startswith("on") for key in values), "Avoid inline event handlers"


def static_checks() -> None:
    html = (SITE / "index.html").read_text(encoding="utf-8")
    css = (SITE / "assets/synrex-site.css").read_text(encoding="utf-8")
    js = (SITE / "assets/synrex-site.js").read_text(encoding="utf-8")
    parser = SiteHTML()
    parser.feed(html)
    assert parser.main_count == 1 and parser.h1_count == 1, "Expected one main and one h1"
    assert all(target in parser.ids for target in parser.anchors), "Broken in-page anchor"
    assert all((SITE / asset).is_file() for asset in parser.local_assets), "Missing referenced asset"
    missing = [key for key in parser.translation_keys if f'{key}:' not in js]
    assert not missing, f"Missing Chinese translations: {missing}"
    assert "prefers-reduced-motion" in css, "Missing reduced-motion behavior"
    assert "https://yuezhihuafou.github.io/synrex/" in html, "Missing canonical URL"
    assert "releases/latest" in html, "Release CTA must not point to a stale preview"
    assert "releases/tag/v0.1.0" not in html, "Outdated preview CTA"
    assert "Readme" not in (SITE / "assets/synrex-mark.svg").read_text(), "Unexpected placeholder logo"
    print(f"PASS static site: {len(parser.ids)} IDs, {len(parser.translation_keys)} translations, {len(parser.local_assets)} local assets")


def http_json(base: str, method: str, path: str, data: dict | None = None) -> dict:
    payload = None if data is None else json.dumps(data).encode()
    request = Request(
        base + path, data=payload, method=method,
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def browser_checks(screenshot_dir: Path) -> None:
    driver = shutil.which("geckodriver")
    firefox = shutil.which("firefox")
    assert driver and firefox, "Firefox and geckodriver are required for --browser"
    screenshot_dir.mkdir(parents=True, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *args, **kw: http.server.SimpleHTTPRequestHandler(*args, directory=str(SITE), **kw))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        driver_port = s.getsockname()[1]
    driver_url = f"http://127.0.0.1:{driver_port}"
    process = subprocess.Popen([driver, "--host", "127.0.0.1", "--port", str(driver_port)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    session = ""
    try:
        for attempt in range(50):
            if process.poll() is not None:
                raise RuntimeError(f"geckodriver exited {process.returncode}")
            try:
                with urlopen(driver_url + "/status", timeout=1):
                    break
            except OSError:
                time.sleep(.2)
        result = http_json(driver_url, "POST", "/session", {"capabilities": {"alwaysMatch": {"browserName": "firefox", "moz:firefoxOptions": {"args": ["-headless"]}}}})
        session = result["value"]["sessionId"]

        def command(path: str, data: dict | None = None) -> dict:
            return http_json(driver_url, "POST" if data is not None else "GET", f"/session/{session}{path}", data)["value"]

        page_url = f"http://127.0.0.1:{server.server_port}/"
        for width, height in [(1440, 900), (1024, 768), (768, 900), (390, 844)]:
            command("/window/rect", {"width": width, "height": height})
            command("/url", {"url": page_url})
            time.sleep(.4)
            stats = command("/execute/sync", {"script": """
              return {
                title: document.title,
                width: document.documentElement.clientWidth,
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                h1: document.querySelector('h1').getBoundingClientRect().width,
                lang: document.documentElement.lang,
                assetLoaded: [...document.styleSheets].some(s => s.href && s.href.includes('synrex-site.css'))
              };
            """, "args": []})
            assert stats["overflow"] <= 1, f"Horizontal overflow at {width}: {stats}"
            assert stats["h1"] > 0 and stats["assetLoaded"], f"Layout or stylesheet missing at {width}"
            screenshot = command("/screenshot")
            (screenshot_dir / f"synrex-{width}.png").write_bytes(base64.b64decode(screenshot))
            print(f"PASS Firefox {width}px: overflow={stats['overflow']} lang={stats['lang']}")

        command("/execute/sync", {"script": "document.getElementById('language-switch').click()", "args": []})
        zh = command("/execute/sync", {"script": "return {lang:document.documentElement.lang, title:document.title, heading:document.getElementById('hero-title').innerText}", "args": []})
        assert zh["lang"] == "zh-CN" and "AI 负责思考" in zh["heading"], f"Chinese toggle failed: {zh}"
        command("/execute/sync", {"script": "document.getElementById('language-switch').click()", "args": []})
        en = command("/execute/sync", {"script": "return document.documentElement.lang", "args": []})
        assert en == "en", f"English toggle failed: {en}"
        command("/execute/sync", {"script": "document.getElementById('copy-commands').click()", "args": []})
        time.sleep(.3)
        feedback = command("/execute/sync", {"script": "return document.getElementById('copy-feedback').innerText", "args": []})
        assert feedback, "Copy command must give an accessible success/failure message"
        print(f"PASS Firefox language toggle, quickstart copy feedback: {feedback}")
    finally:
        if session:
            try:
                http_json(driver_url, "DELETE", f"/session/{session}")
            except Exception:
                pass
        process.terminate()
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        server.shutdown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", action="store_true", help="Run actual Firefox/Geckodriver responsive and interaction tests")
    parser.add_argument("--screenshots", type=Path, default=Path("/tmp/synrex-site-screenshots"))
    args = parser.parse_args()
    static_checks()
    if args.browser:
        browser_checks(args.screenshots)
