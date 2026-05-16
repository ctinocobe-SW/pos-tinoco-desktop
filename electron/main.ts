import * as dotenv from 'dotenv'
import * as path from 'path'
import * as http from 'http'
import { spawn, ChildProcess } from 'child_process'
import { app, BrowserWindow, Menu, shell, ipcMain, net, globalShortcut, session } from 'electron'

dotenv.config({ path: path.join(__dirname, '..', '.env') })

import { getDb, closeDb } from './db/sqlite'
import { registerTicketHandlers } from './ipc/tickets'
import { startSyncEngine, stopSyncEngine, registerSyncHandlers } from './sync/engine'

const PORT = Number(process.env.NEXT_PORT ?? 3000)
const IS_PACKAGED = app.isPackaged
const KIOSK_MODE = process.env.KIOSK_MODE === 'true'

let mainWindow: BrowserWindow | null = null
let nextServer: ChildProcess | null = null
let splashWindow: BrowserWindow | null = null

// ── Auto-arranque al iniciar Windows ─────────────────────────────
function setupAutoLaunch() {
  if (process.platform !== 'win32') return
  app.setLoginItemSettings({
    openAtLogin: true,
    name: 'El Mercader POS',
    path: app.getPath('exe'),
  })
}

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
    // En modo kiosco: sin frame ni barra de título
    frame: !KIOSK_MODE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Touch optimizations
      zoomFactor: KIOSK_MODE ? 1.15 : 1.0,
    },
  })

  Menu.setApplicationMenu(null)

  // Bloquear atajos de teclado en modo kiosco
  if (KIOSK_MODE) {
    globalShortcut.registerAll(
      ['F12', 'CommandOrControl+R', 'CommandOrControl+Shift+R',
       'CommandOrControl+W', 'CommandOrControl+Q', 'Alt+F4'],
      () => {} // no-op
    )
  }

  mainWindow.loadURL(`http://localhost:${PORT}`)

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close()
      splashWindow = null
    }
    mainWindow?.show()

    if (IS_PACKAGED || KIOSK_MODE) {
      mainWindow?.maximize()
    }
  })

  // Links externos abren en el navegador del sistema
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // En modo kiosco, evitar que el usuario cierre la ventana accidentalmente
  if (KIOSK_MODE) {
    mainWindow.on('close', (e) => {
      e.preventDefault()
    })
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── Arrancar servidor Next.js (solo en producción) ───────────────
function startNextServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const appPath = IS_PACKAGED
      ? path.join(process.resourcesPath, 'web')
      : path.join(__dirname, '..', '..', 'pos-tinoco')

    const isWin = process.platform === 'win32'
    const nextBin = path.join(appPath, 'node_modules', '.bin', isWin ? 'next.cmd' : 'next')

    nextServer = spawn(nextBin, ['start', '-p', String(PORT)], {
      cwd: appPath,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWin, // necesario en Windows para .cmd
    })

    nextServer.stdout?.on('data', (data: Buffer) => {
      if (data.toString().toLowerCase().includes('ready')) resolve()
    })

    nextServer.stderr?.on('data', (data: Buffer) => {
      console.error('[next-server]', data.toString())
    })

    nextServer.on('error', reject)
    nextServer.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Next.js exited with code ${code}`))
    })

    setTimeout(() => reject(new Error('Next.js startup timeout (45s)')), 45000)
  })
}

// ── Esperar respuesta HTTP del servidor ──────────────────────────
function waitForServer(maxAttempts = 45): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const check = () => {
      const req = http.get(`http://localhost:${PORT}`, (res) => {
        if (res.statusCode && res.statusCode < 500) resolve()
        else retry()
      })
      req.on('error', retry)
      req.setTimeout(1000, () => { req.destroy(); retry() })
    }
    const retry = () => {
      attempts++
      if (attempts >= maxAttempts) reject(new Error('Server did not respond in time'))
      else setTimeout(check, 1000)
    }
    check()
  })
}

// ── IPC handlers ─────────────────────────────────────────────────
ipcMain.handle('app:getVersion', () => app.getVersion())
ipcMain.handle('app:isOnline', () => net.isOnline())
ipcMain.handle('app:getPath', (_e, name: string) => app.getPath(name as Parameters<typeof app.getPath>[0]))
ipcMain.handle('app:isKiosk', () => KIOSK_MODE)

// Control de ventana desde el renderer (para modo sin frame)
ipcMain.handle('window:minimize', () => mainWindow?.minimize())
ipcMain.handle('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.handle('window:close', () => {
  if (!KIOSK_MODE) mainWindow?.close()
})

registerTicketHandlers()
registerSyncHandlers()

// ── Ciclo de vida ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  getDb()
  setupAutoLaunch()
  startSyncEngine()
  createSplash()

  try {
    if (IS_PACKAGED) await startNextServer()
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
  globalShortcut.unregisterAll()
  stopSyncEngine()
  if (nextServer) { nextServer.kill(); nextServer = null }
  closeDb()
})
