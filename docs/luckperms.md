# Permisos con LuckPerms

El bot se conecta directamente a la base MySQL de LuckPerms y funciona como un servidor más de la red:

- **Identidad**: cada jugador se reconoce por su meta `whatsapp` o `discord`.
- **Permisos**: con LuckPerms activo, **todos los comandos exigen su permiso `impebot.*`**, como un plugin. La única excepción es `!vincular` (y `!verificar`, `!link`, `!verify`), que es como el jugador se identifica.
- **Sincronización**: el bot lee `luckperms_messenger` (messaging service SQL) cada segundo. Cuando alguien cambia un rango en el juego, el bot lo nota en 1–2 s. Lo que escribe el bot (vincular cuentas) se anuncia igual que lo haría un servidor, y toda la red lo recarga al momento.

Si LuckPerms está desactivado o no responde, el bot vuelve a las reglas de antes: stickers, ayuda, música y tickets libres; moderación para admins del grupo; tickets de staff y `/espejo` para Gestionar servidor o el rol de soporte. Así una caída de la base no deja a nadie sin bot.

`WA_STAFF_IDS` siempre puede usar todo (acceso de emergencia).

## Requisitos de la red

1. **Todos los servidores en la misma base MySQL** (`storage-method: MySQL`) y con `messaging-service: sql`. Un servidor con H2 tiene sus propios rangos, y ni el bot ni el resto de la red los ven.
2. Cada servidor con su `server:` propio en `config.yml` (`lobby`, `survivalop`...). Los permisos del bot se dan **globales** o con `server=impebot`.

Para pasar un servidor de H2 a MySQL sin que sus permisos se apliquen en otros servidores:

```bash
# 1. En la consola del servidor:  lp export antes
# 2. Añadir server=<nombre> a todo lo exportado:
node scripts/luckperms-add-context.mjs antes.json.gz contexto.json.gz lobby
# 3. Cambiar su config.yml (server: lobby, storage-method: MySQL, data: igual que el proxy,
#    messaging-service: sql) y reiniciarlo.
# 4. En su consola:  lp import contexto      (sin --replace: combina, no borra nada)
```

## Instalación

1. Crear un usuario de base de datos solo para el bot, con lo mínimo necesario:

   ```sql
   CREATE USER 'impebot'@'%' IDENTIFIED BY 'una-contraseña-larga';
   GRANT SELECT ON luckperms.* TO 'impebot'@'%';
   -- Para vincular cuentas (meta whatsapp/discord) y avisar a la red:
   GRANT INSERT, DELETE ON luckperms.luckperms_user_permissions TO 'impebot'@'%';
   GRANT INSERT ON luckperms.luckperms_messenger TO 'impebot'@'%';
   ```

2. **Antes de activarlo**, dar los permisos básicos a todos, o nadie podrá usar el bot:

   ```
   /lp group default permission set impebot.sticker true
   /lp group default permission set impebot.help true
   /lp group default permission set impebot.account true
   /lp group default permission set impebot.tickets.use true
   /lp group default permission set impebot.music.* true
   ```

   Y a tu staff lo que corresponda (ver la tabla). Recuerda vincular tu propia cuenta (`!vincular`) o estar en `WA_STAFF_IDS`.

3. En el `.env` del bot:

   ```env
   LUCKPERMS_ENABLED=true
   LUCKPERMS_DB_HOST=...        # el mismo host que usan los servidores en data.address
   LUCKPERMS_DB_NAME=luckperms
   LUCKPERMS_DB_USER=impebot
   LUCKPERMS_DB_PASSWORD=...
   LUCKPERMS_SERVERS=impebot    # contextos server que cuentan además de global
   ```

4. Reiniciar el bot. En la consola debe aparecer `✅ [LuckPerms] Conectado a ...`.

## Vincular cuentas

**El propio jugador (WhatsApp), desde el juego:** con el plugin ImpeGeo 1.8+ en el proxy.

