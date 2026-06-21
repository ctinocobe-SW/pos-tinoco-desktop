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
    title: 'El Mercader del Bajío — POS (BETA)',
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

// Ancho del rollo térmico (Epson TM-T88V = 80mm de papel).
const TICKET_WIDTH_MM = 80

/**
 * Mide la altura real (en mm) del ticket ya renderizado en el DOM.
 * webContents.print() ignora las reglas @page del CSS, así que necesitamos
 * pasarle un pageSize explícito; si no, Electron usa el tamaño Carta/A4 del
 * driver de Windows y el ticket sale en una hoja gigante, desalineado a la
 * izquierda y sin adaptarse a la cantidad de productos.
 *
 * Devuelve el alto en milímetros (con un colchón inferior para el corte) o
 * null si no se pudo medir, en cuyo caso se cae al comportamiento anterior.
 */
async function measureTicketHeightMm(): Promise<number | null> {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  try {
    const px = (await mainWindow.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector('#ticket-print-portal .ticket-slip');
        if (!el) return 0;
        // IMPORTANTE: el portal está display:none en pantalla, así que mide 0.
        // NO tocamos el portal original (si lo ocultamos justo antes de imprimir,
        // webContents.print captura el DOM vacío → ticket en blanco). En su lugar
        // CLONAMOS el ticket en un contenedor temporal fuera de viewport, lo
        // medimos y lo borramos. El portal real queda intacto para imprimirse.
        const probe = document.createElement('div');
        probe.style.cssText =
          'position:absolute;left:-10000px;top:0;width:72mm;visibility:hidden;pointer-events:none;';
        const clone = el.cloneNode(true);
        clone.style.display = 'block';
        probe.appendChild(clone);
        document.body.appendChild(probe);
        const h = Math.ceil(clone.getBoundingClientRect().height || clone.scrollHeight || 0);
        document.body.removeChild(probe);
        return h;
      })()`,
      true,
    )) as number
    if (!px || px <= 0) return null
    // CSS px → mm a 96 dpi (1in = 96px = 25.4mm). +6mm de margen de corte.
    const mm = (px * 25.4) / 96 + 6
    return Math.max(mm, 40)
  } catch {
    return null
  }
}

/**
 * Espera, dentro del renderer, a que el ticket esté realmente listo para
 * imprimirse: portal montado, con altura > 0 y con el logo ya cargado.
 * Esta es la causa #1 del "ticket en blanco": webContents.print() captura el
 * DOM en el instante de la llamada, y si React aún no montó el portal (o la
 * imagen del logo no cargó), imprime una página vacía. Reintenta hasta ~3s.
 */
async function waitForTicketReady(): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  try {
    return (await mainWindow.webContents.executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 30; i++) {
          const el = document.querySelector('#ticket-print-portal .ticket-slip');
          if (el) {
            // Medir con un clon visible fuera de pantalla (el portal está display:none).
            const probe = document.createElement('div');
            probe.style.cssText = 'position:absolute;left:-10000px;top:0;width:72mm;visibility:hidden;';
            const clone = el.cloneNode(true);
            clone.style.display = 'block';
            probe.appendChild(clone);
            document.body.appendChild(probe);
            const h = clone.getBoundingClientRect().height || clone.scrollHeight || 0;
            document.body.removeChild(probe);
            // Esperar a que todas las imágenes del ticket terminen de cargar.
            const imgs = Array.from(el.querySelectorAll('img'));
            const imgsOk = imgs.every((im) => im.complete && im.naturalWidth > 0);
            if (h > 50 && imgsOk) return true;
          }
          await sleep(100);
        }
        return false;
      })()`,
      true,
    )) as boolean
  } catch {
    return false
  }
}

async function prepareTicketPrintLayout() {
  // El layout de impresión está definido en globals.css + @page ticket.
  // La medición de altura se hace en measureTicketHeightMm().
  if (!mainWindow || mainWindow.isDestroyed()) return
}

/**
 * Imprime el ticket en una BrowserWindow OCULTA y dedicada, en vez de imprimir
 * la ventana principal con CSS @media print (que dejaba el papel en blanco
 * aunque success=true). Recibe un documento HTML completo y autocontenido
 * (con sus <style> embebidos) generado por el renderer, lo carga vía data URL,
 * espera a que pinte y lo manda a imprimir en silencio.
 */
