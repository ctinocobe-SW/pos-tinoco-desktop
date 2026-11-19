import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const limiteBytes = 4 * 1024 * 1024
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

export function idValido(id: unknown): id is string {
  return typeof id === 'string' && uuid.test(id)
}

export function usuarioRespaldo(cookie: string | undefined, secreto: string | undefined) {
  if (!cookie || !secreto || secreto.length < 32) return null
  try {
    const [version, datos, firma, extra] = cookie.split('.')
    if (version !== 'v2' || extra !== undefined) return null
    const bytes = Buffer.from(firma, 'base64url')
    const esperada = createHmac('sha256', 'offline-session:' + secreto).update(`${version}.${datos}`).digest()
    if (bytes.length !== esperada.length || !timingSafeEqual(bytes, esperada)) return null
    const { sub, rol, exp, iat } = JSON.parse(Buffer.from(datos, 'base64url').toString())
    const ahora = Math.floor(Date.now() / 1000)
    return idValido(sub) && rol === 'admin' && Number.isFinite(iat) && iat <= ahora + 60
      && Number.isFinite(exp) && exp > ahora ? sub : null
  } catch { return null }
}

interface Registro {
  id: string
  usuario_id: string
  almacen_id: string
  estado: 'pendiente' | 'sincronizada'
  payload: { cobro_id: string; captura: { despachador_id?: string } }
}

function validarRegistro(valor: unknown, usuario: string, almacen: string): valor is Registro {
  const v = valor as Partial<Registro> | null
  return !!v && idValido(v.id) && v.usuario_id === usuario && v.almacen_id === almacen
    && idValido(v.payload?.cobro_id) && !!v.payload?.captura
    && (v.estado === 'sincronizada' || v.estado === 'pendiente')
}

export function crearRespaldoVentas(directorio: string, cifrar: (datos: string) => Buffer, descifrar: (datos: Buffer) => string) {
  let ultimaEscritura = Promise.resolve()
  async function leer(archivo: string, usuario: string, almacen: string) {
    if ((await stat(archivo)).size > limiteBytes) throw new Error('Respaldo demasiado grande')
    const registro: unknown = JSON.parse(descifrar(await readFile(archivo)))
    if (!validarRegistro(registro, usuario, almacen)) throw new Error('Respaldo inválido')
    return registro
  }

  function guardar(usuario: string, almacen: string, registro: unknown) {
    const tarea = ultimaEscritura.then(async () => {
      if (!idValido(usuario) || !idValido(almacen) || !validarRegistro(registro, usuario, almacen)) {
        throw new Error('Venta inválida para respaldo')
      }
      const destino = join(directorio, usuario, almacen)
      const archivo = join(destino, `${registro.id}.venta`)
      const datos = JSON.stringify(registro)
      if (Buffer.byteLength(datos) >= limiteBytes) throw new Error('Venta demasiado grande para el respaldo')
      let anterior: Registro | undefined
      try { anterior = await leer(archivo, usuario, almacen) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (anterior) {
        if (anterior.payload.cobro_id !== registro.payload.cobro_id) throw new Error('Respaldo con un cobro distinto')
        const previo = anterior.payload.captura.despachador_id
        const siguiente = registro.payload.captura.despachador_id
        if (previo && siguiente && previo !== siguiente) throw new Error('Respaldo con una asignación distinta')
        if (anterior.estado === 'sincronizada' || (previo && !siguiente) || isDeepStrictEqual(anterior, JSON.parse(datos))) return
      }
      const protegido = cifrar(datos)
      if (protegido.length > limiteBytes) throw new Error('Venta demasiado grande para el respaldo')
      await mkdir(destino, { recursive: true, mode: 0o700 })
      const temporal = join(destino, `${randomUUID()}.tmp`)
      try {
        const handle = await open(temporal, 'wx', 0o600)
        try { await handle.writeFile(protegido); await handle.sync() }
        finally { await handle.close() }
        await rename(temporal, archivo)
      } finally { await rm(temporal, { force: true }).catch(() => {}) }
    })
    ultimaEscritura = tarea.catch(() => {})
    return tarea
  }

  async function listar(usuario: string, almacen: string) {
    if (!idValido(usuario) || !idValido(almacen)) throw new Error('Sucursal inválida')
    const destino = join(directorio, usuario, almacen)
    let archivos: string[]
    try { archivos = await readdir(destino) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { registros: [], omitidos: 0 }
      throw error
    }
    const registros: Registro[] = []
    let omitidos = 0
    for (const archivo of archivos) {
      if (!archivo.endsWith('.venta') || !idValido(archivo.slice(0, -6))) continue
      try {
        const registro = await leer(join(destino, archivo), usuario, almacen)
        if (archivo !== `${registro.id}.venta`) throw new Error('Folio inválido')
        registros.push(registro)
      } catch { omitidos++ }
    }
    return { registros, omitidos }
  }

  return { guardar, listar }
}
