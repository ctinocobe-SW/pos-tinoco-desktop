import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Info
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  isOnline: (): Promise<boolean> => ipcRenderer.invoke('app:isOnline'),
  getPath: (name: string): Promise<string> => ipcRenderer.invoke('app:getPath', name),

  // Tickets offline (Fase 1)
  createTicket: (payload: unknown): Promise<unknown> =>
    ipcRenderer.invoke('ticket:create', payload),
  getPendingTickets: (): Promise<unknown[]> =>
    ipcRenderer.invoke('ticket:getPending'),

  // Sync (Fase 2)
  syncNow: (): Promise<void> => ipcRenderer.invoke('sync:now'),
  getPendingCount: (): Promise<number> => ipcRenderer.invoke('sync:getPendingCount'),

  // Eventos del main → renderer
  onSyncProgress: (cb: (count: number) => void) => {
    ipcRenderer.on('sync:progress', (_e, count) => cb(count))
  },
  onSyncComplete: (cb: () => void) => {
    ipcRenderer.on('sync:complete', () => cb())
  },
  onSyncError: (cb: (msg: string) => void) => {
    ipcRenderer.on('sync:error', (_e, msg) => cb(msg))
  },
  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel)
  },
})
