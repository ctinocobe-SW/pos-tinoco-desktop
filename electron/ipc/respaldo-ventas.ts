import { app, ipcMain, safeStorage, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import { crearRespaldoVentas, usuarioRespaldo } from '../db/respaldo-ventas'

export function registrarRespaldoVentas(ventana: () => WebContents | undefined, origen: string) {
  const respaldo = crearRespaldoVentas(join(app.getPath('userData'), 'backups', 'ventas-efectivo'),
    datos => safeStorage.encryptString(datos), datos => safeStorage.decryptString(datos))

  async function autorizar(event: IpcMainInvokeEvent) {
    const frame = event.senderFrame
    if (!frame || frame.parent || event.sender !== ventana() || new URL(frame.url).origin !== origen) {
      throw new Error('Ventana no autorizada')
    }
    const [cookie] = await event.sender.session.cookies.get({ url: origen, name: 'offline_session' })
    const usuario = usuarioRespaldo(cookie?.value, process.env.OFFLINE_SESSION_SECRET)
    if (!usuario) throw new Error('Sesión local de administrador requerida')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Respaldo protegido no disponible')
    return usuario
  }

  ipcMain.handle('venta-respaldo:guardar', async (event, almacen: string, venta: unknown) => {
    await respaldo.guardar(await autorizar(event), almacen, venta)
  })
  ipcMain.handle('venta-respaldo:listar', async (event, almacen: string) => {
    return respaldo.listar(await autorizar(event), almacen)
  })
}