async function printHtmlInHiddenWindow(
  html: string,
  deviceName: string,
): Promise<{ ok: boolean; error?: string }> {
  let printWin: BrowserWindow | null = new BrowserWindow({
    // Una ventana 100% oculta (show:false) a veces NO pinta su contenido en
    // Chromium → se imprime el layout pero sin texto/imágenes (papel en blanco
    // con el tamaño correcto). La colocamos fuera de pantalla y "visible" para
    // forzar el pintado real, sin que el usuario la vea.
    show: false,
    x: -2000,
    y: -2000,
    width: 380,
    height: 1200,
    frame: false,
    skipTaskbar: true,
    webPreferences: { javascript: true, backgroundThrottling: false },
  })

  // Guardar una COPIA inspeccionable del último ticket (no se borra) para poder
  // abrirla en un navegador y verificar el HTML si algo sale mal.
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'ultimo-ticket.html'), html, 'utf-8')
  } catch { /* ignore */ }

  const tmpFile = path.join(app.getPath('temp'), `ticket-print-${Date.now()}.html`)
  try {
    fs.writeFileSync(tmpFile, html, 'utf-8')

    // Esperar a que la carga termine de verdad (evento), no un timeout a ciegas.
    const loaded = new Promise<void>((resolve) => {
      printWin!.webContents.once('did-finish-load', () => resolve())
    })
    await printWin.loadFile(tmpFile)
    await loaded
    // Mostrar fuera de pantalla y forzar pintado.
    printWin.showInactive()
    // Esperar a que el documento esté completo y haya pintado un par de frames.
    await printWin.webContents.executeJavaScript(
      `new Promise((resolve) => {
        const done = () => requestAnimationFrame(() => requestAnimationFrame(resolve));
        if (document.readyState === 'complete') done(); else window.addEventListener('load', done);
      })`,
      true,
    ).catch(() => {})
    await new Promise((r) => setTimeout(r, 600))

    return await new Promise((resolve) => {
      printWin!.webContents.print(
        {
          silent: true,
          printBackground: true,
          ...(deviceName ? { deviceName } : {}),
          margins: { marginType: 'none' },
        },
        (success, failureReason) => {
          log(`Resultado impresión (ventana dedicada): success=${success} reason=${failureReason ?? '-'}`)
          resolve(success ? { ok: true } : { ok: false, error: failureReason })
        },
      )
    })
  } catch (e) {
    log(`Error imprimiendo en ventana dedicada: ${String(e)}`)
    return { ok: false, error: String(e) }
  } finally {
    if (printWin && !printWin.isDestroyed()) printWin.destroy()
    printWin = null
    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
  }
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
      // Zona horaria fija para que las fechas del servidor sean siempre CDMX,
      // sin importar la configuración regional del equipo.
      TZ: 'America/Mexico_City',
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

