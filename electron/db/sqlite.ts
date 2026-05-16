import Database from 'better-sqlite3'
import * as path from 'path'
import { app } from 'electron'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  const dbPath = path.join(app.getPath('userData'), 'pos-tinoco.db')
  db = new Database(dbPath)

  // Configuración de rendimiento
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')

  runMigrations(db)
  return db
}

export function closeDb() {
  if (db) { db.close(); db = null }
}

// ── Migraciones ──────────────────────────────────────────────────
function runMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )
  `)

  const current = (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null }).v ?? 0

  const migrations: Array<{ version: number; sql: string }> = [
    {
      version: 1,
      sql: `
        -- Cola de tickets creados offline
        CREATE TABLE IF NOT EXISTS tickets_offline (
          id              TEXT PRIMARY KEY,
          folio_local     TEXT NOT NULL,
          cliente_id      TEXT,
          cliente_nombre  TEXT,
          es_credito      INTEGER NOT NULL DEFAULT 0,
          notas           TEXT,
          total           REAL NOT NULL DEFAULT 0,
          subtotal        REAL NOT NULL DEFAULT 0,
          total_iva       REAL NOT NULL DEFAULT 0,
          total_ieps      REAL NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL,
          synced          INTEGER NOT NULL DEFAULT 0,
          sync_error      TEXT,
          sync_attempts   INTEGER NOT NULL DEFAULT 0
        );

        -- Items de cada ticket offline
        CREATE TABLE IF NOT EXISTS ticket_items_offline (
          id              TEXT PRIMARY KEY,
          ticket_id       TEXT NOT NULL REFERENCES tickets_offline(id) ON DELETE CASCADE,
          producto_id     TEXT NOT NULL,
          producto_nombre TEXT NOT NULL,
          producto_sku    TEXT,
          unidad          TEXT NOT NULL,
          cantidad        REAL NOT NULL,
          precio_unitario REAL NOT NULL,
          tasa_iva        REAL NOT NULL DEFAULT 0,
          tasa_ieps       REAL NOT NULL DEFAULT 0,
          subtotal        REAL NOT NULL,
          total           REAL NOT NULL
        );

        -- Cola de sincronización general
        CREATE TABLE IF NOT EXISTS sync_queue (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          entity      TEXT NOT NULL,
          entity_id   TEXT NOT NULL,
          operation   TEXT NOT NULL,
          payload     TEXT NOT NULL,
          created_at  TEXT NOT NULL,
          attempts    INTEGER NOT NULL DEFAULT 0,
          last_error  TEXT
        );
      `,
    },
  ]

  for (const migration of migrations) {
    if (migration.version > current) {
      db.transaction(() => {
        db.exec(migration.sql)
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
      })()
    }
  }
}
