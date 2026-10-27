import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

interface AppliedMigration {
  version: number;
  name: string;
  applied_at: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "workspace-conversation-bindings",
    up: migrateWorkspaceConversationBindings,
  },
  {
    version: 5,
    name: "local-agent-structured-errors",
    up: migrateLocalAgentStructuredErrors,
  },
  {
    version: 6,
    name: "local-agent-effort-rename",
    up: migrateLocalAgentEffortRename,
  },
  {
    version: 7,
    name: "workspace-recovery-state",
    up: migrateWorkspaceRecoveryState,
  },
  {
    version: 8,
    name: "learning-memory",
    up: migrateLearningMemory,
  },
  {
    version: 9,
    name: "multi-node-control-plane",
    up: migrateMultiNodeControlPlane,
  },
  {
    version: 10,
    name: "oauth-authorization-codes",
    up: migrateOAuthAuthorizationCodes,
  },
  {
    version: 11,
    name: "oauth-refresh-replay-recovery",
    up: migrateOAuthRefreshReplayRecovery,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const appliedRows = readMigrationRows(sqlite, "devspace_schema_migrations");
    if (usesLegacyWindowsLineage(appliedRows)) {
      migrateLegacyWindowsLineage(sqlite, appliedRows);
      return;
    }
    applyMigrationPlan(sqlite, "devspace_schema_migrations", migrations, appliedRows);
  });

  migrate.immediate();
}

function usesLegacyWindowsLineage(appliedRows: AppliedMigration[]): boolean {
  const byVersion = new Map(appliedRows.map((row) => [row.version, row]));
  const version8 = byVersion.get(8);
  const version9 = byVersion.get(9);
  return version8?.name === "local-agent-turns" || version9?.name === "workflow-sessions";
}

function migrateLegacyWindowsLineage(
  sqlite: Database.Database,
  appliedRows: AppliedMigration[],
): void {
  const byVersion = new Map(appliedRows.map((row) => [row.version, row]));
  const version8 = byVersion.get(8);
  const version9 = byVersion.get(9);
  const hasLegacyVersion8 = version8?.name === "local-agent-turns";
  const hasLegacyVersion9 = version9?.name === "workflow-sessions";

  if (!hasLegacyVersion8 || (version9 && !hasLegacyVersion9)) {
    throw new Error(
      "Database migration history is incompatible: mixed legacy/current migration lineage at versions 8-9.",
    );
  }
  const laterRows = appliedRows.filter((row) => row.version >= 10);
  if (laterRows.length > 0) {
    throw new Error(
      "Database migration history is incompatible: legacy versions 8-9 cannot be combined with migrations version 10 or newer.",
    );
  }

  const baseMigrations = migrations.filter((migration) => migration.version <= 7);
  const baseRows = appliedRows.filter((row) => row.version <= 7);
  applyMigrationPlan(sqlite, "devspace_schema_migrations", baseMigrations, baseRows);

  assertLegacyMigrationTable(sqlite, "local_agent_turns", 8, "local-agent-turns");
  if (hasLegacyVersion9) {
    assertLegacyMigrationTable(sqlite, "workflow_sessions", 9, "workflow-sessions");
  }

  sqlite.exec(`
    create table if not exists synrex_schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
  `);
  const synrexMigrations = migrations.filter((migration) => migration.version >= 8);
  const synrexRows = readMigrationRows(sqlite, "synrex_schema_migrations");
  applyMigrationPlan(sqlite, "synrex_schema_migrations", synrexMigrations, synrexRows);
}

function readMigrationRows(
  sqlite: Database.Database,
  table: "devspace_schema_migrations" | "synrex_schema_migrations",
): AppliedMigration[] {
  return sqlite
    .prepare(`select version, name, applied_at from ${table} order by version`)
    .all() as AppliedMigration[];
}

function applyMigrationPlan(
  sqlite: Database.Database,
  table: "devspace_schema_migrations" | "synrex_schema_migrations",
  plan: Migration[],
  appliedRows: AppliedMigration[],
): void {
  const migrationsByVersion = new Map(plan.map((migration) => [migration.version, migration]));
  for (const row of appliedRows) {
    const expected = migrationsByVersion.get(row.version);
    if (!expected) {
      throw new Error(
        `Database migration history is incompatible: version ${row.version} (${JSON.stringify(row.name)}) is unknown to this build.`,
      );
    }
    if (row.name !== expected.name) {
      throw new Error(
        `Database migration history is incompatible: version ${row.version} is recorded as ${JSON.stringify(row.name)}, but this build expects ${JSON.stringify(expected.name)}.`,
      );
    }
  }

  const applied = new Set(appliedRows.map((row) => row.version));
  const recordMigration = sqlite.prepare(
    `insert into ${table} (version, name, applied_at) values (?, ?, ?)`,
  );
  for (const migration of plan) {
    if (applied.has(migration.version)) continue;
    migration.up(sqlite);
    recordMigration.run(migration.version, migration.name, new Date().toISOString());
  }
}

