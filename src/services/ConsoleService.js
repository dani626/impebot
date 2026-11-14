import readline from 'readline';
import { CONFIG } from '../config.js';
import { whatsAppService } from './WhatsAppService.js';
import { discordService } from './DiscordService.js';
import { dbService } from '../database/DatabaseService.js';
import { channelMappingRepository } from '../database/repositories/ChannelMappingRepository.js';
import { relayEngine } from '../relay/RelayEngine.js';
import { normalizePresence } from '../utils/whatsappMessage.js';
import { commandLogService, formatCommandLog } from './CommandLogService.js';
import { commandLogRepository } from '../database/repositories/CommandLogRepository.js';
import { linkHintService, isGroupJid } from './LinkHintService.js';
import { settingsRepository } from '../database/repositories/SettingsRepository.js';
import {
  DIRECTIONS, GLOBAL_SETTINGS_KEY, MAPPING_SETTINGS, isValidAlias, parseSettings, withSetting,
} from '../relay/relayRouting.js';

export class ConsoleService {
  constructor() {
    this.rl = null;
    this.isListening = false;
  }

  /**
   * Inicia el lector de línea de comandos en la entrada estándar (stdin).
   * Compatible con paneles Pterodactyl, Docker y terminal local.
   */
  start() {
    if (this.isListening) return;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false, // Evita conflictos de formateo en contenedores Docker / Pterodactyl
    });

    this.isListening = true;

    this.rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) return;

      const [name, ...rest] = input.split(/ +/);
      const entry = { source: 'consola', actorId: 'consola', command: name.toLowerCase(), args: rest.join(' ') };
      // Se registra antes de ejecutar: comandos como stop cierran el proceso.
      commandLogService.log({ ...entry, status: 'recibido' });

      try {
        await this.handleCommand(input);
      } catch (err) {
        console.error(`❌ [Consola] Error al ejecutar comando: ${err.message}`);
        commandLogService.log({ ...entry, status: 'error', detail: err.message });
      }
    });

    console.log('💻 [Consola] Soporte de comandos activo. Escribe "help" para ver los comandos.');
  }

  /**
   * Procesa la línea ingresada por el usuario.
   * @param {string} rawInput 
   */
  async handleCommand(rawInput) {
    const parts = rawInput.split(/ +/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'help':
      case 'ayuda':
      case '?':
        this.printHelp();
        break;

      case 'status':
      case 'estado':
      case 'info':
        await this.printStatus();
        break;

      case 'mappings':
      case 'canales':
      case 'chats':
        await this.listMappings();
        break;

      case 'saywa':
      case 'sendwa':
      case 'decirwa':
        await this.sendWhatsAppMessage(args);
        break;

      case 'saydc':
      case 'senddc':
      case 'decirdc':
        await this.sendDiscordMessage(args);
        break;

      case 'ping':
        await this.checkPings();
        break;

      case 'presence':
      case 'presencia':
      case 'wapresence':
        await this.handlePresenceCommand(args);
        break;

      case 'logs':
      case 'registro':
        await this.printCommandLogs(args[0]);
        break;

      case 'relay':
      case 'vinculo':
      case 'enlace':
        await this.handleRelayCommand(args);
        break;

      case 'avisos':
      case 'linkhint':
      case 'vinculos':
        await this.handleLinkHintCommand(args);
        break;

      case 'eval':
        this.evaluateCode(args.join(' '));
        break;

      case 'clear':
      case 'cls':
      case 'limpiar':
        console.clear();
        console.log('💻 [Consola] Pantalla limpia. Escribe "help" para comandos.');
        break;

      case 'stop':
      case 'exit':
      case 'shutdown':
      case 'detener':
      case 'apagar':
        console.log('🛑 [Consola] Solicitud de apagado manual recibida...');
        process.emit('SIGINT');
        break;

      default:
        console.log(`❓ [Consola] Comando desconocido: "${cmd}". Escribe "help" para ver la lista de comandos.`);
        break;
    }
  }

  /**
   * avisos list
   * avisos add <ID@g.us> [alias]    → añade un grupo por su ID
   * avisos add <ID canal Discord>  → toma el grupo de WhatsApp vinculado a ese canal (relay)
   * avisos add <alias de vínculo>   → toma el grupo de WhatsApp del vínculo del relay con ese alias
   * avisos add <nombre del grupo>   → busca el grupo por nombre entre los de WhatsApp
   * avisos remove <alias|ID>        → lo quita
   */
  async handleLinkHintCommand(args) {
    const sub = (args[0] || 'list').toLowerCase();
    const rest = args.slice(1);
    if (sub === 'list' || sub === 'lista') {
      const rows = await linkHintService.list();
      if (!rows.length) {
        console.log('ℹ️ [Avisos] No hay grupos. Usa: avisos add <ID@g.us | ID canal Discord | nombre del grupo> [alias]');
        return;
      }
      console.log(`📋 [Avisos] Grupos donde se avisa de que falta vincular (comandos: ${CONFIG.linkHint.commands.join(', ')}):`);
      for (const r of rows) console.log(`   • ${r.jid}${r.alias ? ` (${r.alias})` : ''} [${r.source}]`);
      return;
    }
    if (sub === 'add' || sub === 'agregar') {
      if (!rest.length) {
        console.log('⚠️ Uso: avisos add <ID@g.us> [alias]  |  avisos add <nombre del grupo>');
        return;
      }
      let jid;
      let alias;
      let linked = null;
      const channelId = /^(?:<#)?(\d{17,20})>?$/.exec(rest[0])?.[1];
      if (channelId) {
        // ID (o mención) de un canal de Discord vinculado por el relay: de ahí sale el grupo de WhatsApp.
        if (!dbService.isConnected) {
          console.log('❌ [Avisos] MariaDB no está conectada: no puedo leer los canales vinculados.');
          return;
        }
        const mapping = await channelMappingRepository.getByDiscordChannelId(channelId);
        if (!mapping) {
          console.log(`⚠️ [Avisos] El canal de Discord ${channelId} no está vinculado a ningún chat de WhatsApp (revisa "mappings").`);
          return;
        }
        if (!isGroupJid(mapping.whatsapp_jid)) {
          console.log(`⚠️ [Avisos] Ese canal está vinculado a ${mapping.whatsapp_jid}, que no es un grupo (@g.us).`);
          return;
        }
        jid = mapping.whatsapp_jid;
        const channelName = discordService.client?.channels?.cache?.get(channelId)?.name;
        alias = rest.slice(1).join(' ') || (channelName ? `#${channelName}` : '');
      } else if (isGroupJid(rest[0])) {
        jid = rest[0];
        alias = rest.slice(1).join(' ');
      } else if (isGroupJid((linked = dbService.isConnected ? await channelMappingRepository.getByAlias(rest[0]).catch(() => null) : null)?.whatsapp_jid)) {
        // Alias de un vínculo del relay (ver "relay"): de ahí sale el grupo de WhatsApp.
        jid = linked.whatsapp_jid;
        alias = rest.slice(1).join(' ') || linked.alias;
      } else {
        const name = rest.join(' ');
        const sock = whatsAppService.sock;
        if (!whatsAppService.isReady || !sock) {
          console.log('❌ [Avisos] WhatsApp no está conectado: usa el ID del grupo (@g.us).');
          return;
        }
        const groups = Object.values(await sock.groupFetchAllParticipating());
        const wanted = name.toLowerCase();
        const exact = groups.filter((g) => String(g.subject).toLowerCase() === wanted);
        const found = exact.length ? exact : groups.filter((g) => String(g.subject).toLowerCase().includes(wanted));
        if (found.length !== 1) {
          console.log(found.length
            ? `⚠️ [Avisos] "${name}" coincide con varios grupos, usa el ID: ${found.map((g) => `${g.subject} → ${g.id}`).join(' | ')}`
            : `⚠️ [Avisos] No encontré ningún grupo llamado "${name}" donde esté el bot.`);
          return;
        }
        jid = found[0].id;
        alias = found[0].subject;
      }
      const res = await linkHintService.add(jid, alias);
      console.log(`✅ [Avisos] ${res.existed ? 'Actualizado' : 'Añadido'}: ${res.jid}${res.alias ? ` (${res.alias})` : ''}. Ya se avisa ahí, sin reiniciar.`);
      return;
    }
    if (sub === 'remove' || sub === 'quitar') {
      if (!rest.length) {
        console.log('⚠️ Uso: avisos remove <alias|ID@g.us>');
        return;
      }
      const res = await linkHintService.remove(rest.join(' '));
      console.log(`✅ [Avisos] Quitado: ${res.jid}${res.alias ? ` (${res.alias})` : ''}.`);
      return;
    }
    console.log('⚠️ Uso: avisos [list] | avisos add <ID@g.us | ID canal Discord | nombre> [alias] | avisos remove <alias|ID>');
  }

  /**
   * Muestra la lista de comandos disponibles.
   */
  printHelp() {
    console.log('\n==================================================');
    console.log('📖 COMANDOS DISPONIBLES EN CONSOLA (PTERODACTYL):');
    console.log('==================================================');
    console.log('  help / ?           - Muestra este menú de ayuda');
    console.log('  status             - Muestra el estado del bot, memoria y conexiones');
    console.log('  mappings           - Lista los vínculos chat de WhatsApp ↔ canal de Discord');
    console.log('  relay <nº|alias> … - Cambia un vínculo: alias, pausar, activar, direccion, ajuste (escribe "relay" para ver el uso)');
    console.log('  ping               - Mide latencia con Discord y MariaDB');
    console.log('  saywa|decirwa <jid> <txt> - Envía un mensaje de WhatsApp a un JID/número');
    console.log('  saydc|decirdc <id> <txt> - Envía un mensaje directo a un canal de Discord');
    console.log('  presence [modo]    - Consulta o cambia presencia de WhatsApp (online / offline)');
    console.log('  logs [n]           - Muestra los últimos n comandos registrados (por defecto 15)');
    console.log('  avisos [list|add|remove] - Grupos donde se avisa de que falta vincular la cuenta');
    console.log('  eval <código>      - Ejecuta código JS en el contexto del bot');
    console.log('  clear / cls        - Limpia la pantalla de la consola');
    console.log('  stop / exit        - Detiene el servidor ordenadamente (graceful shutdown)');
    console.log('==================================================\n');
  }

  /**
   * Muestra el estado detallado de todos los servicios.
   */
  async printStatus() {
    const memory = process.memoryUsage();
    const uptimeSec = Math.floor(process.uptime());
    const hours = Math.floor(uptimeSec / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    const seconds = uptimeSec % 60;
    const uptimeStr = `${hours}h ${minutes}m ${seconds}s`;

    console.log('\n==================================================');
    console.log('📊 ESTADO DEL SISTEMA IMPEBOT');
    console.log('==================================================');
    console.log(`⏱️  Uptime Node: ${uptimeStr}`);
    console.log(`🧠 RAM Usada: ${(memory.rss / 1024 / 1024).toFixed(2)} MB (Heap: ${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB)`);

    // WhatsApp
    const waConnected = Boolean(whatsAppService.isReady && whatsAppService.sock);
    console.log(`📱 WhatsApp: ${waConnected ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    if (waConnected && whatsAppService.sock?.user) {
      const presenceInfo = whatsAppService.getPresence();
      console.log(`   └─ Usuario: ${whatsAppService.sock.user.id || whatsAppService.sock.user.name || 'OK'}`);
      console.log(`   └─ Presencia: ${presenceInfo.label === 'online' ? '🟢 ONLINE' : '⚪ OFFLINE (invisible)'}`);
    }

    // Discord
    const dcConnected = Boolean(discordService.isReady && discordService.client?.isReady());
    console.log(`🎮 Discord:  ${dcConnected ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);
    if (dcConnected && discordService.client?.user) {
      console.log(`   └─ Bot: ${discordService.client.user.tag} (Ping: ${discordService.client.ws.ping}ms)`);
    }

    // Base de Datos
    const dbConnected = Boolean(dbService.isConnected);
    console.log(`🗄️  MariaDB:  ${dbConnected ? '✅ CONECTADO' : '❌ DESCONECTADO'}`);

    // Relay
    const relayActive = Boolean(relayEngine.isRunning);
    console.log(`🔄 Relay WA<->DC: ${relayActive ? '✅ ACTIVO' : '⏸️ DETENIDO'}`);
    console.log('==================================================\n');
  }

  /**
   * Muestra los últimos comandos registrados (consola, WhatsApp, Discord).
   * @param {string} [countArg]
   */
  async printCommandLogs(countArg) {
    if (!dbService.isConnected) {
      console.log('⚠️ [Consola] MariaDB no está conectada: el registro histórico no está disponible.');
      return;
    }
    const count = Math.min(Math.max(parseInt(countArg, 10) || 15, 1), 100);
    const rows = (await commandLogRepository.recent(count)).reverse();
    console.log(`\n📝 ÚLTIMOS ${rows.length} COMANDOS REGISTRADOS:`);
    for (const r of rows) {
      const when = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19);
      console.log(`${when} ${formatCommandLog({
        source: r.source, actorId: r.actor_id, actorName: r.actor_name, chatId: r.chat_id,
        command: r.command, args: r.args, status: r.status, detail: r.detail,
      })}`);
    }
    console.log('');
  }

  /**
   * Lista los mapeos guardados en MariaDB.
   */
  async listMappings() {
    if (!dbService.isConnected) {
      console.log('⚠️ [Consola] MariaDB no está conectada actualmente.');
      return;
    }

    try {
      const rows = await channelMappingRepository.getAll();

      console.log('\n==================================================');
      console.log(`🔗 CANALES MAPEADOS (${rows.length} en total):`);
      console.log('==================================================');
      if (rows.length === 0) {
        console.log('No hay canales mapeados todavía.');
      } else {
        const arrows = { both: '<--->', wa_to_dc: '---->', dc_to_wa: '<----' };
        for (const row of rows) {
          const custom = Object.entries(parseSettings(row.settings)).map(([key, value]) => `${key}=${value}`).join(', ');
          console.log(`[#${row.id}] WA: ${row.whatsapp_jid}  ${arrows[row.direction] || '<--->'}  Discord: ${row.discord_channel_id}`
            + `${row.alias ? `  (${row.alias})` : ''}${row.enabled ? '' : '  ⏸️ pausado'}${custom ? `  {${custom}}` : ''}`);
        }
      }
      console.log('==================================================\n');
    } catch (err) {
      console.error('❌ [Consola] Error consultando mapeos:', err.message);
    }
  }

  /**
   * relay <nº|alias> alias <nombre|->            → pone o quita el alias del vínculo
   * relay <nº|alias> pausar | activar            → deja de reenviar sin borrar el vínculo
   * relay <nº|alias> direccion <both|wa_to_dc|dc_to_wa>
   * relay <nº|alias> ajuste <clave> <valor|->    → ajuste propio del vínculo; "-" vuelve a heredar
   * relay global <clave> [valor|-]               → valor por defecto para todos los vínculos
   * @param {string[]} args
   */
  async handleRelayCommand(args) {
    const usage = () => {
      console.log('⚠️ Uso: relay <nº|alias> alias <nombre|-> | pausar | activar | direccion <both|wa_to_dc|dc_to_wa> | ajuste <clave> <valor|->');
      console.log('        relay global <clave> [valor|-]');
      console.log(`   Ajustes: ${Object.entries(MAPPING_SETTINGS).map(([key, def]) => `${key} (${def.values.join(' | ')}; por defecto ${def.default})`).join(', ')}`);
      console.log('   Los números de vínculo salen en "mappings".');
    };
    const [ref, action, ...rest] = args;
    if (!ref) return usage();
    if (!dbService.isConnected) {
      console.log('❌ [Relay] MariaDB no está conectada.');
      return;
    }
    const duplicate = (err) => err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;

    try {
      if (ref.toLowerCase() === 'global') {
        const current = parseSettings(await settingsRepository.get(GLOBAL_SETTINGS_KEY));
        if (!action) {
          console.log(`ℹ️ [Relay] Valores globales: ${JSON.stringify(current)}`);
          return;
        }
        const next = withSetting(current, action, rest[0] && rest[0] !== '-' ? rest[0] : null);
        await settingsRepository.set(GLOBAL_SETTINGS_KEY, JSON.stringify(next));
        console.log(`✅ [Relay] Valores globales: ${JSON.stringify(next)}`);
        return;
      }

      const mapping = await channelMappingRepository.findByRef(ref);
      if (!mapping) {
        console.log(`⚠️ [Relay] No hay ningún vínculo con el número o alias "${ref}" (revisa "mappings").`);
        return;
      }
      const label = `#${mapping.id} (${mapping.whatsapp_jid} ↔ ${mapping.discord_channel_id})`;

      switch ((action || '').toLowerCase()) {
        case 'alias': {
          const name = rest[0];
          if (!name) return usage();
          if (name !== '-' && !isValidAlias(name)) {
            console.log('⚠️ [Relay] El alias solo puede tener letras, números, - y _ (2 a 32 caracteres) y no puede ser solo números.');
            return;
          }
          try {
            await channelMappingRepository.setAlias(mapping.id, name === '-' ? null : name);
          } catch (err) {
            if (!duplicate(err)) throw err;
            console.log(`⚠️ [Relay] El alias "${name}" ya lo usa otro vínculo.`);
            return;
          }
          console.log(`✅ [Relay] ${label}: ${name === '-' ? 'alias quitado' : `alias "${name}"`}.`);
          return;
        }
        case 'pausar':
        case 'pause':
        case 'activar':
        case 'resume': {
          const enabled = ['activar', 'resume'].includes(action.toLowerCase());
          await channelMappingRepository.setEnabled(mapping.id, enabled);
          console.log(`✅ [Relay] ${label}: ${enabled ? 'activo' : 'pausado; no se reenvía nada hasta que lo actives'}.`);
          return;
        }
        case 'direccion':
        case 'direction': {
          const direction = (rest[0] || '').toLowerCase();
          if (!DIRECTIONS.includes(direction)) {
            console.log(`⚠️ [Relay] Dirección no válida. Valores: ${DIRECTIONS.join(', ')}.`);
            return;
          }
          try {
            await channelMappingRepository.setDirection(mapping.id, direction);
          } catch (err) {
            if (!duplicate(err)) throw err;
            console.log(`⚠️ [Relay] El canal ${mapping.discord_channel_id} ya tiene otro vínculo que escribe a WhatsApp; solo puede haber uno por canal.`);
            return;
          }
          console.log(`✅ [Relay] ${label}: dirección ${direction}.`);
          return;
        }
        case 'ajuste':
        case 'set': {
          if (!rest[0]) return usage();
          const next = withSetting(mapping.settings, rest[0], rest[1] && rest[1] !== '-' ? rest[1] : null);
          await channelMappingRepository.setSettings(mapping.id, next);
          console.log(`✅ [Relay] ${label}: ajustes propios ${JSON.stringify(next)} (lo demás se hereda).`);
          return;
        }
        default:
          return usage();
      }
    } catch (err) {
      console.log(`❌ [Relay] ${err.message}`);
    }
  }

  /**
   * Envía un mensaje a WhatsApp desde la consola.
   * @param {string[]} args 
   */
  async sendWhatsAppMessage(args) {
    if (args.length < 2) {
      console.log('⚠️ Uso correcto: saywa <jid_o_número> <mensaje>');
      console.log('   Ejemplo: saywa 123456789@s.whatsapp.net Hola desde consola');
      return;
    }

    let targetJid = args[0];
    const text = args.slice(1).join(' ');

    if (!targetJid.includes('@')) {
      targetJid = `${targetJid.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    }

    try {
      await whatsAppService.sendMessage(targetJid, { text });
      console.log(`✅ [Consola] Mensaje enviado a WhatsApp (${targetJid}): "${text}"`);
    } catch (err) {
      console.error(`❌ [Consola] Error enviando a WhatsApp: ${err.message}`);
    }
  }

  /**
   * Envía un mensaje a Discord desde la consola.
   * @param {string[]} args 
   */
  async sendDiscordMessage(args) {
    if (args.length < 2) {
      console.log('⚠️ Uso correcto: saydc <channelId> <mensaje>');
      console.log('   Ejemplo: saydc 123456789012345678 Hola a Discord');
      return;
    }

    const channelId = args[0];
    const text = args.slice(1).join(' ');

    try {
      await discordService.sendMessage(channelId, { content: text });
      console.log(`✅ [Consola] Mensaje enviado al canal Discord ${channelId}: "${text}"`);
    } catch (err) {
      console.error(`❌ [Consola] Error enviando a Discord: ${err.message}`);
    }
  }

  /**
   * Mide la latencia con Discord y MariaDB.
   */
  async checkPings() {
    console.log('🏓 Midiendo latencias...');
    
    // Discord Ping
    if (discordService.isReady && discordService.client?.ws) {
      console.log(`🎮 Discord WebSocket Ping: ${discordService.client.ws.ping}ms`);
    } else {
      console.log('🎮 Discord: No conectado');
    }

    // DB Ping
    if (dbService.isConnected) {
      try {
        const start = Date.now();
        await dbService.query('SELECT 1');
        const diff = Date.now() - start;
        console.log(`🗄️  MariaDB Ping: ${diff}ms`);
      } catch (err) {
        console.log(`🗄️  MariaDB Error: ${err.message}`);
      }
    } else {
      console.log('🗄️  MariaDB: No conectada');
    }
  }

  /**
   * Evalúa código JavaScript en el contexto del bot (útil para depuración avanzada).
   * @param {string} code 
   */
  evaluateCode(code) {
    if (!code) {
      console.log('⚠️ Uso correcto: eval <código JS>');
      return;
    }

    try {
      // Exponemos servicios útiles en el alcance local del eval
      const wa = whatsAppService;
      const dc = discordService;
      const db = dbService;
      const relay = relayEngine;
      const config = CONFIG;

      let result = eval(code);
      if (result instanceof Promise) {
        result
          .then((res) => console.log('🔍 [Eval Promise]:', res))
          .catch((err) => console.error('❌ [Eval Promise Error]:', err));
      } else {
        console.log('🔍 [Eval Resultado]:', result);
      }
    } catch (err) {
      console.error('❌ [Eval Error]:', err.message);
    }
  }

  /**
   * Gestiona la consulta o cambio de presencia en WhatsApp desde la consola.
   * @param {string[]} args 
   */
  async handlePresenceCommand(args) {
    if (args.length === 0) {
      const { label, status } = whatsAppService.getPresence();
      console.log(`\n📱 [WhatsApp] Estado actual de presencia: ${label.toUpperCase()} (${status})`);
      console.log('💡 Cambiar estado: presence online | presence offline\n');
      return;
    }

    const mode = normalizePresence(args[0]);
    if (mode === 'available') {
      await whatsAppService.setPresence('available');
      console.log('✅ [Consola] Presencia de WhatsApp cambiada a ONLINE (disponible).');
    } else if (mode === 'unavailable') {
      await whatsAppService.setPresence('unavailable');
      console.log('✅ [Consola] Presencia de WhatsApp cambiada a OFFLINE (invisible / desconectado).');
    } else {
      console.log('⚠️ [Consola] Modo no reconocido. Uso: presence online | presence offline');
    }
  }

  /**
   * Detiene el lector de consola.
   */
  stop() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
      this.isListening = false;
    }
  }
}

export const consoleService = new ConsoleService();
