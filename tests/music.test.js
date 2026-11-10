import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioPlayerStatus } from '@discordjs/voice';
import { MusicService, buildNowPlayingMessage, formatQueue, pickYouTubeMatch } from '../src/services/MusicService.js';

const TRACK = { title: 'Canción de prueba', url: 'https://youtu.be/x', duration: 125, requestedBy: 'Ana' };

function fakeQueue({ paused = false } = {}) {
  const calls = [];
  const queue = {
    volume: 50,
    tracks: [{ title: 'Siguiente', duration: 60 }],
    current: TRACK,
    connection: { joinConfig: { channelId: 'VC1' } },
    nowPlaying: { message: { id: 'MSG1' }, track: TRACK },
    player: {
      state: { status: paused ? AudioPlayerStatus.Paused : AudioPlayerStatus.Playing },
      pause() { calls.push('pause'); this.state.status = AudioPlayerStatus.Paused; },
      unpause() { calls.push('unpause'); this.state.status = AudioPlayerStatus.Playing; },
      stop() { calls.push('stop'); },
    },
    get isPaused() { return this.player.state.status === AudioPlayerStatus.Paused; },
    setVolume(level) { this.volume = Math.min(100, Math.max(0, level)); calls.push(`vol:${this.volume}`); },
  };
  return { queue, calls };
}

function fakeButton(customId, { voice = 'VC1', messageId = 'MSG1' } = {}) {
  const out = { replies: [], updates: [], deferred: 0 };
  return {
    out,
    interaction: {
      customId, guildId: 'G1', user: { id: 'U1', username: 'ana' },
      member: { displayName: 'Ana', voice: { channelId: voice } },
      message: { id: messageId },
      isButton: () => true,
      reply: async (r) => { out.replies.push(r); },
      update: async (u) => { out.updates.push(u); },
      deferUpdate: async () => { out.deferred += 1; },
    },
  };
}

function serviceWith(queue) {
  const svc = new MusicService({ discord: { on() {}, off() {} } });
  svc.queues.set('G1', queue);
  svc.dropQueue = () => { queue.dropped = true; };
  return svc;
}

test('el mensaje de reproducción trae 6 botones y el estado de pausa cambia el primero', () => {
  const { queue } = fakeQueue();
  const playing = buildNowPlayingMessage(queue, TRACK);
  const buttons = playing.components.flatMap((row) => row.toJSON().components);
  assert.equal(buttons.length, 6);
  assert.deepEqual(buttons.map((b) => b.custom_id), ['music:toggle', 'music:skip', 'music:stop', 'music:voldown', 'music:volup', 'music:queue']);
  assert.equal(buttons[0].label, 'Pausar');
  assert.ok(buttons.every((b) => !b.disabled));

  const paused = buildNowPlayingMessage(queue, TRACK, { paused: true }).components[0].toJSON().components[0];
  assert.equal(paused.label, 'Reanudar');
});

test('al terminar la reproducción los botones quedan desactivados', () => {
  const { queue } = fakeQueue();
  const done = buildNowPlayingMessage(queue, TRACK, { finished: 'La cola terminó' });
  const buttons = done.components.flatMap((row) => row.toJSON().components);
  assert.ok(buttons.every((b) => b.disabled));
  assert.equal(done.embeds[0].toJSON().footer.text, 'La cola terminó');
});

test('botón pausar/reanudar alterna el estado y actualiza el mensaje', async () => {
  const { queue, calls } = fakeQueue();
  const svc = serviceWith(queue);
  const { interaction, out } = fakeButton('music:toggle');
  await svc.handleInteraction(interaction);
  assert.deepEqual(calls, ['pause']);
  assert.equal(out.updates.length, 1);
  assert.equal(out.updates[0].components[0].toJSON().components[0].label, 'Reanudar');

  const second = fakeButton('music:toggle');
  await svc.handleInteraction(second.interaction);
  assert.deepEqual(calls, ['pause', 'unpause']);
});

test('botones de volumen suben y bajan de 10 en 10 sin salirse de 0-100', async () => {
  const { queue, calls } = fakeQueue();
  const svc = serviceWith(queue);
  await svc.handleInteraction(fakeButton('music:volup').interaction);
  await svc.handleInteraction(fakeButton('music:voldown').interaction);
  await svc.handleInteraction(fakeButton('music:voldown').interaction);
  assert.deepEqual(calls, ['vol:60', 'vol:50', 'vol:40']);
  queue.volume = 100;
  await svc.handleInteraction(fakeButton('music:volup').interaction);
  assert.equal(queue.volume, 100);
});

