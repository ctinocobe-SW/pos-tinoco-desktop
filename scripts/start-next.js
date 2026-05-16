// Script de desarrollo: arranca Next.js desde el proyecto web hermano
const { spawn } = require('child_process')
const path = require('path')

const webDir = path.join(__dirname, '..', '..', 'pos-tinoco')
const next = spawn('npm', ['run', 'dev'], { cwd: webDir, stdio: 'inherit', shell: true })

next.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => next.kill())
process.on('SIGTERM', () => next.kill())
