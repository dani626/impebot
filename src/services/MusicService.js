import { createRequire } from 'module';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  StreamType,
} from '@discordjs/voice';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import youtubeDl from 'youtube-dl-exec';
import spotifyUrlInfo from 'spotify-url-info';
import { CONFIG } from '../config.js';
import { ensureFfmpeg, ensureYtDlp } from '../utils/ensureBinaries.js';
import { luckPermsService } from '../luckperms/LuckPermsService.js';
import { decide, musicPermission } from '../luckperms/permissions.js';

const require = createRequire(import.meta.url);
const spotify = spotifyUrlInfo(fetch);
const SPOTIFY_RE = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist)\//i;
const VOLUME_STEP = 10;

// prism-media (usado por @discordjs/voice) busca ffmpeg en FFMPEG_PATH o en el PATH.
if (!process.env.FFMPEG_PATH) {
  try {
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath) process.env.FFMPEG_PATH = ffmpegPath;
  } catch {
    // Se usará el ffmpeg del sistema si existe.
  }
}

export const MUSIC_COMMAND_NAMES = new Set(['play', 'skip', 'stop', 'pause', 'resume', 'cola', 'volumen']);
export const MUSIC_BUTTON_PREFIX = 'music:';

export function musicCommands() {
  return [
    new SlashCommandBuilder().setName('play').setDescription('Reproducir música en tu canal de voz')
      .addStringOption((o) => o.setName('cancion').setDescription('URL o nombre de la canción').setRequired(true).setMaxLength(300)),
    new SlashCommandBuilder().setName('skip').setDescription('Saltar la canción actual'),
    new SlashCommandBuilder().setName('stop').setDescription('Detener la música, vaciar la cola y salir del canal'),
    new SlashCommandBuilder().setName('pause').setDescription('Pausar la reproducción'),
    new SlashCommandBuilder().setName('resume').setDescription('Reanudar la reproducción'),
    new SlashCommandBuilder().setName('cola').setDescription('Ver la cola de reproducción'),
    new SlashCommandBuilder().setName('volumen').setDescription('Cambiar el volumen')
      .addIntegerOption((o) => o.setName('nivel').setDescription('0 a 100').setRequired(true).setMinValue(0).setMaxValue(100)),
  ].map((c) => c.toJSON());
}

