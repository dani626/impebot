# WhatsApp Sticker Bot (Baileys) 🤖🖼️

Bot de WhatsApp moderno desarrollado en Node.js utilizando `@whiskeysockets/baileys` y `wa-sticker-formatter` para convertir imágenes en stickers de WhatsApp de forma rápida y sencilla.

## 🚀 Características

- 🖼️ **Imágenes a Stickers**: Convierte cualquier foto en sticker en segundos.
- ✂️ **Modos de recorte**:
  - `!s` : Sticker completo (mantiene proporciones).
  - `!scrop` : Recorte cuadrado.
  - `!scircle` : Recorte circular.
  - `!sround` : Recorte con bordes redondeados.
- 🏷️ **Metadatos Personalizados**: Configura el nombre del paquete y autor (`!s Mi Pack | Mi Nombre`).
- 🔄 **Reconexión Automática**: Reintentos de conexión automáticos si la red parpadea.
- 🔐 **Autenticación Persistente**: Guarda la sesión en `./auth_info_baileys` para no tener que escanear el QR cada vez.

---

## 🛠️ Requisitos Previos

- **Node.js**: v18 o superior (verificado con Node.js v24).
- **FFmpeg**: Instalado en el sistema (ya instalado en tu entorno).

---

## 📦 Instalación

1. Clona o descarga este repositorio en tu equipo.
2. Abre la terminal en la carpeta del proyecto (`c:\proyectos\impebot`) e instala las dependencias:

```bash
npm install
```

---

## ▶️ Ejecución

Para iniciar el bot:

```bash
npm start
```

1. La primera vez que se ejecute, aparecerá un **código QR** en la consola/terminal.
2. Abre WhatsApp en tu teléfono -> **Dispositivos vinculados** -> **Vincular un dispositivo**.
3. Escanea el código QR que aparece en la terminal.
4. ¡Listo! El bot estará conectado y listo para recibir comandos.

---

## 💬 Comandos Disponibles

| Comando | Descripción | Ejemplo de Uso |
| :--- | :--- | :--- |
| `!s` | Convierte imagen a sticker (completo) | Envía o responde a una imagen con `!s` |
| `!scrop` | Sticker en formato cuadrado | Envía o responde a una imagen con `!scrop` |
| `!scircle` | Sticker circular | Envía o responde a una imagen with `!scircle` |
| `!s Pack \| Autor` | Personaliza metadatos del sticker | `!s Mis Stickers \| Juan` |
| `!help` | Muestra el menú de ayuda | `!help` |

---

## 📂 Estructura del Proyecto

```text
c:/proyectos/impebot/
├── src/
│   ├── config.js               # Configuración del bot (prefijos, nombre por defecto)
│   ├── handlers/
│   │   └── messageHandler.js   # Lógica de comandos y respuestas
│   ├── services/
│   │   └── stickerService.js   # Extracción de imágenes y conversión a WebP
│   └── index.js                # Punto de entrada y conexión Baileys
├── package.json
├── README.md
└── .gitignore
```
