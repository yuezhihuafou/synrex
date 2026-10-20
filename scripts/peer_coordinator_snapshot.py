#!/usr/bin/env python3
"""Prepare a private peer-coordinator database from a consistent live snapshot.

This script never edits the input databases or the running DevSpace service.
Existing gateway conversation bindings remain authoritative. Collisions are
recorded but not overwritten; a candidate with unresolved collisions cannot
be approved for public cutover.
"""
import argparse
import hashlib
import json
import os
import sqlite3
from pathlib import Path


def connect_ro(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def rows_by_key(db, table, keys):
    columns = [entry[1] for entry in db.execute(f'PRAGMA table_info("{table}")')]
    rows = {
        tuple(row[columns.index(key)] for key in keys): row
        for row in db.execute(f'SELECT * FROM "{table}"')
    }
    return columns, rows


def merge_table(dst, source, table, keys, report, label):
    target_columns, target = rows_by_key(dst, table, keys)
    source_columns, incoming = rows_by_key(source, table, keys)
    if source_columns != target_columns:
        raise RuntimeError(f"Schema mismatch for {table} in {label}")
    conflicts = []
    added = 0
    for key, values in incoming.items():
        previous = target.get(key)
        if previous is not None:
            # Session metadata timestamps/status may change independently.
            # A stable session ID may never silently move to a different root.
            # A conversation binding may never silently point to another ID.
            important = ("root",) if table == "workspace_sessions" else ("workspace_session_id",)
            if any(previous[target_columns.index(col)] != values[target_columns.index(col)] for col in important):
                marker = hashlib.sha256(repr(key).encode()).hexdigest()[:14]
                conflicts.append(marker)
            continue
        placeholders = ",".join("?" for _ in values)
        dst.execute(f'INSERT INTO "{table}" VALUES ({placeholders})', values)
        target[key] = values
        added += 1
    report[label][table] = {
        "added": added,
        "semantic_conflict_count": len(conflicts),
        "key_fingerprints": conflicts[:30],
    }


def prepare(args):
    for source in [args.authority, args.previous, args.local]:
        if not source.is_file():
            raise RuntimeError(f"Input does not exist: {source}")
        if source.resolve() == args.output.resolve():
            raise RuntimeError("Output must be separate from all sources")
    if args.output.exists():
        raise RuntimeError("Refusing to replace an existing candidate")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(args.output.parent, 0o700)
    report = {"merges": {}, "safety": {}, "counts": {}}
    source = connect_ro(args.authority)
    dst = sqlite3.connect(args.output)
    try:
        os.chmod(args.output, 0o600)
        source.backup(dst)
        dst.execute("PRAGMA foreign_keys=ON")
        for label, pathname in (("previous", args.previous), ("local", args.local)):
            with connect_ro(pathname) as peer:
                report["merges"][label] = {}
                for table, keys in (
                    ("workspace_sessions", ("id",)),
                    ("workspace_conversation_bindings", ("conversation_scope_id", "target_key")),
                ):
                    merge_table(dst, peer, table, keys, report["merges"], label)
        # Only stored relative viewpoint changes, no change to stable node ID.
        local_id = list(dst.execute("SELECT id FROM execution_nodes WHERE alias='swy1'"))
        gateway_id = list(dst.execute("SELECT id FROM execution_nodes WHERE alias='gateway'"))
        if len(local_id) != 1 or len(gateway_id) != 1:
            raise RuntimeError("Expected exactly one existing swy1 and gateway node")
        dst.execute("UPDATE execution_nodes SET kind='remote' WHERE id=?", (gateway_id[0][0],))
        dst.execute("UPDATE execution_nodes SET kind='local' WHERE id=?", (local_id[0][0],))
        owners = list(dst.execute("SELECT alias,kind FROM execution_nodes WHERE kind='local'"))
        if owners != [("swy1", "local")]:
            raise RuntimeError(f"Incorrect local node viewpoint: {owners}")
        protected = (
            "oauth_clients", "oauth_access_tokens", "oauth_refresh_tokens",
            "oauth_authorization_codes", "workspace_routes", "task_routes",
        )
        for table in protected:
            def digest(db):
                return hashlib.sha256(repr(sorted(db.execute(f'SELECT * FROM "{table}"'))).encode()).hexdigest()
            if digest(source) != digest(dst):
                raise RuntimeError(f"Protected table unexpectedly altered: {table}")
            report["counts"][table] = dst.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        report["counts"]["workspace_sessions"] = dst.execute("SELECT count(*) FROM workspace_sessions").fetchone()[0]
        report["counts"]["workspace_conversation_bindings"] = dst.execute("SELECT count(*) FROM workspace_conversation_bindings").fetchone()[0]
        violations = list(dst.execute("PRAGMA foreign_key_check"))
        if violations:
            raise RuntimeError(f"Foreign-key violations after merge: {len(violations)}")
        if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite integrity check failed")
        report["safety"]["protected_tables_exact"] = True
        report["safety"]["foreign_keys_ok"] = True
        report["safety"]["sqlite_integrity_ok"] = True
        report["safety"]["conflicts"] = sum(
            value["semantic_conflict_count"]
            for scope in report["merges"].values() for value in scope.values()
        )
        report["safety"]["eligible_for_public_cutover"] = report["safety"]["conflicts"] == 0
        dst.commit()
        return report
    except BaseException:
        dst.close()
        source.close()
        args.output.unlink(missing_ok=True)
        raise
    finally:
        try:
            dst.close()
            source.close()
        except Exception:
            pass


def prepare_owner_isolated(args):
    """Authoritative directory data + local *execution-owner* state.

    Local workspace sessions and conversation bindings are not coordinator
    indices. They must belong to the node running the server. Importing all
    remote nodes' sessions causes identical conversation keys to collide.
    The owner of the original gateway local sessions remains gateway, and
    global workspace/task routes still point to that peer after promotion.
    """
    if args.output.exists():
        raise RuntimeError("Refusing to replace an existing candidate")
    if args.output.resolve() in {args.authority.resolve(), args.local.resolve()}:
        raise RuntimeError("Output cannot overwrite input")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(args.output.parent, 0o700)
    authority = connect_ro(args.authority)
    owner = connect_ro(args.local)
    candidate = sqlite3.connect(args.output)
    try:
        os.chmod(args.output, 0o600)
        authority.backup(candidate)
        # Only two FK-bound tables reference local sessions; preserve all
        # unrelated records exactly as in the authoritative snapshot.
        for table in ("loaded_agent_files", "workspace_conversation_bindings", "workspace_sessions"):
            candidate.execute(f'DELETE FROM "{table}"')
        for table in ("workspace_sessions", "workspace_conversation_bindings", "loaded_agent_files"):
            old_cols, _ = rows_by_key(candidate, table,
                ("id",) if table == "workspace_sessions"
                else ("workspace_session_id", "path") if table == "loaded_agent_files"
                else ("conversation_scope_id", "target_key"))
            new_cols = [x[1] for x in owner.execute(f'PRAGMA table_info("{table}")')]
            if old_cols != new_cols:
                raise RuntimeError(f"Execution schema mismatch: {table}")
            fields = ",".join("?" for _ in old_cols)
            for row in owner.execute(f'SELECT * FROM "{table}"'):
                candidate.execute(f'INSERT INTO "{table}" VALUES ({fields})', row)

        local_ids = list(candidate.execute("SELECT id FROM execution_nodes WHERE alias='swy1'"))
        gateway_ids = list(candidate.execute("SELECT id FROM execution_nodes WHERE alias='gateway'"))
        if len(local_ids) != 1 or len(gateway_ids) != 1:
            raise RuntimeError("Required stable node identities are absent or ambiguous")
        candidate.execute("UPDATE execution_nodes SET kind='remote' WHERE kind='local'")
        candidate.execute("UPDATE execution_nodes SET kind='local' WHERE id=?", (local_ids[0][0],))
        critical = ("oauth_clients", "oauth_access_tokens", "oauth_refresh_tokens",
                    "oauth_authorization_codes", "workspace_routes", "task_routes")
        for table in critical:
            left = set(authority.execute(f'SELECT * FROM "{table}"'))
            right = set(candidate.execute(f'SELECT * FROM "{table}"'))
            if left != right:
                raise RuntimeError(f"Protected global state changed: {table}")
        ids = {row[0] for row in candidate.execute("SELECT id FROM workspace_sessions")}
        local_routes = list(candidate.execute(
            "SELECT local_workspace_id FROM workspace_routes WHERE node_id=?", (local_ids[0][0],)))
        if any(row[0] not in ids for row in local_routes):
            raise RuntimeError("A local swy1 route does not resolve in swy1 execution store")
        foreign_keys = candidate.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_keys:
            raise RuntimeError(f"Foreign-key violations: {len(foreign_keys)}")
        if candidate.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Candidate integrity check failed")
        result = {
            "ownership_model": "global indices from gateway, local execution from swy1",
            "global_protected_tables_identical": True,
            "local_routes_verified": len(local_routes),
            "local_workspace_sessions": len(ids),
            "local_conversation_bindings": candidate.execute(
                "SELECT count(*) FROM workspace_conversation_bindings").fetchone()[0],
            "oauth_access_token_records": candidate.execute(
                "SELECT count(*) FROM oauth_access_tokens").fetchone()[0],
            "global_workspace_routes": candidate.execute(
                "SELECT count(*) FROM workspace_routes").fetchone()[0],
            "global_task_routes": candidate.execute(
                "SELECT count(*) FROM task_routes").fetchone()[0],
            "foreign_keys_ok": True,
            "integrity_ok": True,
            "ready_for_public_cutover": False,
            "pending": [
                "refresh against final frozen production authority",
                "authenticate existing GPT OAuth credential against candidate",
                "re-enroll gateway and Windows as peers before public ingress cutover",
                "verify zero split-brain and tested rollback",
            ],
        }
        candidate.commit()
        return result
    except BaseException:
        candidate.close()
        authority.close()
        owner.close()
        args.output.unlink(missing_ok=True)
        raise
    finally:
        try:
            candidate.close()
            authority.close()
            owner.close()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser()
    for name in ("authority", "previous", "local", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--owner-isolated", action="store_true",
                        help="Keep global authority, replace local runtime sessions with swy1's")
    args = parser.parse_args()
    result = prepare_owner_isolated(args) if args.owner_isolated else prepare(args)
    if args.report.exists():
        raise RuntimeError("Refusing to overwrite an existing report")
    args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8")
    os.chmod(args.report, 0o600)
    if args.owner_isolated:
        print(json.dumps(result, ensure_ascii=False))
        return
    print(json.dumps({
        "counts": result["counts"],
        "safety": result["safety"],
        "per_source": {
            key: {table: {"added": values["added"], "conflicts": values["semantic_conflict_count"]}
                  for table, values in info.items()}
            for key, info in result["merges"].items()
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
