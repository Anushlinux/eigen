import postgres from "postgres";
import { migrateHostedAuth } from "./hosted-auth-migration.js";
import {
  collections,
  emptyState,
  type PlatformState,
  type PlatformStore,
} from "./types.js";

const table = (collection: string) => `eigen_${collection.toLowerCase()}`;

/** Small invited-pilot store. A database lock serializes short state transitions,
 * never network calls or agent work. Separate processes share the same fence. */
export function createPostgresStore(
  url: string,
): PlatformStore & { migrate(): Promise<void> } {
  const sql = postgres(url, {
    max: 4,
    connect_timeout: 10,
    idle_timeout: 20,
    onnotice: () => {},
  });
  async function load(tx: typeof sql) {
    const state = emptyState();
    for (const name of collections) {
      const rows = await tx.unsafe(`SELECT id, data FROM ${table(name)}`);
      Object.assign(
        state[name],
        Object.fromEntries(rows.map((row) => [row.id, row.data])),
      );
    }
    return state;
  }
  return {
    async migrate() {
      await sql.begin(async (raw) => {
        const tx = raw as unknown as typeof sql;
        await tx`SELECT pg_advisory_xact_lock(73491822)`;
        await tx`CREATE TABLE IF NOT EXISTS eigen_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
        if (
          !(await tx`SELECT version FROM eigen_migrations WHERE version=1`)
            .length
        ) {
          for (const name of collections) {
            await tx.unsafe(
              `CREATE TABLE ${table(name)} (id text PRIMARY KEY, owner_id text NOT NULL, data jsonb NOT NULL CHECK (data->>'id'=id AND data->>'ownerId'=owner_id))`,
            );
            await tx.unsafe(
              `CREATE INDEX ${table(name)}_owner ON ${table(name)} (owner_id)`,
            );
          }
          await tx`INSERT INTO eigen_migrations(version) VALUES (1)`;
        }
        if (
          !(await tx`SELECT version FROM eigen_migrations WHERE version=2`)
            .length
        ) {
          for (const name of collections)
            await tx.unsafe(
              `ALTER TABLE ${table(name)} ADD CONSTRAINT ${table(name)}_record CHECK (jsonb_typeof(data) = 'object' AND (data->>'id') IS NOT DISTINCT FROM id AND (data->>'ownerId') IS NOT DISTINCT FROM owner_id)`,
            );
          await tx`INSERT INTO eigen_migrations(version) VALUES (2)`;
        }
        if (
          !(await tx`SELECT version FROM eigen_migrations WHERE version=3`)
            .length
        ) {
          await migrateHostedAuth(tx);
          await tx`INSERT INTO eigen_migrations(version) VALUES (3)`;
        }
      });
    },
    async read<T>(fn: (state: PlatformState) => T) {
      return (await sql.begin(
        "read only isolation level repeatable read",
        async (raw) => fn(await load(raw as unknown as typeof sql)),
      )) as T;
    },
    async transaction<T>(fn: (state: PlatformState) => T) {
      return (await sql.begin(async (raw) => {
        const tx = raw as unknown as typeof sql;
        await tx`SELECT pg_advisory_xact_lock(73491822)`;
        const state = await load(tx);
        const before = structuredClone(state);
        const value = fn(state);
        for (const name of collections) {
          for (const id of Object.keys(before[name])) {
            if (!(id in state[name]))
              await tx.unsafe(`DELETE FROM ${table(name)} WHERE id=$1`, [id]);
          }
          for (const row of Object.values(state[name])) {
            if (JSON.stringify(row) === JSON.stringify(before[name][row.id]))
              continue;
            await tx.unsafe(
              `INSERT INTO ${table(name)} (id, owner_id, data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET data=excluded.data, owner_id=excluded.owner_id`,
              [
                row.id,
                row.ownerId,
                tx.json(row as unknown as Parameters<typeof tx.json>[0]),
              ],
            );
          }
        }
        return value;
      })) as T;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Injected test store only; production never falls back to memory. */
export function createMemoryStore(initial = emptyState()): PlatformStore {
  let state = structuredClone(initial);
  return {
    async read(fn) {
      return structuredClone(fn(structuredClone(state)));
    },
    async transaction(fn) {
      const next = structuredClone(state);
      const result = fn(next);
      state = next;
      return structuredClone(result);
    },
    async close() {},
  };
}
