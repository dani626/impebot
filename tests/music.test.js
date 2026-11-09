import test from 'node:test';
import assert from 'node:assert/strict';
import { pickYouTubeMatch } from '../src/services/MusicService.js';

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
