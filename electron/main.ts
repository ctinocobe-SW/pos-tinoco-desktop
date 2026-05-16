import { app, BrowserWindow, Menu, shell, ipcMain, net } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as http from 'http'
import { getDb, closeDb } from './db/sqlite'
import { registerTicketHandlers } from './ipc/tickets'

const PORT = 3000
const IS_PACKAGED = app.isPackaged

let mainWindow: BrowserWindow | null = null
let nextServer: ChildProcess | null = null
let splashWindow: BrowserWindow | null = null

// ── Splash screen ────────────────────────────────────────────────
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 320,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    center: true,
    resizable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  splashWindow.loadFile(path.join(__dirname, '..', 'assets', 'splash.html'))
}

// ── Main window ──────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'El Mercader del Bajío — POS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  Menu.setApplicationMenu(null)
  mainWindow.loadURL(`http://localhost:${PORT}`)

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close()
      splashWindow = null
    }
    mainWindow?.show()
    if (IS_PACKAGED) mainWindow?.maximize()
  })

  // Links externos abren en el navegador del sistema
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── Arrancar servidor Next.js (solo en producción) ───────────────
function startNextServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const appPath = IS_PACKAGED
      ? path.join(process.resourcesPath, 'web')
      : path.join(__dirname, '..', '..', 'pos-tinoco')

    const nextBin = path.join(appPath, 'node_modules', '.bin', 'next')

    nextServer = spawn(nextBin, ['start', '-p', String(PORT)], {
      cwd: appPath,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    nextServer.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString()
      if (msg.toLowerCase().includes('ready')) resolve()
    })

    nextServer.stderr?.on('data', (data: Buffer) => {
      console.error('[next-server]', data.toString())
    })

    nextServer.on('error', reject)
    nextServer.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Next.js exited with code ${code}`))
    })

    setTimeout(() => reject(new Error('Next.js startup timeout (30s)')), 30000)
  })
}

// ── Esperar respuesta HTTP del servidor ──────────────────────────
function waitForServer(maxAttempts = 40): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const check = () => {
      const req = http.get(`http://localhost:${PORT}`, (res) => {
        if (res.statusCode && res.statusCode < 500) {
          resolve()
        } else {
          retry()
        }
      })
      req.on('error', retry)
      req.setTimeout(1000, () => { req.destroy(); retry() })
    }
    const retry = () => {
      attempts++
      if (attempts >= maxAttempts) {
        reject(new Error('Server did not respond in time'))
      } else {
        setTimeout(check, 1000)
      }
    }
    check()
  })
}

// ── IPC handlers ─────────────────────────────────────────────────
ipcMain.handle('app:getVersion', () => app.getVersion())
ipcMain.handle('app:isOnline', () => net.isOnline())
ipcMain.handle('app:getPath', (_e, name: string) => app.getPath(name as Parameters<typeof app.getPath>[0]))
registerTicketHandlers()

// ── Ciclo de vida ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Inicializar base de datos local
  getDb()

  createSplash()

  try {
    if (IS_PACKAGED) {
      await startNextServer()
    }
    await waitForServer()
    createMainWindow()
  } catch (err) {
    console.error('Startup error:', err)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (nextServer) { nextServer.kill(); nextServer = null }
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createMainWindow()
})

app.on('before-quit', () => {
  if (nextServer) { nextServer.kill(); nextServer = null }
  closeDb()
})
