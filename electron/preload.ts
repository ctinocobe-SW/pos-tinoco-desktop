import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Info
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  isOnline: (): Promise<boolean> => ipcRenderer.invoke('app:isOnline'),
  getPath: (name: string): Promise<string> => ipcRenderer.invoke('app:getPath', name),
  isKiosk: (): Promise<boolean> => ipcRenderer.invoke('app:isKiosk'),

  // Control de ventana (modo sin frame)
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),

  // Impresión silenciosa (sin diálogo) a la impresora predeterminada.
  // Recibe el HTML del ticket para imprimirlo en una ventana dedicada y aislada
  // (más fiable que imprimir la ventana principal con CSS @media print).
  printSilent: (html?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('print:silent', html),
  listPrinters: (): Promise<unknown[]> => ipcRenderer.invoke('print:listPrinters'),

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