1. En el juego, ya con sesión iniciada en AuthMe: `/whatsapp link` (o `/wsp link`). Sale un código de 8 cifras que caduca en 10 minutos. Al hacer clic se copia `!vincular 12345678`.
2. Lo envía al bot **por privado**: `!vincular 12345678` (o `!verificar`, `!link`, `!verify`).
3. El bot guarda su número (y su LID de WhatsApp) en la meta `whatsapp` de ese jugador, gasta el código y avisa a la red. En el juego le aparece «WhatsApp vinculado: +51 •••••• 321».

`/whatsapp info` muestra el número vinculado (con cifras ocultas) y `/whatsapp unlink` lo quita.

- El código es la meta temporal `impebotcode`: solo vale una vez y solo para quien lo generó. Un código nuevo anula el anterior.
- Si el número ya estaba en otra cuenta, pasa a la nueva y el bot lo indica (`antes: Alex`).
- Como mucho 5 códigos incorrectos por persona y hora (`WA_LINK_MAX_FAILURES`).
- **Grupos:** solo los de `WA_LINK_GROUPS`. Si no hay ninguno, solo por privado. En un grupo el código queda a la vista de todos, así que **se anula con el primer mensaje que lo contenga**, aunque no sea `!vincular`. Si el bot es admin, borra ese mensaje, y el jugador ve en el juego que su código se anuló. En los grupos permitidos se vincula igual y el mensaje también se borra.
- En ImpeGeo se ajusta en `[whatsapp]` de su `config.toml`. Ahí conviene poner `bot-number` para que el jugador sepa a qué número escribir. El permiso `impegeo.whatsapp` lo tienen todos salvo que se les quite.

**El propio jugador (WhatsApp), desde la web:** genera su código en la web y envía por privado al bot `!vincular CODIGO`. Los códigos de la web tienen 32 caracteres, así que el bot los distingue de los del juego.

La web confirma de quién es el código y devuelve su nick de Minecraft; el bot guarda su número (y su LID de WhatsApp) en ese jugador de LuckPerms. El jugador tiene que haber entrado al servidor al menos una vez. Si no, el bot avisa y hay que generar un código nuevo después de entrar.

**El propio jugador (Discord):** con DiscordSRV, como siempre: `/discord link` en el juego y el código por Discord. El bot lee esos vínculos directamente de la base de DiscordSRV, así que no hay que hacer nada más.

Para activarlo, DiscordSRV debe guardar los vínculos en MySQL (`Experiment_JdbcAccountLinkBackend` en su `config.yml`) y el bot necesita leer esa base:

```sql
CREATE USER 'impebot_dsrv'@'%' IDENTIFIED BY 'otra-contraseña-larga';
GRANT SELECT ON discordsrv.discordsrv_accounts TO 'impebot_dsrv'@'%';
```

```env
DISCORDSRV_LINKS_ENABLED=true
DISCORDSRV_DB_NAME=discordsrv
DISCORDSRV_DB_USER=impebot_dsrv
DISCORDSRV_DB_PASSWORD=...
```

Si un admin fuerza otro jugador con `/minecraft vincular`, ese vínculo (meta `discord` en LuckPerms) tiene prioridad sobre el de DiscordSRV. Los servidores con DiscordSRV que guardan sus vínculos en `accounts.aof` (archivo local) no los comparten: conviene que todos apunten a la misma base.

**Un admin (`impebot.link.admin`):**

| Dónde | Comando |
|---|---|
| WhatsApp | `!forzarvinculo Steve @usuario` (o `!forcelink`, `!mcvincular`; también respondiendo a su mensaje o con su número) |
| WhatsApp | `!quitarvinculo Steve` o `!quitarvinculo @usuario` (o `!unlink`, `!mcdesvincular`) |
| Discord | `/minecraft vincular jugador:Steve usuario:@alguien` |
| Discord | `/minecraft desvincular jugador:Steve` o `usuario:@alguien` |
| Juego | `/lp user Steve meta set whatsapp 51987654321` · `/lp user Steve meta set discord 1234…` |