// Impresión silenciosa (sin diálogo de Windows).
// El contenido a imprimir ya está aislado por el CSS @media print del ticket.
ipcMain.handle('print:silent', async (_event, html?: string) => {
  if (!mainWindow) return { ok: false, error: 'Ventana no disponible' }

  await prepareTicketPrintLayout()

  // Resolver explícitamente la impresora predeterminada y pasarla por deviceName.
  // (En Windows, silent sin deviceName a veces no llega al spooler correcto.)
  let deviceName = ''
  try {
    const printers = await mainWindow.webContents.getPrintersAsync()
    log(`Impresoras: ${printers.map((p) => `${p.name}${p.isDefault ? '(default)' : ''}`).join(', ') || 'ninguna'}`)
    const def = printers.find((p) => p.isDefault) ?? printers[0]
    if (def) deviceName = def.name
  } catch (e) {
    log(`Error listando impresoras: ${String(e)}`)
  }

  // RUTA PREFERIDA: si el renderer mandó el HTML del ticket, lo imprimimos en
  // una ventana oculta dedicada. Es mucho más fiable que imprimir la ventana
  // principal dependiendo del CSS @media print (que dejaba el papel en blanco).
  if (html && html.length > 0) {
    log(`Imprimiendo ticket en ventana dedicada (${html.length} bytes) → "${deviceName || 'predeterminada'}"`)
    return await printHtmlInHiddenWindow(html, deviceName)
  }

  // RUTA FALLBACK (sin HTML): método anterior sobre la ventana principal.
  const ready = await waitForTicketReady()
  log(`Ticket listo para imprimir: ${ready ? 'sí' : 'NO (se imprime de todos modos)'}`)

  // pageSize adaptativo (opt-in). El driver térmico de la TM-T88V a veces
  // DESCARTA el trabajo si se le impone un tamaño en mm (success=true pero papel
  // en blanco). Por eso por defecto NO forzamos pageSize y dejamos que el ticket
  // salga con el tamaño del rollo configurado en Windows (que ya es 80x297mm).
  // Para probar el alto adaptativo, arranca con TICKET_FORCE_PAGESIZE=1.
  let pageSize: { width: number; height: number } | undefined
  if (process.env.TICKET_FORCE_PAGESIZE === '1') {
    const heightMm = await measureTicketHeightMm()
    // pageSize de Electron se mide en MICRONES (1mm = 1000 micrones).
    if (heightMm) {
      pageSize = { width: Math.round(TICKET_WIDTH_MM * 1000), height: Math.round(heightMm * 1000) }
    }
    log(`pageSize adaptativo: ${pageSize ? `${TICKET_WIDTH_MM}x${heightMm!.toFixed(1)}mm` : 'medición falló → driver'}`)
  }

  log(`Imprimiendo en: "${deviceName || '(predeterminada del sistema)'}" — pageSize=${pageSize ? `${TICKET_WIDTH_MM}mm forzado` : '(driver de Windows 80x297)'}`)

  return await new Promise((resolve) => {
    mainWindow!.webContents.print(
      {
        silent: true,
        printBackground: true,
        ...(deviceName ? { deviceName } : {}),
        margins: { marginType: 'none' },
        // pageSize explícito en micrones: ancho del rollo (80mm) + alto medido
        // del contenido. Esto centra el ticket en el rollo y lo ajusta al número
        // de productos. Si la medición falla, se omite y se usa el driver.
        ...(pageSize ? { pageSize } : {}),
      },
      (success, failureReason) => {
        log(`Resultado impresión: success=${success} reason=${failureReason ?? '-'}`)
        resolve(success ? { ok: true, deviceName } : { ok: false, error: failureReason })
      },
    )
  })
})