export function formatDuration(seconds) {
  if (!seconds) return '?:??';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const normalizeText = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Elige, entre resultados de búsqueda de YouTube, el que corresponde a una pista de Spotify.
 * El primer resultado no sirve a ciegas: para "Astrofónicos - Ayahuasca" YouTube devolvía
 * una meditación de 9 horas. Se exige una duración parecida a la de Spotify y se prefiere
 * el título que contiene el nombre de la canción y el artista.
 * @param {Array<{ title?: string, channel?: string, uploader?: string, duration?: number }>} entries
 * @param {{ name: string, artist?: string, duration?: number }} wanted duración en segundos
 * @param {number} [maxDuration] duración máxima permitida en segundos
 */
export function pickYouTubeMatch(entries, wanted, maxDuration = Infinity) {
  const name = normalizeText(wanted.name);
  const artist = normalizeText(wanted.artist);
  const expected = wanted.duration || 0;
  const tolerance = Math.max(20, expected * 0.15);

  const scored = (entries || [])
    .filter((e) => e && e.duration > 0 && e.duration <= maxDuration)
    .map((e) => {
      const text = normalizeText(`${e.title} ${e.channel || e.uploader || ''}`);
      const diff = expected ? Math.abs(e.duration - expected) : 0;
      return {
        entry: e,
        diff,
        hasName: Boolean(name) && text.includes(name),
        hasArtist: Boolean(artist) && text.includes(artist),
      };
    });

  const close = scored.filter((s) => !expected || s.diff <= tolerance);
  // Sin un resultado de duración parecida, solo vale uno que nombre la canción y el artista.
  const pool = close.length ? close : scored.filter((s) => s.hasName && (s.hasArtist || !artist));
  pool.sort((a, b) => (Number(b.hasName) + Number(b.hasArtist)) - (Number(a.hasName) + Number(a.hasArtist)) || a.diff - b.diff);
  return pool[0]?.entry || null;
}

/** Texto de la cola (pista actual + próximas 10). */
export function formatQueue(queue) {
  const lines = [];
  if (queue.current) lines.push(`▶️ **${queue.current.title}** (${formatDuration(queue.current.duration)})`);
  queue.tracks.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title} (${formatDuration(t.duration)})`));
  if (queue.tracks.length > 10) lines.push(`… y ${queue.tracks.length - 10} más`);
  return lines.join('\n') || 'La cola está vacía.';
}

/**
 * Mensaje "Reproduciendo ahora" con sus botones.
 * @param {{ volume: number, tracks: any[] }} queue
 * @param {{ title: string, url?: string, duration?: number, thumbnail?: string, requestedBy?: string }} track
 * @param {{ paused?: boolean, finished?: string|null }} [state] finished = texto final: desactiva los botones
 */
export function buildNowPlayingMessage(queue, track, { paused = false, finished = null } = {}) {
  const embed = new EmbedBuilder()
    .setColor(finished ? 0x95a5a6 : paused ? 0xf39c12 : 0x1db954)
    .setAuthor({ name: finished ? '⏹️ Reproducción finalizada' : paused ? '⏸️ En pausa' : '🎶 Reproduciendo ahora' })
    .setTitle(String(track.title || 'Sin título').slice(0, 256))
    .addFields(
      { name: 'Duración', value: formatDuration(track.duration), inline: true },
      { name: 'Pedida por', value: track.requestedBy || '—', inline: true },
      { name: 'Volumen', value: `${queue.volume}%`, inline: true },
      { name: 'En cola', value: String(queue.tracks.length), inline: true },
    );
  if (track.url) embed.setURL(track.url);
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  if (finished) embed.setFooter({ text: finished });

  const off = Boolean(finished);
  const button = (id, label, emoji, style) => new ButtonBuilder()
    .setCustomId(`${MUSIC_BUTTON_PREFIX}${id}`).setLabel(label).setEmoji(emoji).setStyle(style).setDisabled(off);
  const controls = new ActionRowBuilder().addComponents(
    button('toggle', paused ? 'Reanudar' : 'Pausar', paused ? '▶️' : '⏸️', paused ? ButtonStyle.Success : ButtonStyle.Primary),
    button('skip', 'Saltar', '⏭️', ButtonStyle.Secondary),
    button('stop', 'Detener', '⏹️', ButtonStyle.Danger),
    button('voldown', 'Vol -', '🔉', ButtonStyle.Secondary),
    button('volup', 'Vol +', '🔊', ButtonStyle.Secondary),
  );
  const extras = new ActionRowBuilder().addComponents(button('queue', 'Ver cola', '📜', ButtonStyle.Secondary));
  return { embeds: [embed], components: [controls, extras] };
}

class GuildMusicQueue {
  /**
   * @param {string} guildId
   * @param {{ onIdle: (guildId: string) => void, resolver: (track: object) => Promise<any>,
   *   onTrackStart?: (queue: GuildMusicQueue, track: any) => void, onQueueEnd?: (queue: GuildMusicQueue) => void }} hooks
   */
  constructor(guildId, hooks) {
    this.guildId = guildId;
    this.hooks = hooks;
    this.connection = null;
    this.tracks = [];
    this.current = null;
    this.volume = CONFIG.music.defaultVolume;
    this.resource = null;
    this.stream = null;
    this.textChannelId = null;
    this.nowPlaying = null;
    this.nowPlayingLock = Promise.resolve();
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.idleTimer = null;

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.cleanupStream();
      this.current = null;
      void this.playNext();
    });
    this.player.on('error', (err) => {
      console.error('[MusicService] Error del reproductor:', err.message);
      this.cleanupStream();
      this.current = null;
      void this.playNext();
    });
  }

  get isPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  cleanupStream() {
    if (this.stream) {
      try { this.stream.kill?.(); } catch { /* ya terminado */ }
      this.stream = null;
    }
    this.resource = null;
  }

  async playNext() {
    clearTimeout(this.idleTimer);
    const next = this.tracks.shift();
    if (!next) {
      this.hooks.onQueueEnd?.(this);
      // Salir del canal si nadie añade música en un rato.
      this.idleTimer = setTimeout(() => this.hooks.onIdle(this.guildId), CONFIG.music.idleLeaveMs);
      return;
    }
    this.current = next;
    try {
      // Las canciones de Spotify se buscan en YouTube justo antes de sonar.
      if (!next.url) {
        const found = await this.hooks.resolver(next);
        if (!found) throw new Error(`Sin resultados en YouTube para "${next.title}"`);
        if (found.duration > CONFIG.music.maxDurationSeconds) {
          throw new Error(`"${found.title}" dura ${formatDuration(found.duration)}, supera el máximo permitido`);
        }
        next.url = found.url;
        next.duration = found.duration;
        next.thumbnail = found.thumbnail;
      }
      const proc = youtubeDl.exec(next.url, {
        output: '-',
        format: 'bestaudio/best',
        noPlaylist: true,
        quiet: true,
        noWarnings: true,
      }, { stdio: ['ignore', 'pipe', 'ignore'] });
      // tinyspawn devuelve una promesa; evitar rechazos sin manejar si se mata el proceso.
      proc.catch?.(() => {});
      this.stream = proc;
      this.resource = createAudioResource(proc.stdout, { inputType: StreamType.Arbitrary, inlineVolume: true });
      this.resource.volume?.setVolume(this.volume / 100);
      this.player.play(this.resource);
      this.hooks.onTrackStart?.(this, next);
    } catch (err) {
      console.error('[MusicService] No se pudo reproducir:', err.message);
      this.cleanupStream();
      this.current = null;
      await this.playNext();
    }
  }

  setVolume(level) {
    this.volume = Math.min(100, Math.max(0, level));
    this.resource?.volume?.setVolume(this.volume / 100);
  }

  destroy() {
    clearTimeout(this.idleTimer);
    this.tracks = [];
    this.current = null;
    this.player.removeAllListeners();
    this.player.stop(true);
    this.cleanupStream();
    try { this.connection?.destroy(); } catch { /* ya destruida */ }
    this.connection = null;
  }
}

export class MusicService {
  /**
   * @param {{ discord: import('./DiscordService.js').DiscordService,
   *   permissions?: (discordUserId: string, node: string) => Promise<true|false|undefined> }} deps
   */
  constructor({ discord, permissions = async (id, node) => (await luckPermsService.check('discord', [id], node)).result }) {
    this.discord = discord;
    this.permissions = permissions;
    /** @type {Map<string, GuildMusicQueue>} */
    this.queues = new Map();
    this.onInteraction = (interaction) => void this.handleInteraction(interaction)
      .catch((err) => console.error('[MusicService] Interacción:', err.message));
  }

  start() {
    if (!CONFIG.music.enabled) return;
    this.prepareError = null;
    this.ready = this.prepare();
    this.discord.on('interaction', this.onInteraction);
    this.discord.on('ready', () => {
      void this.discord.registerGuildCommands(musicCommands())
        .catch((err) => console.error('[MusicService] Registro de comandos:', err.message));
    });
  }

  /** Comprueba (y si hace falta descarga) yt-dlp y ffmpeg. No bloquea el arranque. */
  async prepare() {
    try {
      const [ytdlp, ffmpeg] = [await ensureYtDlp(), await ensureFfmpeg()];
      process.env.FFMPEG_PATH = ffmpeg;
      console.log(`🎵 [Music] Listo: yt-dlp ${ytdlp} · ffmpeg ${ffmpeg}`);
    } catch (err) {
      this.prepareError = err;
      console.error(`❌ [Music] La música no está disponible: ${err.message}`);
    }
  }

  stop() {
    this.discord.off('interaction', this.onInteraction);
    for (const queue of this.queues.values()) queue.destroy();
    this.queues.clear();
  }

  newQueue(guildId) {
    return new GuildMusicQueue(guildId, {
      onIdle: (id) => this.dropQueue(id),
      resolver: (track) => (track.spotify ? this.resolveSpotifyTrack(track.spotify) : this.resolveTrack(track.query)),
      onTrackStart: (queue, track) => this.postNowPlaying(queue, track),
      onQueueEnd: (queue) => this.finishNowPlaying(queue, 'La cola terminó'),
    });
  }

  dropQueue(guildId, reason = 'Música detenida') {
    const queue = this.queues.get(guildId);
    if (queue) this.finishNowPlaying(queue, reason);
    queue?.destroy();
    this.queues.delete(guildId);
  }

  /** Encola una tarea sobre el mensaje de reproducción para que nunca se pisen entre sí. */
  withNowPlaying(queue, task) {
    queue.nowPlayingLock = queue.nowPlayingLock.then(task).catch((err) => {
      console.warn('[MusicService] Mensaje de reproducción:', err.message);
    });
    return queue.nowPlayingLock;
  }

  /** Publica el mensaje con botones de la canción que empieza y retira el anterior. */
  postNowPlaying(queue, track) {
    if (!queue.textChannelId) return;
    return this.withNowPlaying(queue, async () => {
      const previous = queue.nowPlaying;
      queue.nowPlaying = null;
      await previous?.message.delete().catch(() => {});
      const channel = await this.discord.client.channels.fetch(queue.textChannelId);
      const message = await channel.send(buildNowPlayingMessage(queue, track, { paused: queue.isPaused }));
      queue.nowPlaying = { message, track };
    });
  }

  /** Deja el mensaje actual sin botones, con un texto final. */
  finishNowPlaying(queue, text) {
    return this.withNowPlaying(queue, async () => {
      const current = queue.nowPlaying;
      if (!current) return;
      queue.nowPlaying = null;
      await current.message.edit(buildNowPlayingMessage(queue, current.track, { finished: text }));
    });
  }

  /** Refresca el mensaje (pausa, volumen...) cuando el cambio vino de un comando de barra. */
  refreshNowPlaying(queue) {
    return this.withNowPlaying(queue, async () => {
      const current = queue.nowPlaying;
      if (!current) return;
      await current.message.edit(buildNowPlayingMessage(queue, current.track, { paused: queue.isPaused }));
    });
  }

  async resolveTrack(query) {
    const info = await youtubeDl(query, {
      dumpSingleJson: true,
      noPlaylist: true,
      defaultSearch: 'ytsearch1',
      noWarnings: true,
      quiet: true,
      format: 'bestaudio/best',
    });
    const entry = info?.entries ? info.entries[0] : info;
    if (!entry) return null;
    return {
      title: entry.title || 'Sin título',
      url: entry.webpage_url || entry.original_url || entry.url,
      duration: entry.duration || 0,
      thumbnail: entry.thumbnail || null,
    };
  }

  /** Busca en YouTube la versión de una pista de Spotify (varios candidatos, se elige el más fiel). */
  async resolveSpotifyTrack(wanted) {
    const query = `ytsearch8:${wanted.artist ? `${wanted.artist} - ${wanted.name}` : wanted.name}`;
    const info = await youtubeDl(query, {
      dumpSingleJson: true,
      flatPlaylist: true,
      noWarnings: true,
      quiet: true,
    });
    const entry = pickYouTubeMatch(info?.entries, wanted, CONFIG.music.maxDurationSeconds);
    if (!entry) return null;
    return {
      title: entry.title || wanted.name,
      url: entry.webpage_url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : entry.url),
      duration: entry.duration || 0,
      thumbnail: entry.thumbnails?.at(-1)?.url || entry.thumbnail || null,
    };
  }

  /** Convierte un enlace de Spotify en pistas por buscar en YouTube. */
  async resolveSpotify(url) {
    const tracks = await spotify.getTracks(url);
    return tracks
      .filter((t) => t?.name)
      .map((t) => ({
        title: t.artist ? `${t.artist} - ${t.name}` : t.name,
        spotify: { name: t.name, artist: t.artist || '', duration: t.duration ? Math.round(t.duration / 1000) : 0 },
        url: null,
        duration: t.duration ? Math.round(t.duration / 1000) : 0,
      }));
  }

  async handleInteraction(interaction) {
    if (interaction.isButton?.() && interaction.customId?.startsWith(MUSIC_BUTTON_PREFIX)) {
      return this.handleButton(interaction);
    }
    if (!interaction.isChatInputCommand() || !MUSIC_COMMAND_NAMES.has(interaction.commandName)) return;
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Los comandos de música solo funcionan en un servidor.', flags: 64 });
      return;
    }
    if (CONFIG.discord.guildId && interaction.guildId !== CONFIG.discord.guildId) return;

    const guildId = interaction.guildId;
    const queue = this.queues.get(guildId);
    const name = interaction.commandName;
    if (!(await this.allowed(interaction, name))) return;

    if (name === 'play') return this.handlePlay(interaction, queue);

    // El resto de comandos exigen estar en el mismo canal de voz que el bot.
    if (!queue) {
      await interaction.reply({ content: 'No hay música reproduciéndose.', flags: 64 });
      return;
    }
    if (name === 'cola') {
      await interaction.reply({ content: formatQueue(queue), flags: 64 });
      return;
    }

    const memberChannel = interaction.member?.voice?.channelId;
    if (!memberChannel || memberChannel !== queue.connection?.joinConfig.channelId) {
      await interaction.reply({ content: 'Debes estar en el mismo canal de voz que el bot.', flags: 64 });
      return;
    }

    switch (name) {
      case 'skip':
        queue.player.stop(true);
        await interaction.reply('⏭️ Canción saltada.');
        break;
      case 'stop':
        this.dropQueue(guildId);
        await interaction.reply('⏹️ Música detenida.');
        break;
      case 'pause':
        queue.player.pause();
        void this.refreshNowPlaying(queue);
        await interaction.reply('⏸️ Pausado.');
        break;
      case 'resume':
        queue.player.unpause();
        void this.refreshNowPlaying(queue);
        await interaction.reply('▶️ Reanudado.');
        break;
      case 'volumen': {
        const level = interaction.options.getInteger('nivel', true);
        queue.setVolume(level);
        void this.refreshNowPlaying(queue);
        await interaction.reply(`🔊 Volumen: ${level}%`);
        break;
      }
    }
  }

  /** Permiso de LuckPerms (impebot.music.*). Libre por defecto; solo un "false" explícito lo bloquea. */
  async allowed(interaction, name) {
    const perm = musicPermission(name);
    const result = await this.permissions(interaction.user.id, perm.node).catch(() => undefined);
    if (decide(perm, result)) return true;
    await interaction.reply({ content: `⛔ No tienes permiso para esto (${perm.node}).`, flags: 64 });
    return false;
  }

  /** Botones del mensaje "Reproduciendo ahora". */
  async handleButton(interaction) {
    if (!interaction.guildId || (CONFIG.discord.guildId && interaction.guildId !== CONFIG.discord.guildId)) return;
    const reply = (content) => interaction.reply({ content, flags: 64 });
    const queue = this.queues.get(interaction.guildId);
    const action = interaction.customId.slice(MUSIC_BUTTON_PREFIX.length);
    if (!(await this.allowed(interaction, action))) return;

    if (!queue || !queue.nowPlaying) {
      await reply('Esta reproducción ya terminó. Usa `/play` para empezar otra.');
      return;
    }
    if (action === 'queue') {
      await reply(formatQueue(queue));
      return;
    }
    if (interaction.message.id !== queue.nowPlaying.message.id) {
      await reply('Esos controles son de una canción anterior.');
      return;
    }
    const memberChannel = interaction.member?.voice?.channelId;
    if (!memberChannel || memberChannel !== queue.connection?.joinConfig.channelId) {
      await reply('Debes estar en el mismo canal de voz que el bot para usar los controles.');
      return;
    }

    const { track } = queue.nowPlaying;
    const who = interaction.member?.displayName || interaction.user.username;
    // update() edita el propio mensaje en la respuesta, sin depender del límite de 15 minutos del token.
    const refresh = () => interaction.update(buildNowPlayingMessage(queue, track, { paused: queue.isPaused }));

    switch (action) {
      case 'toggle':
        if (queue.isPaused) queue.player.unpause(); else queue.player.pause();
        await refresh();
        break;
      case 'skip':
        await interaction.deferUpdate();
        queue.player.stop(true);
        break;
      case 'stop':
        queue.nowPlaying = null;
        await interaction.update(buildNowPlayingMessage(queue, track, { finished: `Detenido por ${who}` }));
        this.dropQueue(interaction.guildId);
        break;
      case 'voldown':
        queue.setVolume(queue.volume - VOLUME_STEP);
        await refresh();
        break;
      case 'volup':
        queue.setVolume(queue.volume + VOLUME_STEP);
        await refresh();
        break;
      default:
        await reply('Botón desconocido.');
    }
  }

  async handlePlay(interaction, existing) {
    const voiceChannel = interaction.member?.voice?.channel;
    if (!voiceChannel) {
      await interaction.reply({ content: 'Únete primero a un canal de voz.', flags: 64 });
      return;
    }
    if (existing?.connection && existing.connection.joinConfig.channelId !== voiceChannel.id) {
      await interaction.reply({ content: 'Ya estoy reproduciendo en otro canal de voz.', flags: 64 });
      return;
    }

    await interaction.deferReply();
    await this.ready;
    if (this.prepareError) {
      await interaction.editReply('❌ La música no está disponible en este servidor ahora mismo (faltan componentes). Avisa al administrador.');
      return;
    }
    const input = interaction.options.getString('cancion', true).trim();
    let newTracks = [];
    let isSpotifyList = false;
    if (SPOTIFY_RE.test(input)) {
      isSpotifyList = !/\/track\//i.test(input);
      newTracks = await this.resolveSpotify(input).catch((err) => {
        console.error('[MusicService] Spotify:', err.message);
        return [];
      });
      if (!newTracks.length) {
        await interaction.editReply('No pude leer ese enlace de Spotify (¿es privado o una lista generada por Spotify?).');
        return;
      }
    } else {
      const track = await this.resolveTrack(input).catch((err) => {
        console.error('[MusicService] yt-dlp:', err.message?.split('\n')[0]);
        return null;
      });
      if (!track) {
        await interaction.editReply('No encontré esa canción.');
        return;
      }
      if (track.duration && track.duration > CONFIG.music.maxDurationSeconds) {
        await interaction.editReply(`La canción supera el máximo de ${Math.round(CONFIG.music.maxDurationSeconds / 60)} minutos.`);
        return;
      }
      newTracks = [track];
    }

    let queue = existing;
    if (!queue) {
      queue = this.newQueue(interaction.guildId);
      this.queues.set(interaction.guildId, queue);
    }
    const room = CONFIG.music.maxQueueSize - queue.tracks.length;
    if (room <= 0) {
      await interaction.editReply('La cola está llena.');
      return;
    }
    const truncated = newTracks.length > room;
    newTracks = newTracks.slice(0, room);

    // Los controles se publican en el canal de texto donde se pidió la música.
    queue.textChannelId = interaction.channelId;
    const requestedBy = interaction.member?.displayName || interaction.user.username;
    for (const t of newTracks) t.requestedBy = requestedBy;

    if (!queue.connection) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      queue.connection = connection;
      connection.subscribe(queue.player);
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          // Puede ser un cambio de canal: dar unos segundos para reconectar.
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch {
          this.dropQueue(interaction.guildId, 'Desconectado del canal de voz');
        }
      });
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 15000);
      } catch {
        this.dropQueue(interaction.guildId);
        await interaction.editReply('No pude conectarme al canal de voz (revisa permisos Conectar/Hablar).');
        return;
      }
    }

    const wasIdle = !queue.current && queue.player.state.status === AudioPlayerStatus.Idle;
    queue.tracks.push(...newTracks);
    const first = newTracks[0];
    const extra = truncated ? ' (cola llena, se recortó la lista)' : '';
    if (isSpotifyList) {
      await interaction.editReply(`➕ Se añadieron **${newTracks.length}** canciones de Spotify${extra}.`);
    } else if (wasIdle) {
      await interaction.editReply(`🎶 Pedida: **${first.title}** (${formatDuration(first.duration)})`);
    } else {
      await interaction.editReply(`➕ En cola (#${queue.tracks.length}): **${first.title}** (${formatDuration(first.duration)})`);
    }
    if (wasIdle) await queue.playNext();
  }
}
