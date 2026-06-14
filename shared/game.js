// Authoritative game simulation for Nova 100.
// Holds all ships (human + bot) and bullets, steps physics, resolves combat.
import {
  WORLD, DT, SHIP_RADIUS, ACCEL, MAX_SPEED, FRICTION, SHIP_MAX_HP,
  RESPAWN_MS, BULLET_SPEED, BULLET_TTL, BULLET_RADIUS, BULLET_DAMAGE,
  FIRE_COOLDOWN_MS,
} from './constants.js';

let nextId = 1;
let nextBulletId = 1;

const COLORS = [
  '#5ad1ff', '#ff6b6b', '#ffd166', '#06d6a0', '#c77dff', '#ff9f1c',
  '#4cc9f0', '#f72585', '#90be6d', '#f8961e', '#577590', '#e0aaff',
];

export class Ship {
  constructor({ name, isBot }) {
    this.id = nextId++;
    this.name = name || `Pilot-${this.id}`;
    this.isBot = !!isBot;
    this.color = COLORS[this.id % COLORS.length];
    this.score = 0;
    this.kills = 0;
    this.deaths = 0;
    this.cooldown = 0;          // ms until next shot allowed
    this.respawnAt = 0;         // timestamp; 0 = alive
    // input state (set by network for humans, by AI for bots)
    this.input = { mx: 0, my: 0, aim: 0, shoot: false, seq: 0 };
    this.lastSeq = 0;
    this.spawn();
  }

  spawn() {
    this.x = Math.random() * WORLD.w;
    this.y = Math.random() * WORLD.h;
    this.vx = 0;
    this.vy = 0;
    this.angle = Math.random() * Math.PI * 2;
    this.hp = SHIP_MAX_HP;
    this.respawnAt = 0;
  }

  get alive() { return this.respawnAt === 0; }
}

export class Game {
  constructor() {
    this.ships = new Map();   // id -> Ship
    this.bullets = [];        // active projectiles
    this.events = [];         // transient events (kills, hits) for this tick
  }

  addShip(opts) {
    const s = new Ship(opts);
    this.ships.set(s.id, s);
    return s;
  }

  removeShip(id) { this.ships.delete(id); }

  // Apply a validated input packet from a human client.
  applyInput(id, input) {
    const s = this.ships.get(id);
    if (!s || s.isBot) return;
    // ignore stale/out-of-order packets
    if (input.seq <= s.lastSeq) return;
    s.lastSeq = input.seq;
    // clamp movement vector to unit length
    let { mx = 0, my = 0 } = input;
    const m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; }
    s.input = {
      mx, my,
      aim: Number.isFinite(input.aim) ? input.aim : s.input.aim,
      shoot: !!input.shoot,
      seq: input.seq,
    };
  }

  step(now) {
    this.events.length = 0;

    // --- integrate ships ---
    for (const s of this.ships.values()) {
      if (!s.alive) {
        if (now >= s.respawnAt) s.spawn();
        continue;
      }
      const inp = s.input;
      s.vx += inp.mx * ACCEL * DT;
      s.vy += inp.my * ACCEL * DT;
      const sp = Math.hypot(s.vx, s.vy);
      if (sp > MAX_SPEED) { s.vx = s.vx / sp * MAX_SPEED; s.vy = s.vy / sp * MAX_SPEED; }
      s.vx *= FRICTION; s.vy *= FRICTION;
      s.x += s.vx * DT; s.y += s.vy * DT;
      // clamp to arena bounds (walls)
      if (s.x < SHIP_RADIUS) { s.x = SHIP_RADIUS; s.vx = 0; }
      if (s.x > WORLD.w - SHIP_RADIUS) { s.x = WORLD.w - SHIP_RADIUS; s.vx = 0; }
      if (s.y < SHIP_RADIUS) { s.y = SHIP_RADIUS; s.vy = 0; }
      if (s.y > WORLD.h - SHIP_RADIUS) { s.y = WORLD.h - SHIP_RADIUS; s.vy = 0; }
      s.angle = inp.aim;

      if (s.cooldown > 0) s.cooldown -= DT * 1000;
      if (inp.shoot && s.cooldown <= 0) {
        this.fire(s);
        s.cooldown = FIRE_COOLDOWN_MS;
      }
    }

    // --- integrate bullets (remember the pre-move point for swept collision) ---
    for (const b of this.bullets) {
      b.px = b.x; b.py = b.y;
      b.x += b.vx * DT; b.y += b.vy * DT;
      b.ttl -= DT;
    }

    // --- bullet vs ship collisions (swept: test the whole step segment so a
    //     fast/large missile can't tunnel through a ship between ticks) ---
    const rr = SHIP_RADIUS + BULLET_RADIUS;
    for (const b of this.bullets) {
      if (b.ttl <= 0) continue;
      for (const s of this.ships.values()) {
        if (!s.alive || s.id === b.owner) continue;
        if (segDistSq(b.px, b.py, b.x, b.y, s.x, s.y) <= rr * rr) {
          b.ttl = 0;
          s.hp -= BULLET_DAMAGE;
          this.events.push({ t: 'hit', x: b.x, y: b.y });
          if (s.hp <= 0) this.kill(s, b.owner, now);
          break;
        }
      }
    }

    this.bullets = this.bullets.filter(b => b.ttl > 0);
  }

  fire(s) {
    const vx = Math.cos(s.angle) * BULLET_SPEED + s.vx;
    const vy = Math.sin(s.angle) * BULLET_SPEED + s.vy;
    this.bullets.push({
      id: nextBulletId++,
      owner: s.id,
      x: s.x + Math.cos(s.angle) * (SHIP_RADIUS + 2),
      y: s.y + Math.sin(s.angle) * (SHIP_RADIUS + 2),
      vx, vy,
      ttl: BULLET_TTL,
      color: s.color,
    });
  }

  kill(victim, killerId, now) {
    victim.deaths++;
    victim.respawnAt = now + RESPAWN_MS;
    const killer = this.ships.get(killerId);
    if (killer && killer !== victim) {
      killer.kills++;
      killer.score += 100;
    }
    this.events.push({
      t: 'kill', x: victim.x, y: victim.y,
      killer: killer ? killer.name : '???', victim: victim.name,
    });
  }
}

// squared distance from point (cx,cy) to segment (x1,y1)-(x2,y2)
function segDistSq(x1, y1, x2, y2, cx, cy) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((cx - x1) * dx + (cy - y1) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = cx - (x1 + dx * t), ey = cy - (y1 + dy * t);
  return ex * ex + ey * ey;
}
