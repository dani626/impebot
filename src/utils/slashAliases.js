/**
 * Alias en inglés/español de los slash commands de Discord: alias → nombre canónico
 * (el que usan los manejadores). Se registran ambos nombres en el servidor.
 */
export const SLASH_ALIASES = {
  reproducir: 'play',
  saltar: 'skip',
  detener: 'stop',
  pausar: 'pause',
  reanudar: 'resume',
  queue: 'cola',
  volume: 'volumen',
  mirror: 'espejo',
  reply: 'responder',
  note: 'nota',
  claim: 'tomar',
  release: 'soltar',
  close: 'cerrar',
  reopen: 'reabrir',
  priority: 'prioridad',
};

/** Duplica cada comando con sus alias para registrarlos en Discord. */
export function withSlashAliases(commands) {
  const out = [...commands];
  for (const command of commands) {
    for (const [alias, canonical] of Object.entries(SLASH_ALIASES)) {
      if (command.name === canonical) out.push({ ...command, name: alias });
    }
  }
  return out;
}
