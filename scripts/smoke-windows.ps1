$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot '../dist/win-unpacked/El Mercader POS.exe'
if (-not (Test-Path $exe)) { throw 'Falta la aplicación Windows empaquetada' }
$appProcess = Start-Process -FilePath (Resolve-Path $exe) -ArgumentList '--disable-gpu' -PassThru
try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Seconds 1
    if ($appProcess.HasExited) { throw "La aplicación terminó antes de iniciar: $($appProcess.ExitCode)" }
    try {
      $response = Invoke-WebRequest 'http://127.0.0.1:3000/login' -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -eq 200 -and $response.Content -match 'Iniciar|Mercader|sesión') { $ready = $true; break }
    } catch { }
  }
  if (-not $ready) { throw 'El paquete Windows no respondió con la pantalla de acceso' }
  $logFile = Join-Path $env:APPDATA 'pos-tinoco-desktop/startup.log'
  if (-not (Test-Path $logFile)) { throw 'No se generó startup.log' }
  $log = Get-Content $logFile -Raw
  if ($log -notmatch 'Server responding') { throw 'Electron no confirmó el arranque del servidor local' }
  if ($log -match 'FATAL:|NODE_MODULE_VERSION|not a valid Win32') { throw 'Error de arranque o módulo nativo incompatible' }
  Write-Output 'PASS Windows: Electron empaquetado, SQLite nativo y pantalla de acceso HTTP 200.'
} finally {
  & taskkill.exe /PID $appProcess.Id /T /F 2>$null | Out-Null
}
