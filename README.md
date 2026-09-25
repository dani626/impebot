# ImpeBot — WhatsApp Sticker Bot & Discord Relay 🤖🔄

Bot modular para Node.js desarrollado con `@whiskeysockets/baileys`, `discord.js`, MariaDB y `wa-sticker-formatter`.
Ofrece retransmisión bidireccional de mensajes (**WhatsApp ↔ Discord**) con prevención de bucles infinitos, impersonación mediante Webhooks y soporte completo para comandos de stickers.

---

## 🚀 Características

### 🔄 Retransmisión WhatsApp ↔ Discord (Relay)
- **Bidireccional**: Retransmite mensajes de WhatsApp a canales de Discord y viceversa.
- **Identidad Vía Webhooks**: En Discord, los mensajes de WhatsApp se publican con el nombre y avatar del remitente.
- **Prevención Anti-Bucle**: Registro en base de datos (`message_logs`) de cada mensaje reenviado para evitar rebotes infinitos.
- **Soporte Multimedia**: Transforma textos, citas (quoted replies), imágenes, notas de voz, videos, stickers y documentos.
- **Mapeo Flexible**: Mapeo canal a canal (`channel_mappings`) y usuario a usuario (`user_mappings`).
- **Limpieza Automática**: Purgado programado de logs antiguos para optimizar almacenamiento.
- **Recuperación Offline (Backlog)**: Captura mensajes atrasados enviados mientras el bot estuvo apagado (hasta 24h) y los retransmite a Discord con un **Embed que muestra la fecha y hora original**.

### 🖼️ Bot de Stickers (WhatsApp)
- `!s` : Convierte imagen en sticker completo.
- `!scrop` : Recorte en formato cuadrado.
- `!scircle` : Recorte circular.
- `!sround` : Recorte con esquinas redondeadas.
- `!s Pack | Autor` : Personalización de metadatos.
- `!presence [online|offline]` : Consulta o cambia visibilidad del bot (también `!online` / `!offline`).
- `!help` : Menú de ayuda.

---

## 🛠️ Requisitos Previos

- **Node.js**: v18 o superior.
- **MariaDB / MySQL**: Servidor local o remoto.
- **FFmpeg**: Requerido para procesamiento de stickers y multimedia.
- **Bot de Discord**: Creado en el [Discord Developer Portal](https://discord.com/developers/applications) con los intents `Guilds`, `GuildMessages`, `MessageContent` activados.

---

## 📦 Instalación

1. Clona o descarga este repositorio:
```bash
git clone <url_del_repo>
cd impebot
```

2. Instala las dependencias:
```bash
npm install
```

3. Importa la estructura de base de datos en MariaDB:
```bash
mysql -u root -p < schema.sql
```

4. Configura las variables de entorno en `.env`:
```env
# MariaDB
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=tu_password
DB_NAME=relay_bot
DB_CONNECTION_LIMIT=5

# Discord
DISCORD_BOT_TOKEN=tu_token_de_bot_aqui
DISCORD_WEBHOOK_CACHE_TTL=300000

# WhatsApp (Opcional: número para vincular por código en vez de QR)
PAIRING_NUMBER=

# Relay
RELAY_MESSAGE_RETENTION_HOURS=24
RELAY_CLEANUP_INTERVAL_MS=3600000
```

---

## ⚙️ Configurar un Mapeo de Canal

Para vincular un grupo de WhatsApp a un canal de Discord:

1. Obtén el JID del grupo de WhatsApp (ejemplo: `120363028123456789@g.us`).
2. Obtén el ID del canal de Discord y opcionalmente crea un Webhook en ese canal para obtener su URL.
3. Inserta el registro en MariaDB:

```sql
INSERT INTO channel_mappings (whatsapp_jid, discord_channel_id, webhook_url)
VALUES (
  '120363028123456789@g.us',
  '123456789012345678',
  'https://discord.com/api/webhooks/123456789012345678/xxxxxx'
);
```

---

## ▶️ Ejecución

```bash
# Modo producción
npm start

# Modo desarrollo con auto-reload
npm run dev
```

1. La primera vez, escanea el código QR que aparecerá en consola desde WhatsApp (**Dispositivos vinculados** -> **Vincular dispositivo**).
2. ¡Listo! El sistema conectará MariaDB, WhatsApp y Discord simultáneamente.

---

## 📂 Estructura del Proyecto

```text
c:/proyectos/impebot/
├── schema.sql                              # Estructura DDL de tablas e índices
├── .env.example                            # Plantilla de variables de entorno
├── .env                                    # Variables de entorno locales (gitignored)
├── package.json                            # Dependencias y scripts
├── index.js                                # Entrypoint raíz
├── src/
│   ├── config.js                           # Carga y validación de variables de entorno
│   ├── index.js                            # Orquestador principal (DB -> WA -> Discord -> Relay)
│   ├── database/
│   │   ├── DatabaseService.js              # Pool MariaDB Singleton con reintentos
│   │   └── repositories/
│   │       ├── ChannelMappingRepository.js # CRUD para vinculaciones de canales/webhooks
│   │       ├── UserMappingRepository.js    # Identidades de usuarios y avatares
│   │       └── MessageLogRepository.js     # Prevención de bucles y logs
│   ├── services/
│   │   ├── WhatsAppService.js              # Baileys, auth persistente, QR y eventos
│   │   ├── DiscordService.js               # Discord.js, caché de webhooks y eventos
│   │   └── stickerService.js               # Conversión y procesamiento de stickers WebP
│   ├── handlers/
│   │   └── messageHandler.js               # Procesamiento de comandos !s, !help
│   └── relay/
│       ├── RelayEngine.js                  # Mediador bidireccional y control anti-bucle
│       └── MessageTransformer.js           # Conversión y descarga multimedia entre plataformas
└── README.md
```
