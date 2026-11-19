const assert = require('node:assert/strict')
const { createHmac, createCipheriv, createDecipheriv, randomBytes, randomUUID } = require('node:crypto')
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { crearRespaldoVentas, usuarioRespaldo } = require('../electron-dist/db/respaldo-ventas.js')

async function main() {
  const usuario = randomUUID(), almacen = randomUUID(), otraSucursal = randomUUID(), id = randomUUID()
  const secreto = randomBytes(48).toString('hex')
  const ahora = Math.floor(Date.now() / 1000)
  const cookie = datos => {
    const base = 'v2.' + Buffer.from(JSON.stringify(datos)).toString('base64url')
    return `${base}.${createHmac('sha256', 'offline-session:' + secreto).update(base).digest('base64url')}`
  }
  const sesion = { sub: usuario, rol: 'admin', iat: ahora, exp: ahora + 300 }
  assert.equal(usuarioRespaldo(cookie(sesion), secreto), usuario)
  assert.equal(usuarioRespaldo(cookie(sesion), secreto.repeat(2)), null)
  assert.equal(usuarioRespaldo(cookie({ ...sesion, rol: 'despachador' }), secreto), null)
  assert.equal(usuarioRespaldo(cookie({ ...sesion, exp: ahora - 1 }), secreto), null)

  const carpeta = await mkdtemp(join(tmpdir(), 'mercader-respaldo-'))
  try {
    const clave = randomBytes(32)
    const cifrar = datos => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', clave, iv)
      return Buffer.concat([iv, cipher.update(datos), cipher.final(), cipher.getAuthTag()])
    }
    const descifrar = datos => {
      const decipher = createDecipheriv('aes-256-gcm', clave, datos.subarray(0, 12))
      decipher.setAuthTag(datos.subarray(-16))
      return Buffer.concat([decipher.update(datos.subarray(12, -16)), decipher.final()]).toString()
    }
    const respaldo = crearRespaldoVentas(carpeta, cifrar, descifrar)
    const registro = { id, usuario_id: usuario, almacen_id: almacen, estado: 'pendiente',
      payload: { cobro_id: randomUUID(), captura: {} }, comprobante: { cliente_nombre: 'Cliente de prueba' } }
    const despachador_id = randomUUID()
    const conDespachador = { ...registro, payload: { ...registro.payload, captura: { despachador_id } } }
    const confirmada = { ...conDespachador, estado: 'sincronizada', folio_servidor: 'T-1' }
    await Promise.all([registro, conDespachador, registro, confirmada, registro].map(r => respaldo.guardar(usuario, almacen, r)))
    const ruta = join(carpeta, usuario, almacen, `${id}.venta`)
    assert.deepEqual(await readdir(join(carpeta, usuario, almacen)), [`${id}.venta`])
    assert.equal((await readFile(ruta)).includes(Buffer.from('Cliente de prueba')), false)
    assert.deepEqual((await crearRespaldoVentas(carpeta, cifrar, descifrar).listar(usuario, almacen)).registros, [confirmada])
    assert.deepEqual(await respaldo.listar(usuario, otraSucursal), { registros: [], omitidos: 0 })
    await assert.rejects(respaldo.guardar(usuario, otraSucursal, registro), /inválida/)
    await assert.rejects(respaldo.guardar(usuario, almacen, { ...registro, payload: { ...registro.payload, cobro_id: randomUUID() } }), /distinto/)
    await writeFile(join(carpeta, usuario, almacen, `${randomUUID()}.venta`), 'dañado')
    const alRecuperar = await respaldo.listar(usuario, almacen)
    assert.deepEqual(alRecuperar, { registros: [confirmada], omitidos: 1 })
    console.log('PASS respaldo en disco, acceso local de administrador, aislamiento de sucursal, concurrencia y lectura tras reinicio')
  } finally { await rm(carpeta, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
