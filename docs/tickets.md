# Tickets ImpeBot e impecraft-web

ImpeBot atiende tickets por WhatsApp y canales privados de Discord. Conserva el relay de grupos y los comandos de stickers. Los privados ya no crean canales `dm-*` ni reenvían el chat libre de Discord cuando `TICKETS_ENABLED=true`.

## Activación

Requiere Node.js 24 LTS, MariaDB y el bot de Discord instalado con los scopes `bot` y `applications.commands`. Configura `DISCORD_GUILD_ID`, `DISCORD_BOT_TOKEN` y `TICKETS_STAFF_ROLE_IDS` (IDs separados por coma). El bot necesita ver/enviar mensajes, adjuntar archivos, leer historial y administrar canales. Los permisos del relay de grupos siguen siendo los existentes.

`TICKETS_ENABLED=true` activa soporte en privados. Si no indicas roles de soporte, solo quienes tienen **Administrar servidor** pueden usar los comandos. `TICKETS_CATEGORY_ID` es opcional; cada canal se crea con permisos explícitos que ocultan el ticket a `@everyone`. Los administradores de Discord conservan su acceso habitual.

El bot crea las tablas `support_tickets`, `support_messages`, `support_routes`, `support_deliveries`, `support_guild_configs`, `support_categories`, `support_panels` y `support_participants` al iniciar, y migra las de versiones anteriores sin perder datos (`owner_jid` pasa a admitir nulos y el índice único `uk_support_active_owner` se sustituye por un límite comprobado en la apertura). Necesita la base disponible antes de abrir los transportes. No modifica registros del relay ni importa sus mensajes privados antiguos como tickets.

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

El chat normal permanece en Discord. Solo `/nota` lo incorpora como nota al historial. Las respuestas de comandos son privadas para quien los ejecuta. Los canales de tickets cerrados se conservan para auditoría. No los vincules manualmente a `channel_mappings`. En los tickets abiertos desde Discord el chat del canal sí es la conversación (ver más abajo).

Los adjuntos de WhatsApp se envían al canal privado, y su enlace de Discord se guarda en el mensaje. Los archivos enviados con `/responder` se muestran al jugador como enlaces. No se suben adjuntos de soporte a Catbox. Los enlaces CDN de Discord pueden caducar; esto no es un archivo permanente de evidencias. Las eliminaciones de WhatsApp no borran el historial del ticket.

## Tickets abiertos desde Discord

Funcionan en `DISCORD_GUILD_ID` y en cada servidor de `DISCORD_EXTRA_GUILD_IDS`, con configuración propia por servidor guardada en la MariaDB del bot (también en modo web). Los comandos `/ticket` se registran en todos esos servidores.

### Configuración (Gestionar servidor o `impebot.tickets.admin`)

- `/ticket config ver` · `/ticket config editar`: categoría de canales por defecto, canal de logs y transcripciones, formato (`html`/`txt`), máximo de tickets abiertos por usuario en ese servidor (3 por defecto), roles de staff globales del servidor, prefijo de prioridad en el nombre del canal, segundos antes de borrar un canal y, en modo web, `requerir_web`.
- `/ticket categoria crear|editar|eliminar|listar`: cada categoría tiene nombre, emoji, estilo de botón, descripción, una **base** (`soporte`, `compra`, `reporte`, `apelacion`, `bug`, `otro`: la que se guarda en la web), categoría de Discord propia, roles de staff, prioridad inicial, mención de roles y mensaje de bienvenida. Máximo 25 por servidor.
- `/ticket panel enviar canal titulo descripcion [modo] [color] [categorias]`: publica un panel con botones o menú desplegable. `/ticket panel actualizar message_id ...` lo edita. Los paneles se actualizan solos al cambiar categorías.

### Apertura y conversación

El jugador pulsa un botón (o elige en el menú), rellena asunto y descripción y el bot crea un canal privado visible para él, el bot y los roles de staff (los del servidor + los de la categoría; en el servidor principal también `TICKETS_STAFF_ROLE_IDS`). Exige `impebot.tickets.use` (libre salvo que LuckPerms lo niegue) y no permite superar el máximo de tickets abiertos.

En estos canales el jugador escribe directamente: sus mensajes y los del staff se guardan en el historial (con los enlaces de los adjuntos) y no se vuelven a publicar. Si el jugador tiene WhatsApp vinculado, las respuestas del staff también le llegan allí. Los invitados añadidos con `/ticket add` hablan en el canal pero no se guardan en el historial. **`/nota` nunca se publica en estos canales**: se guarda como nota interna y solo se confirma en privado al staff.

En modo web el jugador debe tener Discord vinculado en **Mi cuenta** de la web; el ticket es nativo de la web (misma numeración). Si un servidor pone `requerir_web` en `false`, quien no esté vinculado obtiene un ticket local del bot (numeración propia, no visible en la web).

### Mensaje de control

Cada canal de ticket (también los de WhatsApp y web) tiene un mensaje fijado con estado, prioridad, categoría, creador, responsable y origen, que se edita al cambiar. Botones: **Tomar/Soltar**, **Cerrar**, **Transcripción**; cerrado: **Reabrir**, **Transcripción**, **Borrar** (pide confirmación y solo funciona con el ticket cerrado). Selector de prioridad: actualiza el embed, cambia el prefijo del canal (🟢 🔵 🟠 🔴; como máximo una vez cada 5 minutos por el límite de Discord, sin bloquear el botón) y, al pasar a alta o urgente, menciona solo a los roles de staff si la categoría lo tiene activado.

Cerrar lo puede hacer el creador o el staff; el resto de controles solo el staff (roles del servidor o de la categoría, Gestionar servidor o `impebot.tickets.staff`; con LuckPerms activo manda el permiso). Al cerrar un ticket de Discord, el jugador y los invitados dejan de poder escribir (siguen leyendo) y la transcripción se envía al canal de logs; al reabrir recuperan la escritura. Borrar envía la transcripción, marca la ruta como borrada (el sondeo no la recrea) y elimina el canal tras la espera configurada.

### Dentro de un canal de ticket (staff)

- `/ticket add [usuario] [rol]` · `/ticket remove [usuario] [rol]`: dan o quitan acceso; nunca quitan al creador ni al bot.
- `/ticket transcripcion`: sube la transcripción al canal de logs.
- `/ticket renombrar nombre`.

Las transcripciones HTML escapan todo el contenido y solo enlazan adjuntos `http(s)`; incluyen hasta 2000 mensajes.

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
