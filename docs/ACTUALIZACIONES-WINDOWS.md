# Preparación de actualizaciones Windows

## Flujo preparado

El workflow `windows-draft.yml` se inicia manualmente desde Actions tras fusionarlo en la rama por defecto. Recibe una versión nueva (ej. `1.1.70`) y un SHA completo del código web revisado. Compila la web con Node.js 22, empaqueta Electron para Windows y sube instalador, blockmap y latest.yml a un Release EN BORRADOR. No publica tags por un push normal, no instala nada en el cliente y no modifica Supabase.

El updater ya existente consulta GitHub Releases cuando inicia el programa. Un borrador no se anuncia a las instalaciones del cliente. Publicarlo es un paso separado tras validación. No publicar el borrador generado hasta resolver el punto de credenciales descrito abajo.

## Configuración de GitHub pendiente

En `ctinocobe-SW/pos-tinoco-desktop`:

- Actions secret `POS_SOURCE_READ_TOKEN`: token de acceso limitado a Contents: Read del repositorio privado `ctinocobe-SW/Tinoco-POS`. No incluirlo en el programa. La conexión de GitHub de Codex no se transfiere a los runners de Actions.
- Actions variables `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`: configuración pública de Supabase. Para las primeras pruebas usar un proyecto de prueba.
- El workflow emplea su `GITHUB_TOKEN` efímero para escribir el Release de ESTE repositorio. No pide un token personal con escritura general.
- Confirmar disponibilidad/costo de runners Windows y permisos de Actions en la cuenta. No se ha contratado un plan ni ejecutado un runner en esta preparación.

La versión debe superar tanto la del código como la última versión estable publicada; revisar Releases antes de ejecutar. Si ya existe el tag, la creación falla sin sobrescribirlo. El SHA exacto del escritorio se registra junto al de la web en las notas del borrador.

## Pendiente que impide entregar este borrador a producción

El programa local actual usa `SUPABASE_SERVICE_ROLE_KEY` para acciones administrativas, y su motor SQLite usa `SUPABASE_SERVICE_KEY`. Una llave maestra dentro de un instalador puede extraerse. El workflow NO recibe ni empaqueta esas llaves. Las operaciones que las requieren no estarán disponibles en el instalador de prueba; no confundir éxito de compilación con equivalencia funcional de producción.

Antes de publicar al cliente, mover esas operaciones a un backend protegido (por ejemplo, la web desplegada en Cloudflare) con validación de identidad y rol, adaptar la comunicación del escritorio y comprobar sus operaciones offline. No reemplazar simplemente la URL de la ventana por la web: cambiaría el comportamiento sin conexión.

También se deben corregir los problemas de sincronización y autenticación offline identificados en la evaluación. Son cambios funcionales separados de la preparación del pipeline.

## Pruebas obligatorias antes de publicar

En un Windows de prueba con perfil y base separados del negocio:

1. Instalación limpia, inicio, acceso y permisos por rol.
2. Crear, aprobar y cobrar un ticket; revisar inventario.
3. Impresión con la impresora térmica real.
4. Pérdida/restablecimiento de red; reinicio con ventas pendientes; ausencia de duplicados.
5. Actualización desde la versión instalada del cliente; persistencia del archivo SQLite y borradores.
6. Verificar firma del instalador y comportamiento de Windows/SmartScreen. Este workflow no configura certificado de firma.
7. Revisar contenido del paquete para confirmar que no contiene llaves privilegiadas, tokens ni datos personales de prueba.

Publicar el Release solo después de superar estas pruebas. El updater descarga al iniciar, y solicita reinicio cuando termina; no es una modificación instantánea del proceso que está ejecutándose.

## Recuperación

No intentar revertir publicando una versión numérica menor: el updater no la ofrecerá como actualización. Corregir y publicar una versión superior, o reinstalar de forma controlada con respaldo previo. No borrar `userData` ni la base local durante la actualización.
