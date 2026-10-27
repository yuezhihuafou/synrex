import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { databasePath, openDatabase } from "./client.js";

const root = await mkdtemp(join(tmpdir(), "synrex-migration-test-"));

try {
  testLegacyWindowsMigrationCanonicalization(join(root, "legacy-windows"));
  testMalformedLegacyHistoryFailsClosed(join(root, "malformed-legacy"));
} finally {
  await rm(root, { recursive: true, force: true });
}

function testLegacyWindowsMigrationCanonicalization(stateDir: string): void {
  createLegacyWindowsDatabase(stateDir, { includeLegacyTables: true });

  const upgraded = openDatabase(stateDir);
  try {
    const migrations = upgraded.sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all();
    assert.deepEqual(migrations, [
      { version: 1, name: "workspace-state" },
      { version: 2, name: "oauth-state" },
      { version: 3, name: "local-agent-sessions" },
      { version: 4, name: "workspace-conversation-bindings" },
      { version: 5, name: "local-agent-structured-errors" },
      { version: 6, name: "local-agent-effort-rename" },
      { version: 7, name: "workspace-recovery-state" },
      { version: 8, name: "local-agent-turns" },
      { version: 9, name: "workflow-sessions" },
    ]);

    const synrex = upgraded.sqlite
      .prepare("select version, name from synrex_schema_migrations order by version")
      .all();
    assert.deepEqual(synrex, [
      { version: 8, name: "learning-memory" },
      { version: 9, name: "multi-node-control-plane" },
      { version: 10, name: "oauth-authorization-codes" },
      { version: 11, name: "oauth-refresh-replay-recovery" },
    ]);
    assert.equal(
      upgraded.sqlite.prepare("select count(*) from workflow_sessions").pluck().get(),
      1,
    );
    for (const table of [
      "local_agent_turns",
      "workflow_sessions",
      "learning_episodes",
      "learning_candidates",
      "execution_nodes",
      "workspace_routes",
      "task_routes",
      "oauth_authorization_codes",
      "oauth_refresh_replays",
    ]) {
      assert.ok(
        upgraded.sqlite
          .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
          .get(table),
        `${table} must exist after legacy migration canonicalization`,
      );
    }
  } finally {
    upgraded.close();
  }

  const reopened = openDatabase(stateDir);
  try {
    assert.equal(
      reopened.sqlite.prepare("select count(*) from synrex_schema_migrations").pluck().get(),
      4,
    );
    assert.equal(
      reopened.sqlite.prepare("select count(*) from workflow_sessions").pluck().get(),
      1,
    );
  } finally {
    reopened.close();
  }
}

function testMalformedLegacyHistoryFailsClosed(stateDir: string): void {
  createLegacyWindowsDatabase(stateDir, { includeLegacyTables: false });
  assert.throws(
    () => openDatabase(stateDir),
    /legacy version 8 \("local-agent-turns"\) is recorded, but table "local_agent_turns" is missing/,
  );
}

function createLegacyWindowsDatabase(
  stateDir: string,
  { includeLegacyTables }: { includeLegacyTables: boolean },
): void {
  const current = openDatabase(stateDir);
  current.close();

  const sqlite = new Database(databasePath(stateDir));
  try {
    sqlite.pragma("foreign_keys = OFF");
    const seed = sqlite.transaction(() => {
      sqlite.exec(`
        drop table if exists oauth_refresh_replays;
        drop table if exists oauth_authorization_codes;
        drop table if exists task_routes;
        drop table if exists workspace_routes;
        drop table if exists execution_nodes;
        drop table if exists learning_candidates;
        drop table if exists learning_episodes;
        delete from devspace_schema_migrations where version >= 8;
      `);

      if (includeLegacyTables) {
        sqlite.exec(`
          create table local_agent_turns (
            id integer primary key autoincrement,
            agent_id text not null,
            prompt text not null,
            status text not null,
            response text,
            error text,
            error_code text,
            error_retryable text,
            created_at text not null,
            completed_at text,
            foreign key (agent_id) references local_agent_sessions(id) on delete cascade
          );
          create index local_agent_turns_agent_id_idx
            on local_agent_turns(agent_id, id desc);
          create index local_agent_turns_status_idx
            on local_agent_turns(status);

          create table workflow_sessions (
            id text primary key,
            workspace_session_id text not null,
            workspace_root text not null,
            workspace_mode text not null,
            source_root text,
            base_ref text,
            base_sha text,
            managed_worktree text not null default 'false',
            task_intent text not null,
            status text not null default 'active',
            validation_json text not null default '[]',
            review_ref text,
            handoff_summary text,
            created_at text not null,
            updated_at text not null,
            completed_at text
          );
          create index workflow_sessions_workspace_root_idx
            on workflow_sessions(workspace_root, updated_at desc);
          create index workflow_sessions_status_idx
            on workflow_sessions(status, updated_at desc);
          insert into workflow_sessions (
            id, workspace_session_id, workspace_root, workspace_mode,
            task_intent, status, validation_json, created_at, updated_at
          ) values (
            'wf_legacy', 'ws_legacy', 'C:\\legacy', 'checkout',
            'preserve legacy workflow evidence', 'completed', '[]',
            '2026-10-17T00:00:00.000Z', '2026-10-17T00:00:01.000Z'
          );
        `);
      }

      const record = sqlite.prepare(
        "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
      );
      record.run(8, "local-agent-turns", "2026-10-17T00:00:00.000Z");
      record.run(9, "workflow-sessions", "2026-10-17T00:00:01.000Z");
    });
    seed.immediate();
  } finally {
    sqlite.close();
  }
}