// Impresión RAW (ESC/POS) directa al spooler de Windows. La térmica TM-T88V no
// rasteriza bien el HTML vía webContents.print() (papel en blanco aunque
// success=true), pero SÍ imprime comandos ESC/POS nativos. Recibe los bytes en
// base64, los escribe a un archivo y los manda RAW con PowerShell + Win32
// (winspool), sin dependencias nativas.
ipcMain.handle('print:raw', async (_event, base64: string, printerName?: string) => {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'print:raw solo está disponible en Windows' }
  }
  if (!base64) return { ok: false, error: 'Sin datos para imprimir' }

  // Resolver impresora: la indicada, o la predeterminada del sistema.
  let device = printerName ?? ''
  if (!device && mainWindow) {
    try {
      const printers = await mainWindow.webContents.getPrintersAsync()
      const def = printers.find((p) => p.isDefault) ?? printers[0]
      if (def) device = def.name
    } catch { /* ignore */ }
  }
  if (!device) return { ok: false, error: 'No se encontró impresora' }

  const dataFile = path.join(app.getPath('temp'), `ticket-raw-${Date.now()}.bin`)
  const ps1File = path.join(app.getPath('temp'), `ticket-raw-${Date.now()}.ps1`)
  try {
    fs.writeFileSync(dataFile, Buffer.from(base64, 'base64'))

    // Script PowerShell con DOS estrategias:
    //   1) Escribir los bytes DIRECTO al puerto de la impresora (USB00x / COM /
    //      IP). Esto EVITA el driver Epson APD, que descarta el ESC/POS crudo
    //      (papel en blanco aunque el spooler diga OK). Es lo que de verdad
    //      hace falta con el driver oficial instalado.
    //   2) Si no se puede resolver/abrir el puerto, caer al método winspool RAW.
    const script = `
$ErrorActionPreference = 'Stop'
$printer = @'
${device}
'@
$path = @'
${dataFile}
'@
$bytes = [System.IO.File]::ReadAllBytes($path)

function Write-ToPort($portName, $data) {
  if ($portName -match '^(USB|LPT|ESDPRT)\\d+') {
    # Puerto USB/LPT/ESDPRT: abrir el dispositivo del puerto por su nombre Win32.
    $fs = New-Object System.IO.FileStream("\\\\.\\$portName", [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write)
    try { $fs.Write($data, 0, $data.Length); $fs.Flush() } finally { $fs.Close() }
    return $true
  }
  if ($portName -match '^COM\\d+') {
    $sp = New-Object System.IO.Ports.SerialPort($portName, 9600)
    $sp.Open(); try { $sp.Write($data, 0, $data.Length) } finally { $sp.Close() }
    return $true
  }
  # Puerto IP (impresora de red): TCP al 9100.
  if ($portName -match '^(\\d{1,3}\\.){3}\\d{1,3}') {
    $ip = ($portName -split ':')[0]
    $client = New-Object System.Net.Sockets.TcpClient($ip, 9100)
    $stream = $client.GetStream()
    try { $stream.Write($data, 0, $data.Length); $stream.Flush() } finally { $stream.Close(); $client.Close() }
    return $true
  }
  return $false
}

# Resolver el puerto real de la impresora.
$port = $null
try { $port = (Get-Printer -Name $printer -ErrorAction Stop).PortName } catch {}
if (-not $port) {
  try { $port = (Get-WmiObject -Class Win32_Printer -Filter "Name='$($printer.Replace("'","''"))'").PortName } catch {}
}
Write-Output ("PORT=" + $port)

$sentDirect = $false
if ($port) {
  try { $sentDirect = Write-ToPort $port $bytes } catch { Write-Output ("PORTERR=" + $_.Exception.Message) }
}

if ($sentDirect) {
  Write-Output 'OK-PORT'
} else {
  # Fallback: winspool RAW (puede que el driver lo descarte, pero lo intentamos).
  $src = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFOA { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)] public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)] public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
  public static void Send(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) throw new Exception("OpenPrinter: " + Marshal.GetLastWin32Error());
    try {
      DOCINFOA di = new DOCINFOA(); di.pDocName = "Ticket POS"; di.pDataType = "RAW";
      if (!StartDocPrinter(hPrinter, 1, ref di)) throw new Exception("StartDocPrinter: " + Marshal.GetLastWin32Error());
      StartPagePrinter(hPrinter);
      int written; WritePrinter(hPrinter, bytes, bytes.Length, out written);
      EndPagePrinter(hPrinter); EndDocPrinter(hPrinter);
    } finally { ClosePrinter(hPrinter); }
  }
}
"@
  Add-Type -TypeDefinition $src -Language CSharp
  [RawPrinter]::Send($printer, $bytes)
  Write-Output 'OK-SPOOL'
}
`
    fs.writeFileSync(ps1File, script, 'utf-8')
    log(`print:raw → enviando ${Buffer.from(base64, 'base64').length} bytes a "${device}"`)

    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1File])
      let out = '', err = ''
      ps.stdout.on('data', (d) => { out += d.toString() })
      ps.stderr.on('data', (d) => { err += d.toString() })
      ps.on('close', (code) => {
        log(`print:raw resultado: code=${code} out=${out.trim().replace(/\s+/g, ' ')} err=${err.trim().replace(/\s+/g, ' ')}`)
        // OK-PORT = se escribió directo al puerto (evita el driver, lo ideal).
        // OK-SPOOL = se usó winspool RAW (puede que el driver lo descarte).
        if (code === 0 && /OK-PORT|OK-SPOOL/.test(out)) resolve({ ok: true })
        else resolve({ ok: false, error: err.trim() || `PowerShell salió con código ${code}` })
      })
    })
    return result
  } catch (e) {
    log(`print:raw error: ${String(e)}`)
    return { ok: false, error: String(e) }
  } finally {
    try { fs.unlinkSync(dataFile) } catch { /* ignore */ }
    try { fs.unlinkSync(ps1File) } catch { /* ignore */ }
  }
})

// Lista de impresoras disponibles (por si luego se quiere elegir una).
ipcMain.handle('print:listPrinters', async () => {
  if (!mainWindow) return []
  try {
    return await mainWindow.webContents.getPrintersAsync()
  } catch {
    return []
  }
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
