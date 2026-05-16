import { net, BrowserWindow, ipcMain } from 'electron'
import { getDb } from '../db/sqlite'

const SUPABASE_URL = process.env.SUPABASE_URL ?? ''
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? ''

const RETRY_DELAYS_MS = [2000, 10000, 30000, 120000, 300000] // 2s, 10s, 30s, 2min, 5min
const SYNC_INTERVAL_MS = 30000 // cada 30 segundos cuando hay internet

let syncTimer: ReturnType<typeof setInterval> | null = null
let isSyncing = false

// ── API helper ────────────────────────────────────────────────────
async function supabaseFetch(path: string, options: RequestInit = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Prefer': 'return=representation',
      ...(options.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Supabase ${res.status}: ${body}`)
  }
  return res.json()
}

// ── Notificar al renderer ─────────────────────────────────────────
function broadcast(channel: string, ...args: unknown[]) {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  })
}

// ── Sincronizar un ticket ─────────────────────────────────────────
async function syncTicket(ticket: Record<string, unknown>, items: Record<string, unknown>[]) {
  const db = getDb()

  // Generar UUID y folio real en Supabase
  const ticketId = ticket.id as string

  // Insertar ticket en Supabase (idempotente con ON CONFLICT DO NOTHING)
  await supabaseFetch('/tickets', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({
      id: ticketId,
      cliente_id: ticket.cliente_id ?? null,
      despachador_id: ticket.despachador_id ?? null,
      almacen_id: ticket.almacen_id ?? null,
      estado: 'pendiente_aprobacion',
      subtotal: ticket.subtotal,
      iva: ticket.total_iva,
      ieps: ticket.total_ieps,
      descuento: 0,
      total: ticket.total,
      notas: ticket.notas ?? null,
      created_at: ticket.created_at,
    }),
  })

  // Insertar items
  if (items.length > 0) {
    await supabaseFetch('/ticket_items', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(items.map((item) => ({
        id: item.id,
        ticket_id: ticketId,
        producto_id: item.producto_id,
        unidad: item.unidad,
        cantidad: item.cantidad,
        precio_unitario: item.precio_unitario,
        tasa_iva: item.tasa_iva,
        tasa_ieps: item.tasa_ieps,
        subtotal: item.subtotal,
        total: item.total,
      }))),
    })
  }

  // Marcar como sincronizado en SQLite
  db.prepare('UPDATE tickets_offline SET synced = 1, sync_error = NULL WHERE id = ?').run(ticketId)
  db.prepare('DELETE FROM sync_queue WHERE entity = ? AND entity_id = ?').run('ticket', ticketId)
}

// ── Ciclo de sincronización ───────────────────────────────────────
export async function syncNow() {
  if (isSyncing) return
  if (!net.isOnline()) return
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return

  isSyncing = true
  const db = getDb()

  const pending = db.prepare(`
    SELECT t.*, json_group_array(json_object(
      'id', i.id, 'producto_id', i.producto_id, 'producto_nombre', i.producto_nombre,
      'unidad', i.unidad, 'cantidad', i.cantidad, 'precio_unitario', i.precio_unitario,
      'tasa_iva', i.tasa_iva, 'tasa_ieps', i.tasa_ieps, 'subtotal', i.subtotal, 'total', i.total
    )) as items_json
    FROM tickets_offline t
    LEFT JOIN ticket_items_offline i ON i.ticket_id = t.id
    WHERE t.synced = 0 AND t.sync_attempts < 5
    GROUP BY t.id
    ORDER BY t.created_at ASC
  `).all() as Array<Record<string, unknown>>

  if (pending.length === 0) { isSyncing = false; return }

  broadcast('sync:progress', pending.length)

  let syncedCount = 0
  for (const ticket of pending) {
    try {
      const items = JSON.parse(ticket.items_json as string) as Record<string, unknown>[]
      await syncTicket(ticket, items.filter((i) => i.id !== null))
      syncedCount++
    } catch (err) {
      const attempts = (ticket.sync_attempts as number) + 1
      db.prepare(`
        UPDATE tickets_offline
        SET sync_attempts = ?, sync_error = ?
        WHERE id = ?
      `).run(attempts, String(err), ticket.id)

      console.error(`[sync] Failed to sync ticket ${ticket.id}:`, err)
    }
  }

  isSyncing = false

  const remaining = (db.prepare('SELECT COUNT(*) as count FROM tickets_offline WHERE synced = 0').get() as { count: number }).count
  broadcast('sync:progress', remaining)

  if (syncedCount > 0) {
    broadcast('sync:complete')
  }

  const errors = pending.length - syncedCount
  if (errors > 0) {
    broadcast('sync:error', `${errors} ticket(s) no se pudieron sincronizar`)
  }
}

// ── Iniciar / detener el motor ────────────────────────────────────
export function startSyncEngine() {
  // Sync inmediato al arrancar
  syncNow().catch(console.error)

  // Sync periódico
  syncTimer = setInterval(() => {
    if (net.isOnline()) syncNow().catch(console.error)
  }, SYNC_INTERVAL_MS)
}

export function stopSyncEngine() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null }
}

// ── IPC handler ───────────────────────────────────────────────────
export function registerSyncHandlers() {
  ipcMain.handle('sync:now', () => syncNow())
}