- Forzar un número que ya estaba en otro jugador se lo quita al anterior (el bot lo indica).
- Un admin no puede forzar su propio vínculo (salvo `WA_STAFF_IDS` en WhatsApp o Gestionar servidor en Discord): para eso está `!vincular`.
- `!quitarvinculo` y `/minecraft desvincular` solo borran el vínculo guardado en LuckPerms. El de la web (tickets) se quita desde la web, y el de DiscordSRV con `/discord unlink` en el juego (o `/discordsrv unlink` desde la consola).

`!mc` (WhatsApp) y `/minecraft info` (Discord) muestran la cuenta vinculada y el rango.

Los comandos de Discord se registran en `DISCORD_GUILD_ID`. Para que la música y `/minecraft` funcionen también en el servidor público, añade su ID a `DISCORD_EXTRA_GUILD_IDS` (separados por coma). Tickets y `/espejo` siguen solo en `DISCORD_GUILD_ID`.

## Permisos

| Permiso | Comandos | Sin LuckPerms |
|---|---|---|
| — | `!vincular`, `!verificar`, `!link`, `!verify` | siempre libre |
| `impebot.sticker` | `!s`, `!scrop`, `!scircle`, `!sround` | libre |
| `impebot.help` | `!help` | libre |
| `impebot.account` | `!mc`, `/minecraft info` | libre |
| `impebot.tickets.use` | `!ticket`, `!tickets`, `!responder`, `!cerrar`, `!cancelar` | libre |
| `impebot.presence` | `!presence`, `!online`, `!offline` | solo `WA_STAFF_IDS` |
| `impebot.link.admin` | `!forzarvinculo`, `!quitarvinculo`, `/minecraft vincular/desvincular` | `WA_STAFF_IDS` / Gestionar servidor |
| `impebot.moderation.delete` | `!borrar` | admins del grupo |
| `impebot.moderation.ban` | `!ban`, `!desban`, `!bans` | admins del grupo |
| `impebot.moderation.kick` | `!kick` | admins del grupo |
| `impebot.moderation.warn` | `!warn`, `!warns`, `!unwarn` | admins del grupo |
| `impebot.moderation.exempt` | no se le puede sancionar | — |
| `impebot.music.play` | `/play` | libre |
| `impebot.music.control` | `/skip`, `/stop`, `/pause`, `/resume`, `/volumen` y botones | libre |
| `impebot.music.queue` | `/cola` y botón de cola | libre |
| `impebot.tickets.staff` | `/responder`, `/nota`, `/tomar`... | Gestionar servidor o `TICKETS_STAFF_ROLE_IDS` |
| `impebot.relay.mirror` | `/espejo` (además de Gestionar servidor) | Gestionar servidor |

Reglas con LuckPerms activo:

- Hace falta `true`. Sin permiso, o sin cuenta vinculada, el comando se rechaza (y si no está vinculado, el bot le explica cómo hacerlo).
- Ser admin del grupo de WhatsApp o tener el rol de Discord ya **no basta**: hace falta el permiso.
- Se aplican herencia de grupos, pesos, comodines (`impebot.moderation.*`, `impebot.*`, `*`) y permisos temporales.
- Solo cuentan los permisos globales o con `server=` de `LUCKPERMS_SERVERS`. Los de mundos concretos u otros contextos se ignoran.

Ejemplos:

```
/lp group mod permission set impebot.moderation.* true
/lp group helper permission set impebot.moderation.warn true
/lp group admin permission set impebot.presence true
/lp group admin permission set impebot.link.admin true
/lp group helper permission set impebot.tickets.staff true
/lp user Troll permission set impebot.music.play false
/lp user Steve permission settemp impebot.moderation.kick true 7d
```
