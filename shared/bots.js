// Bot AI for asteroid mining. Each bot scoops up a nearby material drop if one
// is close, otherwise flies to the nearest asteroid and holds fire to shatter
// it. Bots are immune to meteor collisions (see game.js), so they don't clutter
// the field with respawns.
import { BOT_VIEW } from './constants.js';

const BOT_NAMES = [
  'Vega', 'Orion', 'Lyra', 'Draco', 'Nova', 'Rigel', 'Atlas', 'Cygnus',
  'Hydra', 'Phoenix', 'Corvus', 'Lupus', 'Apus', 'Mensa', 'Pavo', 'Tucana',
  'Volans', 'Carina', 'Crux', 'Aquila', 'Cetus', 'Dorado', 'Fornax', 'Grus',
];

let botSeq = 0;

export function botName(i) {
  const base = BOT_NAMES[i % BOT_NAMES.length];
  const tag = Math.floor(i / BOT_NAMES.length);
  return tag ? `${base}-${tag}` : base;
}

const RETARGET_TICKS = 8;

export function thinkBots(game) {
  botSeq++;
  for (const s of game.ships.values()) {
    if (!s.isBot || !s.alive) continue;

    // 1) a material drop nearby? go scoop it.
    let mat = null, mbest = (BOT_VIEW * 0.6) * (BOT_VIEW * 0.6);
    for (const m of game.mats) {
      const dx = m.x - s.x, dy = m.y - s.y, d2 = dx * dx + dy * dy;
      if (d2 < mbest) { mbest = d2; mat = m; }
    }
    if (mat) {
      const dx = mat.x - s.x, dy = mat.y - s.y, d = Math.hypot(dx, dy) || 1;
      s.input.mx = dx / d; s.input.my = dy / d;
      s.input.aim = Math.atan2(dy, dx);
      s.input.shoot = false;
      continue;
    }

    // 2) otherwise mine the nearest asteroid (cached target, re-scanned periodically)
    let rock = s._rock != null ? game.rocks.get(s._rock) : null;
    if (!rock || (botSeq + s.id) % RETARGET_TICKS === 0) {
      let bestId = null, best = BOT_VIEW * BOT_VIEW;
      for (const r of game.rocks.values()) {
        const dx = r.x - s.x, dy = r.y - s.y, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; bestId = r.id; }
      }
      s._rock = bestId;
      rock = bestId != null ? game.rocks.get(bestId) : null;
    }

    if (!rock) {
      s.input.mx = Math.cos(botSeq * 0.013 + s.id) * 0.5;
      s.input.my = Math.sin(botSeq * 0.017 + s.id) * 0.5;
      s.input.shoot = false;
      continue;
    }

    const dx = rock.x - s.x, dy = rock.y - s.y, dist = Math.hypot(dx, dy) || 1;
    s.input.aim = Math.atan2(dy, dx);
    const ideal = rock.radius + 280;             // hold a firing stand-off distance
    const radial = dist > ideal ? 1 : -0.6;
    const nx = dx / dist, ny = dy / dist;
    const strafe = Math.sin(botSeq * 0.04 + s.id) * 0.5;
    s.input.mx = nx * radial + (-ny) * strafe;
    s.input.my = ny * radial + (nx) * strafe;
    s.input.shoot = dist < BOT_VIEW;             // hold to charge & fire at the rock
  }
}
