// La captura nueva usa la cola Dexie y RPC autenticadas desde el renderer.
// Preservar SQLite heredado; no enviarlo con una llave maestra ni inferir autores.
import { BrowserWindow, ipcMain } from 'electron'
import { getDb } from '../db/sqlite'
export async function syncNow() {
 const row = getDb().prepare('SELECT COUNT(*) AS count FROM tickets_offline WHERE synced = 0').get() as {count:number}
 for (const win of BrowserWindow.getAllWindows()) {
  if (!win.isDestroyed()) win.webContents.send('sync:progress', row.count)
 }
 if(row.count) throw new Error('Existen tickets SQLite heredados. Conserva la base y revisa su importación antes de cerrar la actualización.')
}
export function startSyncEngine() { syncNow().catch(console.error) }
export function stopSyncEngine() { /* La cola nueva no tiene motor privilegiado en main. */ }
export function registerSyncHandlers() { ipcMain.handle('sync:now', () => syncNow()) }
