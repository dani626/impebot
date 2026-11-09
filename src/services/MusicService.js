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
import { SlashCommandBuilder } from 'discord.js';
import youtubeDl from 'youtube-dl-exec';
import spotifyUrlInfo from 'spotify-url-info';
import { CONFIG } from '../config.js';

const require = createRequire(import.meta.url);
const spotify = spotifyUrlInfo(fetch);
const SPOTIFY_RE = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|album|playlist)\//i;

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

function formatDuration(seconds) {
  if (!seconds) return '?:??';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

class GuildMusicQueue {
  constructor(guildId, onIdle, resolver) {
    this.guildId = guildId;
    this.resolver = resolver;
    this.connection = null;
    this.tracks = [];
    this.current = null;
    this.volume = CONFIG.music.defaultVolume;
    this.resource = null;
    this.stream = null;
    this.onIdle = onIdle;
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
      // Salir del canal si nadie añade música en un rato.
      this.idleTimer = setTimeout(() => this.onIdle(this.guildId), CONFIG.music.idleLeaveMs);
      return;
    }
    this.current = next;
    try {
      // Las canciones de Spotify se buscan en YouTube justo antes de sonar.
      if (!next.url) {
        const found = await this.resolver(next.query);
        if (!found) throw new Error(`Sin resultados en YouTube para "${next.query}"`);
        next.url = found.url;
        next.duration = found.duration;
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
      next.onStart?.(next);
    } catch (err) {
      console.error('[MusicService] No se pudo reproducir:', err.message);
      this.cleanupStream();
      this.current = null;
      await this.playNext();
    }
  }

  setVolume(level) {
    this.volume = level;
    this.resource?.volume?.setVolume(level / 100);
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
  /** @param {{ discord: import('./DiscordService.js').DiscordService }} deps */
  constructor({ discord }) {
    this.discord = discord;
    /** @type {Map<string, GuildMusicQueue>} */
    this.queues = new Map();
    this.onInteraction = (interaction) => void this.handleInteraction(interaction)
      .catch((err) => console.error('[MusicService] Interacción:', err.message));
  }

  start() {
    if (!CONFIG.music.enabled) return;
    this.discord.on('interaction', this.onInteraction);
    this.discord.on('ready', () => {
      void this.discord.registerGuildCommands(musicCommands())
        .catch((err) => console.error('[MusicService] Registro de comandos:', err.message));
    });
  }

  stop() {
    this.discord.off('interaction', this.onInteraction);
    for (const queue of this.queues.values()) queue.destroy();
    this.queues.clear();
  }

  dropQueue(guildId) {
    this.queues.get(guildId)?.destroy();
    this.queues.delete(guildId);
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
    };
  }

  /** Convierte un enlace de Spotify en pistas por buscar en YouTube. */
  async resolveSpotify(url) {
    const tracks = await spotify.getTracks(url);
    return tracks
      .filter((t) => t?.name)
      .map((t) => ({
        title: t.artist ? `${t.artist} - ${t.name}` : t.name,
        query: `ytsearch1:${t.artist ? `${t.artist} - ${t.name}` : t.name} audio`,
        url: null,
        duration: 0,
      }));
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || !MUSIC_COMMAND_NAMES.has(interaction.commandName)) return;
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Los comandos de música solo funcionan en un servidor.', flags: 64 });
      return;
    }
    if (CONFIG.discord.guildId && interaction.guildId !== CONFIG.discord.guildId) return;

    const guildId = interaction.guildId;
    const queue = this.queues.get(guildId);
    const name = interaction.commandName;

    if (name === 'play') return this.handlePlay(interaction, queue);

    // El resto de comandos exigen estar en el mismo canal de voz que el bot.
    if (!queue) {
      await interaction.reply({ content: 'No hay música reproduciéndose.', flags: 64 });
      return;
    }
    if (name === 'cola') {
      const lines = [];
      if (queue.current) lines.push(`▶️ **${queue.current.title}** (${formatDuration(queue.current.duration)})`);
      queue.tracks.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title} (${formatDuration(t.duration)})`));
      if (queue.tracks.length > 10) lines.push(`… y ${queue.tracks.length - 10} más`);
      await interaction.reply({ content: lines.join('\n') || 'La cola está vacía.', flags: 64 });
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
        await interaction.reply('⏸️ Pausado.');
        break;
      case 'resume':
        queue.player.unpause();
        await interaction.reply('▶️ Reanudado.');
        break;
      case 'volumen': {
        const level = interaction.options.getInteger('nivel', true);
        queue.setVolume(level);
        await interaction.reply(`🔊 Volumen: ${level}%`);
        break;
      }
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
      queue = new GuildMusicQueue(interaction.guildId, (id) => this.dropQueue(id), (q) => this.resolveTrack(q));
      this.queues.set(interaction.guildId, queue);
    }
    const room = CONFIG.music.maxQueueSize - queue.tracks.length;
    if (room <= 0) {
      await interaction.editReply('La cola está llena.');
      return;
    }
    const truncated = newTracks.length > room;
    newTracks = newTracks.slice(0, room);

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
          this.dropQueue(interaction.guildId);
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
      await interaction.editReply(`🎶 Reproduciendo: **${first.title}** (${formatDuration(first.duration)})`);
    } else {
      await interaction.editReply(`➕ En cola (#${queue.tracks.length}): **${first.title}** (${formatDuration(first.duration)})`);
    }
    if (wasIdle) await queue.playNext();
  }
}
