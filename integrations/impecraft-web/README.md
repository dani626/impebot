# Módulo para impecraft-web

Instalación y contrato: [docs/tickets.md](../../docs/tickets.md).

`files/` contiene los archivos que se copian en el frontend Next.js. `schema.fragment.prisma` añade los modelos de vinculación y deduplicación; el instalador incorpora las relaciones a `User` y `Ticket`.

- `/api/bridge/impebot`: GET paginado o por número; POST `link`, `create`, `message`, `update`. Requiere `Authorization: Bearer <IMPECRAFT_BOT_TOKEN>`.
- `/api/account/impebot`: el usuario autenticado genera el código o desvincula WhatsApp. Exige mismo origen.
- `/account/whatsapp`: interfaz de vinculación.

Los DTO conservan `TicketDetail` y añaden `whatsappJid`, `whatsappLinkedAt` y el ID del autor de cada mensaje, para distinguir al dueño de quien le responde sin deducirlo del rol.

Estos endpoints son nuevos. Deben instalarse y aplicarse sus migraciones antes de configurar el modo web en el bot.
