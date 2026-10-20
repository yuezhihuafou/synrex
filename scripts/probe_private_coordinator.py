#!/usr/bin/env python3
"""Exercise private MCP authentication without accessing existing bearer secrets.

Creates a 90-second synthetic token in the *candidate* SQLite database,
requests initialize and tools/list, then deletes that token even on error.
Does not touch production OAuth or expose the generated token in logs.
"""
import base64
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import time
import urllib.request


def rpc(port, bearer, method, params=None):
    message = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        message["params"] = params
    request = urllib.request.Request(
        "http://127.0.0.1:" + str(port) + "/mcp",
        data=json.dumps(message).encode(),
        headers={
            "Authorization": "Bearer " + bearer,
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        if response.status != 200:
            raise RuntimeError("Unexpected MCP status " + str(response.status))
        body = response.read().decode()
    text = next((line[6:] for line in body.splitlines() if line.startswith("data: ")), body)
    result = json.loads(text)
    if "result" not in result:
        raise RuntimeError("MCP response missing result for " + method)
    return result["result"]


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ("7681", "7676"):
        raise SystemExit("Usage: probe_private_coordinator.py <candidate-state-dir> <7681|7676>")
    port = int(sys.argv[2])
    dbpath = os.path.join(sys.argv[1], "devspace.sqlite")
    db = sqlite3.connect(dbpath, timeout=10)
    token = secrets.token_urlsafe(32)
    digest = base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).rstrip(b"=").decode()
    try:
        client = db.execute("SELECT client_id FROM oauth_clients LIMIT 1").fetchone()
        if not client:
            raise RuntimeError("No OAuth client in candidate")
        db.execute(
            "INSERT INTO oauth_access_tokens"
            " (token_hash,client_id,scopes_json,expires_at,resource) VALUES (?,?,?,?,?)",
            (digest, client[0], json.dumps(["devspace"]), int(time.time()) + 90,
             "https://devspace.yuezhihuafou.dpdns.org/mcp"),
        )
        db.commit()
        rpc(port, token, "initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "private-cutover-test", "version": "1"},
        })
        listing = rpc(port, token, "tools/list")
        tools = {item["name"] for item in listing.get("tools", [])}
        expected = {"open_workspace", "read", "exec_command", "research_harness"}
        if not expected.issubset(tools):
            raise RuntimeError("Private tool inventory missing " + repr(sorted(expected - tools)))
        routed_reads = {}
        routed_commands = {}
        for label, workspace in (("gateway", "ws_bb3eee589b"),
                                 ("swy1", "ws_0ec6c54866dfa95ee99b")):
            result = rpc(port, token, "tools/call", {
                "name": "read",
                "arguments": {"workspaceId": workspace, "path": "AGENTS.md",
                              "offset": 1, "limit": 4},
            })
            if result.get("isError"):
                details = json.dumps(result.get("content", []), ensure_ascii=False)[:480]
                raise RuntimeError("Private route read failed for " + label + ": " + details)
            if not (result.get("structuredContent") or result.get("content")):
                raise RuntimeError("Private route returned no content for " + label)
            routed_reads[label] = "ok"
            command_result = rpc(port, token, "tools/call", {
                "name": "exec_command",
                "arguments": {"workspaceId": workspace, "cmd": "printf peer-route-check",
                              "maxOutputTokens": 100, "yieldTimeMs": 10000},
            })
            if command_result.get("isError"):
                details = json.dumps(command_result.get("content", []), ensure_ascii=False)[:400]
                raise RuntimeError("Private route exec failed for " + label + ": " + details)
            routed_commands[label] = "ok"
        print(json.dumps({"private_authenticated_mcp": True,
                          "advertised_tool_count": len(tools),
                          "expected_tools_present": True,
                          "routed_reads": routed_reads,
                          "routed_exec_commands": routed_commands,
                          "ephemeral_token_deleted": True}))
    finally:
        db.execute("DELETE FROM oauth_access_tokens WHERE token_hash=?", (digest,))
        db.commit()
        db.close()


if __name__ == "__main__":
    main()