function assertLegacyMigrationTable(
  sqlite: Database.Database,
  table: string,
  version: number,
  name: string,
): void {
  const exists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(table);
  if (exists) return;
  throw new Error(
    `Database migration history is incompatible: legacy version ${version} (${JSON.stringify(name)}) is recorded, but table ${JSON.stringify(table)} is missing.`,
  );
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateOAuthAuthorizationCodes(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_authorization_codes (
      code_hash text primary key,
      client_id text not null,
      redirect_uri text not null,
      code_challenge text not null,
      scopes_json text not null,
      resource text,
      expires_at_ms integer not null,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );
    create index if not exists oauth_authorization_codes_expires_at_idx
      on oauth_authorization_codes(expires_at_ms);
  `);
}

function migrateOAuthRefreshReplayRecovery(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_refresh_replays (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      resource text,
      access_expires_at integer not null,
      refresh_expires_at integer not null,
      replay_until integer not null,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_replays_until_idx
      on oauth_refresh_replays(replay_until);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      effort text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
}

function migrateWorkspaceConversationBindings(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}

function migrateLocalAgentStructuredErrors(sqlite: Database.Database): void {
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_code", "text");
  addColumnIfMissing(sqlite, "local_agent_sessions", "error_retryable", "text");
}

function migrateLocalAgentEffortRename(sqlite: Database.Database): void {
  const columns = sqlite.prepare("pragma table_info(local_agent_sessions)").all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));
  if (names.has("effort")) {
    if (names.has("thinking")) {
      sqlite.exec(`
        update local_agent_sessions
        set effort = thinking
        where effort is null and thinking is not null
      `);
    }
    return;
  }
  if (!names.has("thinking")) {
    addColumnIfMissing(sqlite, "local_agent_sessions", "effort", "text");
    return;
  }
  sqlite.exec("alter table local_agent_sessions rename column thinking to effort");
}

function migrateWorkspaceRecoveryState(sqlite: Database.Database): void {
  const workspaceStateExists = sqlite
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'workspace_sessions'")
    .get();
  if (!workspaceStateExists) return;

  addColumnIfMissing(sqlite, "workspace_sessions", "recovery_kind", "text");
}

function migrateLearningMemory(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists learning_episodes (
      id text primary key,
      workspace_root text not null,
      conversation_scope_id text,
      tool text not null,
      input_summary text not null,
      output_summary text not null,
      success integer not null,
      created_at text not null
    );

    create index if not exists learning_episodes_workspace_created_idx
      on learning_episodes(workspace_root, created_at desc);

    create index if not exists learning_episodes_workspace_success_idx
      on learning_episodes(workspace_root, success, created_at desc);

    create table if not exists learning_candidates (
      id text primary key,
      workspace_root text not null,
      title text not null,
      trigger text not null,
      procedure_json text not null,
      evidence_json text not null,
      confidence real not null,
      status text not null,
      validation_note text,
      skill_path text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists learning_candidates_workspace_status_idx
      on learning_candidates(workspace_root, status, updated_at desc);
  `);
}

function migrateMultiNodeControlPlane(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists execution_nodes (
      id text primary key,
      kind text not null,
      alias text,
      protocol_major integer not null,
      protocol_minor integer not null,
      health text not null,
      platform_json text not null,
      capabilities_json text not null,
      created_at text not null,
      last_seen_at text not null
    );

    create index if not exists execution_nodes_alias_idx
      on execution_nodes(alias);

    create index if not exists execution_nodes_health_seen_idx
      on execution_nodes(health, last_seen_at desc);

    create table if not exists workspace_routes (
      workspace_id text primary key,
      node_id text not null,
      local_workspace_id text not null,
      created_at text not null,
      last_used_at text not null,
      foreign key (node_id) references execution_nodes(id)
    );

    create index if not exists workspace_routes_node_idx
      on workspace_routes(node_id, last_used_at desc);

    create index if not exists workspace_routes_local_idx
      on workspace_routes(node_id, local_workspace_id);

    create table if not exists task_routes (
      task_id text primary key,
      node_id text not null,
      workspace_id text not null,
      local_task_id text not null,
      run_id text,
      created_at text not null,
      last_used_at text not null,
      foreign key (node_id) references execution_nodes(id),
      foreign key (workspace_id) references workspace_routes(workspace_id) on delete cascade
    );

    create index if not exists task_routes_node_idx
      on task_routes(node_id, last_used_at desc);

    create index if not exists task_routes_workspace_idx
      on task_routes(workspace_id, last_used_at desc);
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
