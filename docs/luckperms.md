# Permisos con LuckPerms

El bot se conecta directamente a la base MySQL de LuckPerms y funciona como un servidor más de la red:

- **Identidad**: cada jugador se reconoce por su meta `whatsapp` o `discord`.
- **Permisos**: cada comando exige un permiso `impebot.*`, que se da con `/lp` como el de cualquier plugin.
- **Sincronización**: el bot lee `luckperms_messenger` (messaging service SQL) cada segundo. Cuando alguien cambia un rango en el juego, el bot lo nota en 1–2 s. Lo que escribe el bot (vincular cuentas) se anuncia igual que lo haría un servidor, y toda la red lo recarga al momento.

Si LuckPerms no responde, el bot sigue funcionando con las reglas de siempre (`WA_STAFF_IDS`, admins del grupo, Gestionar servidor / rol de soporte).

## Requisitos de la red

1. **Todos los servidores en la misma base MySQL** (`storage-method: MySQL`) y con `messaging-service: sql`. Un servidor con H2 tiene sus propios rangos, y ni el bot ni el resto de la red los ven.
2. Cada servidor con su `server:` propio en `config.yml` (`lobby`, `survivalop`...). Los permisos que deban valer en todas partes se dan sin contexto (globales).

## Instalación

1. Crear un usuario de base de datos solo para el bot, con lo mínimo necesario:

   ```sql
   CREATE USER 'impebot'@'%' IDENTIFIED BY 'una-contraseña-larga';
   GRANT SELECT ON luckperms.* TO 'impebot'@'%';
   -- Solo para vincular cuentas (meta whatsapp/discord) y avisar a la red:
   GRANT INSERT, DELETE ON luckperms.luckperms_user_permissions TO 'impebot'@'%';
   GRANT INSERT ON luckperms.luckperms_messenger TO 'impebot'@'%';
   ```

2. En el `.env` del bot:

   ```env
   LUCKPERMS_ENABLED=true
   LUCKPERMS_DB_HOST=...        # el mismo host que usan los servidores en data.address
   LUCKPERMS_DB_NAME=luckperms
   LUCKPERMS_DB_USER=impebot
   LUCKPERMS_DB_PASSWORD=...
   LUCKPERMS_SERVERS=impebot    # contextos server que cuentan además de global
   ```

3. Reiniciar el bot. En la consola debe aparecer `✅ [LuckPerms] Conectado a ...`.

## Vincular cuentas

Desde el juego o la consola (cualquier servidor de la red):

```
/lp user Steve meta set whatsapp 51987654321
/lp user Steve meta set discord 123456789012345678
```

Desde el bot (requiere `impebot.link`):

| Dónde | Comando |
|---|---|
| WhatsApp | `!mcvincular Steve @usuario` (o respondiendo a su mensaje, o con su número) |
| WhatsApp | `!mcdesvincular Steve` |
| WhatsApp | `!mc`: muestra tu cuenta y rango (cualquiera) |
| Discord | `/minecraft vincular jugador:Steve usuario:@alguien` |
| Discord | `/minecraft desvincular jugador:Steve` · `/minecraft info [usuario]` |

- El número se guarda sin `+`, con código de país. En grupos se guarda también el LID de WhatsApp, para reconocer a la persona aunque WhatsApp no muestre su número.
- Nadie puede vincularse a sí mismo (salvo `WA_STAFF_IDS` en WhatsApp o Gestionar servidor en Discord).
- Un número solo puede estar vinculado a un jugador: al vincularlo a otro, se le quita al anterior.
- El jugador debe haber entrado al servidor al menos una vez.

## Permisos

| Permiso | Comandos | Por defecto (sin nada en LuckPerms) |
|---|---|---|
| `impebot.sticker` | `!s`, `!scrop`, `!scircle`, `!sround` | permitido |
| `impebot.help` | `!help` | permitido |
| `impebot.account` | `!mc` | permitido |
| `impebot.presence` | `!presence`, `!online`, `!offline` | solo `WA_STAFF_IDS` |
| `impebot.link` | `!mcvincular`, `!mcdesvincular`, `/minecraft vincular/desvincular` | `WA_STAFF_IDS` / Gestionar servidor |
| `impebot.moderation.delete` | `!borrar` | admins del grupo y `WA_STAFF_IDS` |
| `impebot.moderation.ban` | `!ban`, `!desban`, `!bans` | admins del grupo y `WA_STAFF_IDS` |
| `impebot.moderation.kick` | `!kick` | admins del grupo y `WA_STAFF_IDS` |
| `impebot.moderation.warn` | `!warn`, `!warns`, `!unwarn` | admins del grupo y `WA_STAFF_IDS` |
| `impebot.moderation.exempt` | no se le puede sancionar | — |
| `impebot.music.play` | `/play` | permitido |
| `impebot.music.control` | `/skip`, `/stop`, `/pause`, `/resume`, `/volumen` y botones | permitido |
| `impebot.music.queue` | `/cola` y botón de cola | permitido |
| `impebot.tickets.staff` | `/responder`, `/nota`, `/tomar`... | Gestionar servidor o `TICKETS_STAFF_ROLE_IDS` |

Reglas:

- `true` en LuckPerms permite el comando aunque la persona no sea admin del grupo.
- `false` lo prohíbe, incluso a admins del grupo o a quien tenga el rol de Discord. Así se bloquea a alguien concreto.
- `WA_STAFF_IDS` siempre puede usarlo todo (acceso de emergencia).
- Se aplican herencia de grupos, pesos, comodines (`impebot.moderation.*`, `*`) y permisos temporales.
- Solo cuentan los permisos globales o con `server=` de `LUCKPERMS_SERVERS`. Los de mundos concretos u otros contextos se ignoran.

Ejemplos:

```
/lp group mod permission set impebot.moderation.* true
/lp group helper permission set impebot.moderation.warn true
/lp group admin permission set impebot.presence true
/lp group admin permission set impebot.link true
/lp user Troll permission set impebot.music.play false
/lp user Steve permission settemp impebot.moderation.kick true 7d
```
