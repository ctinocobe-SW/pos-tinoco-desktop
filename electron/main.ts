import * as dotenv from 'dotenv'
import * as path from 'path'
import * as http from 'http'
import * as fs from 'fs'
import { spawn, ChildProcess, execSync } from 'child_process'
import { app, BrowserWindow, Menu, shell, ipcMain, net, globalShortcut, dialog } from 'electron'
import { autoUpdater } from 'electron-updater'

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

// ── Logging a archivo ────────────────────────────────────────────
const logDir = app.getPath('userData')
const logFile = path.join(logDir, 'startup.log')

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stdout.write(line)
  try { fs.appendFileSync(logFile, line) } catch { /* ignore */ }
}

// ── Mostrar error en pantalla antes de salir ─────────────────────
function fatalError(title: string, detail: string): void {
  log(`FATAL: ${title} — ${detail}`)
  dialog.showErrorBox(title, `${detail}\n\nLog: ${logFile}`)
  app.quit()
}

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
    frame: !KIOSK_MODE,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      zoomFactor: KIOSK_MODE ? 1.15 : 1.0,
    },
  })

  Menu.setApplicationMenu(null)

  if (KIOSK_MODE) {
    globalShortcut.registerAll(
      ['F12', 'CommandOrControl+R', 'CommandOrControl+Shift+R',
       'CommandOrControl+W', 'CommandOrControl+Q', 'Alt+F4'],
      () => {}
    )
  }

  mainWindow.loadURL(`http://localhost:${PORT}`)

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close()
      splashWindow = null
    }
    mainWindow?.show()
    if (IS_PACKAGED || KIOSK_MODE) mainWindow?.maximize()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (KIOSK_MODE) {
    mainWindow.on('close', (e) => { e.preventDefault() })
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── Arrancar servidor Next.js ────────────────────────────────────
// En Windows dentro del asar, los .cmd de node_modules/.bin no funcionan.
// Usamos `node` directamente apuntando al script de Next.js.
// ── Liberar el puerto si quedó un proceso zombi de una instancia anterior ──
function freePort(port: number) {
  if (process.platform !== 'win32') return
  try {
    const out = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: 'utf-8' })
    const pids = new Set<string>()
    out.split(/\r?\n/).forEach((line) => {
      const m = line.match(/LISTENING\s+(\d+)/)
      if (m) pids.add(m[1])
    })
    pids.forEach((pid) => {
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
        log(`Freed port ${port}: killed PID ${pid}`)
      } catch { /* ignore */ }
    })
  } catch { /* netstat sin resultados = puerto libre */ }
}

// ── Matar el proceso de Next.js (en Windows mata todo el árbol) ──
function killNextServer() {
  if (!nextServer) return
  const pid = nextServer.pid
  if (process.platform === 'win32' && pid != null) {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
      log(`killNextServer: taskkill /F /T /PID ${pid}`)
    } catch { /* ignore */ }
  } else {
    try { nextServer.kill('SIGTERM') } catch { /* ignore */ }
  }
  nextServer = null
}

function startNextServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const appPath = IS_PACKAGED
      ? path.join(process.resourcesPath, 'web')
      : path.join(__dirname, '..', '..', 'pos-tinoco')

    log(`Starting Next.js from: ${appPath}`)

    // Verificar que la ruta existe
    if (!fs.existsSync(appPath)) {
      return reject(new Error(`Web app path not found: ${appPath}`))
    }

    // Verificar que el build de Next.js existe
    const nextBuildDir = path.join(appPath, '.next')
    if (!fs.existsSync(nextBuildDir)) {
      return reject(new Error(`.next build dir not found at: ${nextBuildDir}`))
    }

    const isWin = process.platform === 'win32'

    // El script JS de Next.js (funciona en todos los OS con cualquier node)
    const nextScript = path.join(appPath, 'node_modules', 'next', 'dist', 'bin', 'next')

    if (!fs.existsSync(nextScript)) {
      return reject(new Error(`next script not found at: ${nextScript}`))
    }

    // node.exe se empaqueta junto al .exe en la carpeta de instalación
    // (extraFiles en electron-builder.yml lo copia ahí)
    const electronDir = path.dirname(app.getPath('exe'))
    const nodeWin     = path.join(electronDir, 'node.exe')

    let nodeBin: string
    if (isWin) {
      if (fs.existsSync(nodeWin)) {
        nodeBin = nodeWin
      } else {
        // Fallback: node del PATH (si el usuario tiene Node instalado)
        nodeBin = 'node.exe'
        log(`WARN: node.exe not found at ${nodeWin}, falling back to PATH`)
      }
    } else {
      nodeBin = 'node'
    }

    log(`node binary: ${nodeBin}`)
    log(`next script: ${nextScript}`)

    const env = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      NEXT_PUBLIC_SUPABASE_URL:      process.env.NEXT_PUBLIC_SUPABASE_URL      ?? '',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
      SUPABASE_SERVICE_ROLE_KEY:     process.env.SUPABASE_SERVICE_ROLE_KEY     ?? '',
      NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
      BROWSER: 'none',
    }

    // Si una instancia previa dejó node.exe ocupando el puerto, liberarlo
    freePort(PORT)

    nextServer = spawn(nodeBin, [nextScript, 'start', '-p', String(PORT)], {
      cwd: appPath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // En Windows NO usar shell:true porque distorsiona los paths con espacios
    })

    let resolved = false

    nextServer.stdout?.on('data', (data: Buffer) => {
      const text = data.toString()
      log(`[next] ${text.trim()}`)
      if (!resolved && (text.toLowerCase().includes('ready') || text.includes('started server'))) {
        resolved = true
        resolve()
      }
    })

    nextServer.stderr?.on('data', (data: Buffer) => {
      log(`[next:err] ${data.toString().trim()}`)
    })

    nextServer.on('error', (err) => {
      log(`[next:spawn-error] ${err.message}`)
      if (!resolved) reject(err)
    })

    nextServer.on('exit', (code) => {
      log(`[next:exit] code=${code}`)
      if (!resolved && code !== 0) {
        reject(new Error(`Next.js exited with code ${code}`))
      }
    })

    // Timeout generoso para máquinas lentas
    setTimeout(() => {
      if (!resolved) reject(new Error('Next.js no respondió en 60 segundos'))
    }, 60000)
  })
}

