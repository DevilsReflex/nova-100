// Bot AI: keeps the arena full and gives humans something to fight.
// Each tick a bot finds its nearest living target, aims with lead, and
// thrusts to a preferred engagement distance while strafing to dodge.
import { WORLD, BOT_VIEW, BULLET_SPEED } from './constants.js';

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

export function thinkBots(game) {
  botSeq++;
  for (const s of game.ships.values()) {
    if (!s.isBot || !s.alive) continue;

    // find nearest living enemy within awareness range
    let target = null, best = BOT_VIEW * BOT_VIEW;
    for (const o of game.ships.values()) {
      if (o === s || !o.alive) continue;
      const dx = o.x - s.x, dy = o.y - s.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) { best = d2; target = o; }
    }

    if (!target) {
      // wander toward arena center-ish with gentle drift
      s.input.mx = Math.cos(botSeq * 0.013 + s.id) * 0.5;
      s.input.my = Math.sin(botSeq * 0.017 + s.id) * 0.5;
      s.input.shoot = false;
      return;
    }

    const dx = target.x - s.x, dy = target.y - s.y;
    const dist = Math.hypot(dx, dy) || 1;

    // lead the target by its velocity over bullet travel time
    const t = dist / BULLET_SPEED;
    const ax = target.x + target.vx * t - s.x;
    const ay = target.y + target.vy * t - s.y;
    s.input.aim = Math.atan2(ay, ax);

    // movement: hold a ~520px engagement ring, strafe to be a hard target
    const ideal = 520;
    const radial = dist > ideal ? 1 : -1;       // approach or back off
    const nx = dx / dist, ny = dy / dist;
    const strafe = Math.sin(botSeq * 0.05 + s.id) * 0.9;
    s.input.mx = nx * radial * 0.8 + (-ny) * strafe;
    s.input.my = ny * radial * 0.8 + (nx) * strafe;

    // fire when roughly facing the target and in range
    const aimErr = Math.abs(normAngle(Math.atan2(ay, ax) - Math.atan2(dy, dx)));
    s.input.shoot = dist < BOT_VIEW && aimErr < 0.25;
  }
}

function normAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function topUpBots(game, target, addShip) {
  const count = game.ships.size;
  let toAdd = target - count;
  let i = count;
  while (toAdd-- > 0) {
    addShip({ name: botName(i++), isBot: true });
  }
}
