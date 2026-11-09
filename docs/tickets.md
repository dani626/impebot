# Tickets ImpeBot e impecraft-web

ImpeBot atiende tickets por WhatsApp y canales privados de Discord. Conserva el relay de grupos y los comandos de stickers. Los privados ya no crean canales `dm-*` ni reenvían el chat libre de Discord cuando `TICKETS_ENABLED=true`.

## Activación

Requiere Node.js 24 LTS, MariaDB y el bot de Discord instalado con los scopes `bot` y `applications.commands`. Configura `DISCORD_GUILD_ID`, `DISCORD_BOT_TOKEN` y `TICKETS_STAFF_ROLE_IDS` (IDs separados por coma). El bot necesita ver/enviar mensajes, adjuntar archivos, leer historial y administrar canales. Los permisos del relay de grupos siguen siendo los existentes.

`TICKETS_ENABLED=true` activa soporte en privados. Si no indicas roles de soporte, solo quienes tienen **Administrar servidor** pueden usar los comandos. `TICKETS_CATEGORY_ID` es opcional; cada canal se crea con permisos explícitos que ocultan el ticket a `@everyone`. Los administradores de Discord conservan su acceso habitual.

El bot crea tablas nuevas `support_tickets`, `support_messages`, `support_routes` y `support_deliveries` al iniciar. Necesita la base disponible antes de abrir los transportes. No modifica registros del relay ni importa sus mensajes privados antiguos como tickets.

### Modo local

Deja vacíos `IMPECRAFT_WEB_URL` e `IMPECRAFT_BOT_TOKEN`. MariaDB del bot conserva tickets e historial. Se permite un ticket abierto por contacto. La primera respuesta pública asigna el caso a su autor. `OPEN` espera al staff; `PENDING` espera al jugador; `CLOSED` conserva el historial y bloquea nuevas respuestas hasta reabrir.

### Modo web

Instala el módulo incluido en `integrations/impecraft-web`. Está preparado para el frontend Next.js de `C:/proyectos/pagina web/impecraft/frontend`, comprobado contra sus modelos y validadores actuales. No usa el antiguo backend Go ni sesiones personales como credencial de servicio.

Desde la raíz del bot:

```powershell
node scripts/install-impecraft-web.js --target 'C:\proyectos\pagina web\impecraft\frontend' --check
node scripts/install-impecraft-web.js --target 'C:\proyectos\pagina web\impecraft\frontend'
```

El instalador copia rutas/componentes nuevos, añade modelos Prisma y un enlace en Mi cuenta. Respalda todos los archivos existentes afectados en `.impebot-backups/<fecha>/` antes de escribir. No cambia `.env`, no inicia servicios y no ejecuta migraciones. `--check` solo muestra los cambios pendientes. Una segunda instalación con las mismas fuentes no duplica modelos ni enlaces.

En la web, aplica la migración **después de tu respaldo habitual de la base** y regenera el cliente:

```powershell
npm.cmd run db:migrate
npx.cmd prisma generate
```

Configura `IMPECRAFT_BOT_TOKEN` con el mismo secreto aleatorio de al menos 32 caracteres en los dos `.env`. En el bot añade `IMPECRAFT_WEB_URL=https://tu-web` (sin `/api`). Se permite HTTP únicamente para localhost. Reinicia las aplicaciones después de configurar. No uses el token de Discord ni una sesión JWT como secreto del puente.

En este modo, los tickets, mensajes, estados, prioridades y responsables son los nativos de la web; las tablas del bot solo conservan punteros y entregas. No se escribe directamente en la base de datos de la web desde el bot. Una caída de la API no cambia automáticamente al modo local.

El jugador entra en **Mi cuenta → WhatsApp**, genera un código y envía `!vincular CODIGO` al bot por privado. El código dura 10 minutos, se consume una vez y la base solo conserva su hash. Hasta vincularse no puede crear ni consultar tickets por WhatsApp. Puede desvincular el número desde esa misma página. No se infiere la identidad por el nick o el número escrito en un mensaje.

El staff vincula Discord mediante el OAuth que ya existe en **Mi cuenta**. Cada operación del bot comprueba además el rol actual de esa cuenta en la web y el requisito de 2FA. Tener un rol de soporte en Discord no concede permisos de staff en la web. Un helper puede tomar casos o soltar los propios; la reasignación a terceros se conserva en el panel de moderadores de la web.

