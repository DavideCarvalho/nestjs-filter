/**
 * Resolves the database backend the cross-adapter contract suite runs against.
 *
 * The same behavioral spec runs three ways:
 *   - `sqlite`   (default) — in-memory, no Docker, keeps `pnpm test` fast/green
 *   - `postgres` — real PostgreSQL via @testcontainers/postgresql (`test:db`)
 *   - `mysql`    — real MySQL via @testcontainers/mysql (`test:db`)
 *
 * Selection is by the `CONTRACT_DB` env var (`sqlite` | `postgres` | `mysql`).
 * The container lifecycle is owned here so the spec stays dialect-agnostic.
 */

export type ContractDialect = 'sqlite' | 'postgres' | 'mysql';

export interface ConnectionInfo {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Connection options consumed by both ORM harnesses. */
export interface BackendConnection {
  dialect: ContractDialect;
  /** Present for postgres/mysql; absent for sqlite (in-memory). */
  connection?: ConnectionInfo;
}

/** A started backend plus a teardown hook (no-op for sqlite). */
export interface StartedBackend extends BackendConnection {
  stop(): Promise<void>;
}

/**
 * Both adapter harnesses share a single container but must not share schema:
 * TypeORM and MikroORM each manage their own tables (incl. differently-named
 * M:N pivot tables), so co-locating them in one database makes a drop/refresh
 * trip over the other's foreign keys (notably on MySQL). To isolate them, each
 * harness gets its own database within the shared container. This creates it
 * (idempotently) and returns a connection pointing at it. No-op for sqlite
 * (each module is its own in-memory db already).
 */
export async function isolatedDatabase(
  backend: BackendConnection,
  suffix: string,
): Promise<BackendConnection> {
  if (backend.dialect === 'sqlite' || !backend.connection) return backend;
  const base = backend.connection;
  const dbName = `${base.database}_${suffix}`;

  if (backend.dialect === 'postgres') {
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      host: base.host,
      port: base.port,
      user: base.user,
      password: base.password,
      database: base.database,
    });
    await client.connect();
    // CREATE DATABASE IF NOT EXISTS is not valid in PG; guard with a catch.
    await client.query(`CREATE DATABASE ${dbName}`).catch(() => {});
    await client.end();
  } else {
    // Only root can create a new database AND grant the app user access to it.
    // MySqlContainer is started with root password 'contract' (see startBackend).
    const { createConnection } = await import('mysql2/promise');
    const conn = await createConnection({
      host: base.host,
      port: base.port,
      user: 'root',
      password: 'contract',
      database: base.database,
    });
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO ?@'%'`, [base.user]);
    await conn.query('FLUSH PRIVILEGES');
    await conn.end();
  }

  return { dialect: backend.dialect, connection: { ...base, database: dbName } };
}

export function resolveDialect(): ContractDialect {
  const raw = (process.env.CONTRACT_DB ?? 'sqlite').toLowerCase();
  if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') return 'postgres';
  if (raw === 'mysql' || raw === 'mariadb') return 'mysql';
  return 'sqlite';
}

/**
 * Best-effort Docker availability probe. testcontainers needs a reachable
 * Docker daemon; without one the real-DB matrix must skip gracefully so CI/dev
 * without Docker stays green.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    // Lazy import so environments without testcontainers installed (or without
    // Docker) never pay the cost or crash at module load.
    const { getContainerRuntimeClient } = await import('testcontainers');
    // Resolving the runtime client connects to the Docker daemon and gathers
    // its info; it throws when no daemon is reachable. That's the probe. Bound
    // it with a timeout — an unreachable DOCKER_HOST otherwise retries with
    // backoff for ~minute, which would make the "no Docker → skip" path slow.
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('docker probe timed out')), 15_000),
    );
    const client = await Promise.race([getContainerRuntimeClient(), timeout]);
    return Boolean(client?.info?.containerRuntime);
  } catch {
    return false;
  }
}

/**
 * Starts the backend for the resolved dialect. For sqlite this is a no-op
 * descriptor; for postgres/mysql it boots a throwaway container and returns its
 * connection coordinates plus a `stop()` hook.
 */
export async function startBackend(dialect: ContractDialect): Promise<StartedBackend> {
  if (dialect === 'sqlite') {
    return { dialect, stop: async () => {} };
  }

  if (dialect === 'postgres') {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('contract')
      .withUsername('contract')
      .withPassword('contract')
      .start();
    return {
      dialect,
      connection: {
        host: container.getHost(),
        port: container.getPort(),
        user: container.getUsername(),
        password: container.getPassword(),
        database: container.getDatabase(),
      },
      stop: async () => {
        await container.stop();
      },
    };
  }

  // mysql
  const { MySqlContainer } = await import('@testcontainers/mysql');
  const container = await new MySqlContainer('mysql:8.0')
    .withDatabase('contract')
    .withUsername('contract')
    .withRootPassword('contract')
    .withUserPassword('contract')
    .start();
  return {
    dialect,
    connection: {
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getUserPassword(),
      database: container.getDatabase(),
    },
    stop: async () => {
      await container.stop();
    },
  };
}
