import { ipcMain } from 'electron'
import { getDb } from '../db/sqlite'
import { randomUUID } from 'crypto'

export type TicketItemOfflinePayload = {
  producto_id: string
  producto_nombre: string
  producto_sku?: string
  unidad: string
  cantidad: number
  precio_unitario: number
  tasa_iva: number
  tasa_ieps: number
  subtotal: number
  total: number
}

export type CreateTicketOfflinePayload = {
  cliente_id?: string
  cliente_nombre?: string
  es_credito: boolean
  notas?: string
  items: TicketItemOfflinePayload[]
  subtotal: number
  total_iva: number
  total_ieps: number
  total: number
}

export type TicketOfflineResult = {
  id: string
  folio_local: string
}

function registerTicketHandlers() {
  // ── Crear ticket offline ───────────────────────────────────────
  ipcMain.handle('ticket:create', (_event, payload: CreateTicketOfflinePayload): TicketOfflineResult => {
    const db = getDb()
    const id = randomUUID()
    const now = new Date().toISOString()

    // Folio local temporal: TMP-YYYYMMDD-XXXX
    const datePart = now.slice(0, 10).replace(/-/g, '')
    const rand = Math.floor(Math.random() * 9000) + 1000
    const folio_local = `TMP-${datePart}-${rand}`

    db.transaction(() => {
      db.prepare(`
        INSERT INTO tickets_offline
          (id, folio_local, cliente_id, cliente_nombre, es_credito, notas,
           total, subtotal, total_iva, total_ieps, created_at)
        VALUES
          (@id, @folio_local, @cliente_id, @cliente_nombre, @es_credito, @notas,
           @total, @subtotal, @total_iva, @total_ieps, @created_at)
      `).run({
        id,
        folio_local,
        cliente_id: payload.cliente_id ?? null,
        cliente_nombre: payload.cliente_nombre ?? null,
        es_credito: payload.es_credito ? 1 : 0,
        notas: payload.notas ?? null,
        total: payload.total,
        subtotal: payload.subtotal,
        total_iva: payload.total_iva,
        total_ieps: payload.total_ieps,
        created_at: now,
      })

      for (const item of payload.items) {
        db.prepare(`
          INSERT INTO ticket_items_offline
            (id, ticket_id, producto_id, producto_nombre, producto_sku,
             unidad, cantidad, precio_unitario, tasa_iva, tasa_ieps, subtotal, total)
          VALUES
            (@id, @ticket_id, @producto_id, @producto_nombre, @producto_sku,
             @unidad, @cantidad, @precio_unitario, @tasa_iva, @tasa_ieps, @subtotal, @total)
        `).run({
          id: randomUUID(),
          ticket_id: id,
          producto_id: item.producto_id,
          producto_nombre: item.producto_nombre,
          producto_sku: item.producto_sku ?? null,
          unidad: item.unidad,
          cantidad: item.cantidad,
          precio_unitario: item.precio_unitario,
          tasa_iva: item.tasa_iva,
          tasa_ieps: item.tasa_ieps,
          subtotal: item.subtotal,
          total: item.total,
        })
      }

      // Encolar para sync
      db.prepare(`
        INSERT INTO sync_queue (entity, entity_id, operation, payload, created_at)
        VALUES ('ticket', @entity_id, 'create', @payload, @created_at)
      `).run({
        entity_id: id,
        payload: JSON.stringify({ id, folio_local, ...payload }),
        created_at: now,
      })
    })()

    return { id, folio_local }
  })

  // ── Listar tickets pendientes de sync ─────────────────────────
  ipcMain.handle('ticket:getPending', () => {
    const db = getDb()
    return db.prepare(`
      SELECT t.*, json_group_array(json_object(
        'id', i.id,
        'producto_id', i.producto_id,
        'producto_nombre', i.producto_nombre,
        'cantidad', i.cantidad,
        'precio_unitario', i.precio_unitario,
        'total', i.total
      )) as items
      FROM tickets_offline t
      LEFT JOIN ticket_items_offline i ON i.ticket_id = t.id
      WHERE t.synced = 0
      GROUP BY t.id
      ORDER BY t.created_at ASC
    `).all()
  })

  // ── Contar pendientes ─────────────────────────────────────────
  ipcMain.handle('sync:getPendingCount', () => {
    const db = getDb()
    const row = db.prepare('SELECT COUNT(*) as count FROM tickets_offline WHERE synced = 0').get() as { count: number }
    return row.count
  })
}

export { registerTicketHandlers }