test('saltar y detener funcionan; detener cierra el mensaje y la cola', async () => {
  const { queue, calls } = fakeQueue();
  const svc = serviceWith(queue);
  const skip = fakeButton('music:skip');
  await svc.handleInteraction(skip.interaction);
  assert.deepEqual(calls, ['stop']);
  assert.equal(skip.out.deferred, 1);

  const stop = fakeButton('music:stop');
  await svc.handleInteraction(stop.interaction);
  assert.equal(queue.dropped, true);
  assert.equal(stop.out.updates[0].embeds[0].toJSON().footer.text, 'Detenido por Ana');
});

test('quien no está en el canal de voz del bot, o usa controles viejos, no puede controlar', async () => {
  const { queue, calls } = fakeQueue();
  const svc = serviceWith(queue);

  const outsider = fakeButton('music:skip', { voice: 'OTRO' });
  await svc.handleInteraction(outsider.interaction);
  assert.equal(calls.length, 0);
  assert.equal(outsider.out.replies[0].flags, 64);

  const stale = fakeButton('music:skip', { messageId: 'VIEJO' });
  await svc.handleInteraction(stale.interaction);
  assert.equal(calls.length, 0);
  assert.match(stale.out.replies[0].content, /anterior/);
});

test('el botón de cola es público para cualquiera y los controles tras terminar avisan', async () => {
  const { queue } = fakeQueue();
  const svc = serviceWith(queue);
  const q = fakeButton('music:queue', { voice: null });
  await svc.handleInteraction(q.interaction);
  assert.match(q.out.replies[0].content, /Canción de prueba/);
  assert.match(formatQueue(queue), /Siguiente/);

  svc.queues.clear();
  const gone = fakeButton('music:skip');
  await svc.handleInteraction(gone.interaction);
  assert.match(gone.out.replies[0].content, /ya terminó/);
});

// Resultados reales de YouTube para "Astrofónicos - Ayahuasca" (Spotify: 3:16).
const results = [
  { title: 'Experience The Ayahuasca Trip with Psychoactive Frequency Music - Shaman Meditation', duration: 34879 },
  { title: 'Ayahuasca | Astrofonicos', duration: 197 },
  { title: 'Astrofónicos - Dejar de pensar', channel: 'AstrofonicosVEVO', duration: 160 },
  { title: 'Astrofonicos - Tu Dolor', channel: 'AstrofonicosVEVO', duration: 203 },
];

test('pickYouTubeMatch elige la canción y no la meditación de 9 horas', () => {
  const pick = pickYouTubeMatch(results, { name: 'Ayahuasca', artist: 'Astrofónicos', duration: 196 }, 3600);
  assert.equal(pick.title, 'Ayahuasca | Astrofonicos');
});

test('pickYouTubeMatch prefiere el título correcto aunque otra pista dure parecido', () => {
  const pick = pickYouTubeMatch(results, { name: 'Tu Dolor', artist: 'Astrofónicos', duration: 200 }, 3600);
  assert.equal(pick.title, 'Astrofonicos - Tu Dolor');
});

test('pickYouTubeMatch descarta resultados que superan el máximo o no se parecen', () => {
  assert.equal(pickYouTubeMatch([results[0]], { name: 'Ayahuasca', artist: 'Astrofónicos', duration: 196 }, 3600), null);
  assert.equal(pickYouTubeMatch([{ title: 'Otra cosa', duration: 600 }], { name: 'Ayahuasca', artist: 'X', duration: 196 }), null);
});

test('sale del canal de voz cuando se queda sin personas, y no si alguien vuelve', async (t) => {
  const { CONFIG } = await import('../src/config.js');
  const previous = CONFIG.music.emptyLeaveMs;
  t.after(() => { CONFIG.music.emptyLeaveMs = previous; });
  CONFIG.music.emptyLeaveMs = 10;

  const members = new Map();
  const channel = { members: { filter: (fn) => ({ size: [...members.values()].filter(fn).length }) } };
  const svc = new MusicService({ discord: { on() {}, off() {}, client: { channels: { cache: { get: (id) => (id === 'VC1' ? channel : null) } } } } });
  const { queue } = fakeQueue();
  svc.queues.set('G1', queue);
  const dropped = [];
  svc.dropQueue = (guildId, reason) => { dropped.push(reason); svc.queues.delete(guildId); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  members.set('bot', { user: { bot: true } });
  members.set('ana', { user: { bot: false } });
  svc.onVoiceState(null, { guild: { id: 'G1' } });
  await wait(20);
  assert.deepEqual(dropped, [], 'con alguien escuchando sigue');

  members.delete('ana');
  svc.onVoiceState({ guild: { id: 'G1' } }, null);
  members.set('ana', { user: { bot: false } });
  svc.onVoiceState(null, { guild: { id: 'G1' } });
  await wait(20);
  assert.deepEqual(dropped, [], 'si vuelve antes de que pase el tiempo, se queda');

  members.delete('ana');
  svc.onVoiceState({ guild: { id: 'G1' } }, null);
  await wait(20);
  assert.deepEqual(dropped, ['Todos salieron del canal de voz'], 'solo quedan bots: sale');
});
