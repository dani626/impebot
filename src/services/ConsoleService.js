import readline from 'readline';
import { CONFIG } from '../config.js';
import { whatsAppService } from './WhatsAppService.js';
import { discordService } from './DiscordService.js';
import { dbService } from '../database/DatabaseService.js';
import { relayEngine } from '../relay/RelayEngine.js';

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

      try {
        await this.handleCommand(input);
      } catch (err) {
        console.error(`❌ [Consola] Error al ejecutar comando: ${err.message}`);
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
        await this.sendWhatsAppMessage(args);
        break;

      case 'saydc':
      case 'senddc':
        await this.sendDiscordMessage(args);
        break;

      case 'ping':
        await this.checkPings();
        break;

      case 'eval':
        this.evaluateCode(args.join(' '));
        break;

      case 'clear':
      case 'cls':
        console.clear();
        console.log('💻 [Consola] Pantalla limpia. Escribe "help" para comandos.');
        break;

      case 'stop':
      case 'exit':
      case 'shutdown':
        console.log('🛑 [Consola] Solicitud de apagado manual recibida...');
        process.emit('SIGINT');
        break;

      default:
        console.log(`❓ [Consola] Comando desconocido: "${cmd}". Escribe "help" para ver la lista de comandos.`);
        break;
    }
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
    console.log('  mappings           - Lista los canales mapeados en la base de datos');
    console.log('  ping               - Mide latencia con Discord y MariaDB');
    console.log('  saywa <jid> <txt>  - Envía un mensaje de WhatsApp a un JID/número');
    console.log('  saydc <id> <txt>   - Envía un mensaje directo a un canal de Discord');
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
      console.log(`   └─ Usuario: ${whatsAppService.sock.user.id || whatsAppService.sock.user.name || 'OK'}`);
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
   * Lista los mapeos guardados en MariaDB.
   */
  async listMappings() {
    if (!dbService.isConnected) {
      console.log('⚠️ [Consola] MariaDB no está conectada actualmente.');
      return;
    }

    try {
      const rows = await dbService.query(
        'SELECT id, whatsapp_jid, discord_channel_id, created_at FROM channel_mappings ORDER BY id ASC'
      );

      console.log('\n==================================================');
      console.log(`🔗 CANALES MAPEADOS (${rows.length} en total):`);
      console.log('==================================================');
      if (rows.length === 0) {
        console.log('No hay canales mapeados todavía.');
      } else {
        for (const row of rows) {
          console.log(`[#${row.id}] WA: ${row.whatsapp_jid}  <--->  Discord: ${row.discord_channel_id}`);
        }
      }
      console.log('==================================================\n');
    } catch (err) {
      console.error('❌ [Consola] Error consultando mapeos:', err.message);
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
export default consoleService;