Los casos nuevos de la web también aparecen en Discord. Los cerrados sin canal previo se quedan en el historial de la web. El sondeo recorre páginas de 50 casos cada 15 segundos por defecto; se puede ajustar `TICKETS_POLL_INTERVAL_MS` (mínimo 5 segundos). Está pensado para una única instancia del bot y un volumen pequeño de soporte. Los tickets locales anteriores no se migran automáticamente al activar la web.

## Uso por WhatsApp

- `!ticket`: pregunta categoría, asunto y descripción. La apertura guiada vence a los 10 minutos y se cancela con `!cancelar`; no sobrevive al reinicio.
- `!ticket soporte | No puedo entrar | Descripción del problema`: apertura directa.
- Categorías: `soporte`, `compra`, `reporte`, `apelacion`, `bug`, `otro`.
- `!tickets`: lista tus últimos 20 casos.
- Con un solo caso abierto, escribir por privado agrega mensajes a ese caso.
- `!responder 123 | Mi respuesta`: elige el caso cuando tienes varios abiertos en la web.
- `!cerrar 123`: cierra un caso propio; con un único caso activo basta `!cerrar`.

Los prefijos `/` y `.` también funcionan. Los comandos históricos de más de tres minutos no abren ni cierran casos. Los mensajes normales recuperados se procesan con deduplicación. En modo web se conservan el máximo de tres casos abiertos y la prioridad alta de los problemas con compras. Para asociar pedidos o sanciones concretas, usa los formularios de la web con sus verificaciones.

## Atención desde Discord

- `/responder mensaje [archivo]`: respuesta visible para el jugador y persistida en el historial.
- `/nota mensaje`: nota interna; solo staff.
- `/tomar`, `/soltar`: asignación.
- `/cerrar`, `/reabrir`: ciclo de vida.
- `/prioridad valor`: `LOW`, `NORMAL`, `HIGH`, `URGENT`.

El chat normal permanece en Discord. Solo `/nota` lo incorpora como nota al historial. Las respuestas de comandos son privadas para quien los ejecuta. Los canales de tickets cerrados se conservan para auditoría. No los vincules manualmente a `channel_mappings`.

Los adjuntos de WhatsApp se envían al canal privado, y su enlace de Discord se guarda en el mensaje. Los archivos enviados con `/responder` se muestran al jugador como enlaces. No se suben adjuntos de soporte a Catbox. Los enlaces CDN de Discord pueden caducar; esto no es un archivo permanente de evidencias. Las eliminaciones de WhatsApp no borran el historial del ticket.

## Recuperación y límites

Los mensajes entrantes y las entregas confirmadas tienen identificadores persistentes. Si WhatsApp está desconectado, los mensajes públicos nuevos quedan pendientes para el siguiente sondeo; las notas y los mensajes del dueño nunca se envían al jugador. Al vincular un número no se reproduce el historial anterior a esa vinculación.

La entrega externa y el guardado de su confirmación no forman una transacción: si el proceso cae exactamente entre ambos, podría repetir una notificación o un archivo. No se promete entrega exactamente una vez. Si una operación web agota su tiempo de espera, consulta el estado antes de repetir manualmente un comando de Discord.

No ejecutes varias instancias sobre los mismos tickets: los bloqueos de canales/colas son del proceso. Si borras un canal de ticket de Discord, conserva el historial y repara su `support_routes` con el bot detenido antes de reanudar; el sondeo informa el error y continúa con los demás casos.

## Verificación reproducible

```powershell
npm.cmd test
node scripts/check-web-integration.js 'C:\proyectos\pagina web\impecraft\frontend'
node scripts/run-db-tests.js --mariadb-bin 'C:\ruta\mariadb\bin' --web-root 'C:\proyectos\pagina web\impecraft\frontend'
```

La primera orden prueba la lógica con transportes simulados. La segunda usa los tipos reales de la web sin modificarla. La tercera inicia una MariaDB temporal en loopback y puerto libre, aplica las migraciones en bases de prueba, prueba persistencia y el puente con Prisma, y cierra/elimina esa instancia. No conecta WhatsApp ni Discord ni usa las bases configuradas de producción.
