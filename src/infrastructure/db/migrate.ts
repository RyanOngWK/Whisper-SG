/**
 * Database migration runner.
 *
 * Usage:
 *   npm run migrate:up          # apply pending migrations
 *   npm run migrate:down        # rollback last migration (must have a down.sql)
 *   npm run migrate:create      # scaffold a new migration file
 *
 * Migrations are tracked in a `_migrations` table.
 * Each migration directory in `db/migrations/` contains:
 *   - up.sql   (forward migration)
 *   - down.sql (optional rollback)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../../infrastructure/config/schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../db/migrations");

const { Pool } = pg;

function createPool(): pg.Pool {
  const config = loadConfig();
  return new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : false,
    max: 1,
  });
}

async function ensureTrackingTable(db: pg.Pool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMigrations(db: pg.Pool): Promise<Set<string>> {
  const { rows } = await db.query<{ name: string }>(
    "SELECT name FROM _migrations ORDER BY name",
  );
  return new Set(rows.map((r) => r.name));
}

async function runUp(): Promise<void> {
  const db = createPool();
  try {
    await ensureTrackingTable(db);
    const applied = await appliedMigrations(db);
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort();

    for (const dir of dirs) {
      if (applied.has(dir.name)) continue;

      const sqlPath = path.join(MIGRATIONS_DIR, dir.name, "up.sql");
      if (!fs.existsSync(sqlPath)) {
        console.error(`Missing up.sql in migration ${dir.name}`);
        process.exit(1);
      }

      const sql = fs.readFileSync(sqlPath, "utf8");
      console.log(`Applying ${dir.name}...`);

      await db.query("BEGIN");
      try {
        await db.query(sql);
        await db.query("INSERT INTO _migrations (name) VALUES ($1)", [
          dir.name,
        ]);
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      }

      console.log(`  done.`);
    }

    console.log("Migrations complete.");
  } finally {
    await db.end();
  }
}

async function runDown(): Promise<void> {
  const db = createPool();
  try {
    await ensureTrackingTable(db);
    const applied = await appliedMigrations(db);

    const dirs = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .sort()
      .reverse();

    for (const dir of dirs) {
      if (!applied.has(dir.name)) continue;

      const sqlPath = path.join(MIGRATIONS_DIR, dir.name, "down.sql");
      if (!fs.existsSync(sqlPath)) {
        console.log(`Skipping ${dir.name} (no down.sql).`);
        continue;
      }

      const sql = fs.readFileSync(sqlPath, "utf8");
      console.log(`Rolling back ${dir.name}...`);

      await db.query("BEGIN");
      try {
        await db.query(sql);
        await db.query("DELETE FROM _migrations WHERE name = $1", [dir.name]);
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      }

      console.log(`  done.`);
      break; // roll back one at a time
    }

    console.log("Rollback complete.");
  } finally {
    await db.end();
  }
}

function runCreate(): void {
  const name = process.argv[3];
  if (!name) {
    console.error("Usage: npm run migrate:create <name>");
    process.exit(1);
  }

  const seq = String(fs.readdirSync(MIGRATIONS_DIR).filter(d => /^\d/.test(d)).length + 1).padStart(3, "0");
  const dirName = `${seq}_${name.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}`;
  const dirPath = path.join(MIGRATIONS_DIR, dirName);

  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(path.join(dirPath, "up.sql"), "-- Up migration\n");
  fs.writeFileSync(path.join(dirPath, "down.sql"), "-- Down migration\n");

  console.log(`Created migration: ${dirName}`);
}

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case "up":
      await runUp();
      break;
    case "down":
      await runDown();
      break;
    case "create":
      runCreate();
      break;
    default:
      console.error("Usage: migrate <up|down|create>");
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