// ── Esperar respuesta HTTP del servidor ──────────────────────────
function waitForServer(maxAttempts = 60): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const check = () => {
      const req = http.get(`http://localhost:${PORT}`, (res) => {
        log(`[http-check] status=${res.statusCode} attempt=${attempts}`)
        if (res.statusCode && res.statusCode < 500) resolve()
        else retry()
      })
      req.on('error', () => retry())
      req.setTimeout(1500, () => { req.destroy(); retry() })
    }
    const retry = () => {
      attempts++
      if (attempts >= maxAttempts) {
        reject(new Error(`Servidor no respondió después de ${maxAttempts} intentos`))
      } else {
        setTimeout(check, 1000)
      }
    }
    check()
  })
}

// Auto-updater
function setupAutoUpdater() {
  if (!IS_PACKAGED) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => log('Checking for update...'))
  autoUpdater.on('update-not-available', () => log('App is up to date'))

  autoUpdater.on('update-available', (info) => {
    log(`Update available: ${info.version}`)
  })

  autoUpdater.on('download-progress', (p) => {
    log(`Download progress: ${Math.round(p.percent)}%`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    log(`Update downloaded: ${info.version}`)
    dialog.showMessageBox({
      type: 'info',
      title: 'Actualizacion lista',
      message: `La version ${info.version} esta lista para instalar.`,
      detail: 'La aplicacion se reiniciara para aplicar la actualizacion.',
      buttons: ['Reiniciar ahora', 'Mas tarde'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        // CRÍTICO: matar el servidor Next.js (node.exe) y liberar el puerto
        // ANTES de instalar. Si node.exe sigue vivo, bloquea archivos y NSIS
        // deja la instalación a medias → acceso directo roto.
        log('Preparando instalación: cerrando Next.js y liberando puerto...')
        killNextServer()
        freePort(PORT)
        stopSyncEngine()
        closeDb()
        // isSilent=false (mostrar instalador), isForceRunAfter=true (reabrir al terminar)
        setTimeout(() => autoUpdater.quitAndInstall(false, true), 800)
      }
    })
  })

  autoUpdater.on('error', (err) => {
    log(`Auto-updater error: ${err.message}`)
  })

  log('Starting auto-updater check...')
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    log(`checkForUpdates failed: ${err.message}`)
  })
}

// ── IPC handlers ─────────────────────────────────────────────────
ipcMain.handle('app:getVersion', () => app.getVersion())
ipcMain.handle('app:isOnline', () => net.isOnline())
ipcMain.handle('app:getPath', (_e, name: string) => app.getPath(name as Parameters<typeof app.getPath>[0]))
ipcMain.handle('app:isKiosk', () => KIOSK_MODE)
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
  log('App ready — starting up')
  log(`IS_PACKAGED=${IS_PACKAGED}  PORT=${PORT}  platform=${process.platform}`)
  log(`resourcesPath=${process.resourcesPath}`)

  getDb()
  setupAutoLaunch()
  startSyncEngine()
  createSplash()

  try {
    if (IS_PACKAGED) {
      log('Starting Next.js server...')
      await startNextServer()
      log('Next.js server started, waiting for HTTP...')
    }
    await waitForServer()
    log('Server responding — opening main window')
    createMainWindow()
    setupAutoUpdater()
  } catch (err: any) {
    fatalError(
      'Error al iniciar El Mercader POS',
      err?.message ?? String(err)
    )
  }
})

app.on('window-all-closed', () => {
  killNextServer()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) createMainWindow()
})

app.on('before-quit', () => {
  log('App quitting')
  globalShortcut.unregisterAll()
  stopSyncEngine()
  killNextServer()
  freePort(PORT)
  closeDb()
})
