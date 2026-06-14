// Authoritative game simulation for Nova 100 — asteroid mining.
// Players fly, shoot asteroids to shatter them, and collect the materials that
// burst out by flying over them. Holds all ships, bullets, asteroids ("rocks")
// and material drops; steps physics; resolves mining + collection.
import {
  WORLD, DT, SHIP_RADIUS, ACCEL, MAX_SPEED, FRICTION, CHARGE_MS, RESPAWN_MS,
  BULLET_SPEED, BULLET_TTL, BULLET_RADIUS, BULLET_DAMAGE,
  TYPES, ASTEROID_COUNT, ASTEROID_R_MIN, ASTEROID_R_MAX, ASTEROID_SPLIT_MIN_R,
  ASTEROID_DRIFT, ASTEROID_HP_K,
  MATERIAL_TTL, MATERIAL_EJECT, MATERIAL_FRICTION,
  COLLECT_RADIUS, MAGNET_RADIUS, MAGNET_ACCEL,
} from './constants.js';

let nextId = 1, nextBulletId = 1, nextRockId = 1, nextMatId = 1;

const SHIP_COLORS = [
  '#5ad1ff', '#ff6b6b', '#ffd166', '#06d6a0', '#c77dff', '#ff9f1c',
  '#4cc9f0', '#f72585', '#90be6d', '#f8961e', '#577590', '#e0aaff',
];

const TOTAL_WEIGHT = TYPES.reduce((a, t) => a + t.weight, 0);
function pickType() {
  let r = Math.random() * TOTAL_WEIGHT;
  for (let i = 0; i < TYPES.length; i++) { r -= TYPES[i].weight; if (r <= 0) return i; }
  return 0;
}

export class Ship {
  constructor({ name, isBot }) {
    this.id = nextId++;
    this.name = name || `Pilot-${this.id}`;
    this.isBot = !!isBot;
    this.color = SHIP_COLORS[this.id % SHIP_COLORS.length];
    this.score = 0;                 // total value of materials collected
    this.cargo = {};                // type index -> count collected
    this.charge = 0;                // ms the fire button has been held
    this.input = { mx: 0, my: 0, aim: 0, shoot: false, seq: 0 };
    this.lastSeq = 0;
    this.respawnAt = 0;             // 0 = alive; else timestamp to respawn at
    this.spawn();
  }
  spawn() {
    this.x = Math.random() * WORLD.w;
    this.y = Math.random() * WORLD.h;
    this.vx = 0; this.vy = 0;
    this.angle = Math.random() * Math.PI * 2;
    this.charge = 0;
    this.respawnAt = 0;
  }
  get alive() { return this.respawnAt === 0; }
}

export class Game {
  constructor() {
    this.ships = new Map();   // id -> Ship
    this.bullets = [];        // active slugs
    this.rocks = new Map();   // id -> asteroid
    this.mats = [];           // material drops
    this.events = [];         // transient events (hit/boom/pickup) for this tick
    for (let i = 0; i < ASTEROID_COUNT; i++) this.spawnRock();
  }

  addShip(opts) { const s = new Ship(opts); this.ships.set(s.id, s); return s; }
  removeShip(id) { this.ships.delete(id); }

  applyInput(id, input) {
    const s = this.ships.get(id);
    if (!s || s.isBot) return;
    if (input.seq <= s.lastSeq) return;          // ignore stale packets
    s.lastSeq = input.seq;
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

  spawnRock(opts = {}) {
    const type = opts.type != null ? opts.type : pickType();
    const radius = opts.radius != null ? opts.radius
      : ASTEROID_R_MIN + Math.random() * (ASTEROID_R_MAX - ASTEROID_R_MIN);
    const x = opts.x != null ? opts.x : radius + Math.random() * (WORLD.w - 2 * radius);
    const y = opts.y != null ? opts.y : radius + Math.random() * (WORLD.h - 2 * radius);
    const a = Math.random() * Math.PI * 2, sp = Math.random() * ASTEROID_DRIFT;
    const hp = opts.hp != null ? opts.hp
      : Math.max(8, Math.round(radius * TYPES[type].hard * ASTEROID_HP_K));
    const rock = {
      id: nextRockId++, type, x, y, radius, hp, maxHp: hp,
      vx: opts.vx != null ? opts.vx : Math.cos(a) * sp,
      vy: opts.vy != null ? opts.vy : Math.sin(a) * sp,
    };
    this.rocks.set(rock.id, rock);
    return rock;
  }

  fire(s) {
    const vx = Math.cos(s.angle) * BULLET_SPEED + s.vx;
    const vy = Math.sin(s.angle) * BULLET_SPEED + s.vy;
    this.bullets.push({
      id: nextBulletId++, owner: s.id,
      x: s.x + Math.cos(s.angle) * (SHIP_RADIUS + 2),
      y: s.y + Math.sin(s.angle) * (SHIP_RADIUS + 2),
      vx, vy, ttl: BULLET_TTL, color: s.color,
    });
  }

  step(now) {
    this.events.length = 0;

    // --- ships: movement + charge fire + meteor collision ---
    // The movement integration MUST stay byte-for-byte identical to the client's
    // stepLocal() so prediction is exact (no jitter). Touching an asteroid
    // destroys the ship — a discrete event the client reconciles cleanly, not a
    // per-tick position nudge.
    for (const s of this.ships.values()) {
      if (!s.alive) { if (now >= s.respawnAt) s.spawn(); continue; }
      const inp = s.input;
      s.vx += inp.mx * ACCEL * DT;
      s.vy += inp.my * ACCEL * DT;
      const sp = Math.hypot(s.vx, s.vy);
      if (sp > MAX_SPEED) { s.vx = s.vx / sp * MAX_SPEED; s.vy = s.vy / sp * MAX_SPEED; }
      s.vx *= FRICTION; s.vy *= FRICTION;
      s.x += s.vx * DT; s.y += s.vy * DT;
      s.x = Math.max(SHIP_RADIUS, Math.min(WORLD.w - SHIP_RADIUS, s.x));
      s.y = Math.max(SHIP_RADIUS, Math.min(WORLD.h - SHIP_RADIUS, s.y));
      s.angle = inp.aim;

      if (inp.shoot) {
        s.charge += DT * 1000;
        if (s.charge >= CHARGE_MS) { this.fire(s); s.charge = 0; }
      } else s.charge = 0;

      // hit an asteroid → explode, respawn after RESPAWN_MS
      for (const r of this.rocks.values()) {
        const dx = s.x - r.x, dy = s.y - r.y, rr = SHIP_RADIUS + r.radius;
        if (dx * dx + dy * dy <= rr * rr) {
          this.events.push({ t: 'ship', x: s.x, y: s.y });
          s.respawnAt = now + RESPAWN_MS; s.vx = 0; s.vy = 0; s.charge = 0;
          break;
        }
      }
    }

    // --- asteroids drift + bounce off arena walls ---
    for (const r of this.rocks.values()) {
      r.x += r.vx * DT; r.y += r.vy * DT;
      if (r.x < r.radius) { r.x = r.radius; r.vx = Math.abs(r.vx); }
      if (r.x > WORLD.w - r.radius) { r.x = WORLD.w - r.radius; r.vx = -Math.abs(r.vx); }
      if (r.y < r.radius) { r.y = r.radius; r.vy = Math.abs(r.vy); }
      if (r.y > WORLD.h - r.radius) { r.y = WORLD.h - r.radius; r.vy = -Math.abs(r.vy); }
    }

    // --- bullets integrate (remember pre-move point for swept collision) ---
    for (const b of this.bullets) {
      b.px = b.x; b.py = b.y;
      b.x += b.vx * DT; b.y += b.vy * DT;
      b.ttl -= DT;
    }
    // --- bullet vs asteroid (swept) ---
    for (const b of this.bullets) {
      if (b.ttl <= 0) continue;
      for (const r of this.rocks.values()) {
        const rr = r.radius + BULLET_RADIUS;
        if (segDistSq(b.px, b.py, b.x, b.y, r.x, r.y) <= rr * rr) {
          b.ttl = 0;
          r.hp -= BULLET_DAMAGE;
          if (r.hp <= 0) this.breakRock(r);
          else this.events.push({ t: 'hit', x: b.x, y: b.y });
          break;
        }
      }
    }
    this.bullets = this.bullets.filter(b => b.ttl > 0);

    // --- materials: magnet toward nearest ship, collect on contact, drift, ttl ---
    for (const mat of this.mats) {
      mat.ttl -= DT;
      let near = null, best = MAGNET_RADIUS * MAGNET_RADIUS;
      for (const s of this.ships.values()) {
        if (!s.alive) continue;
        const dx = s.x - mat.x, dy = s.y - mat.y, d2 = dx * dx + dy * dy;
        if (d2 < best) { best = d2; near = s; }
      }
      if (near) {
        const dx = near.x - mat.x, dy = near.y - mat.y, d = Math.hypot(dx, dy) || 1;
        if (d < SHIP_RADIUS + COLLECT_RADIUS) {                 // collected!
          near.score += mat.value;
          near.cargo[mat.type] = (near.cargo[mat.type] || 0) + 1;
          this.events.push({ t: 'pickup', x: mat.x, y: mat.y, c: mat.type });
          mat.ttl = 0;
          continue;
        }
        mat.vx += (dx / d) * MAGNET_ACCEL * DT;                 // magnet pull
        mat.vy += (dy / d) * MAGNET_ACCEL * DT;
      }
      mat.vx *= MATERIAL_FRICTION; mat.vy *= MATERIAL_FRICTION;
      mat.x += mat.vx * DT; mat.y += mat.vy * DT;
    }
    this.mats = this.mats.filter(m => m.ttl > 0);

    // --- keep the field stocked ---
    while (this.rocks.size < ASTEROID_COUNT) this.spawnRock();
  }

  breakRock(r) {
    this.rocks.delete(r.id);
    this.events.push({ t: 'boom', x: r.x, y: r.y, c: r.type, s: Math.round(r.radius) });
    // eject materials (more from bigger rocks)
    const n = Math.max(1, Math.round(r.radius / 12));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = MATERIAL_EJECT * (0.4 + Math.random() * 0.8);
      this.mats.push({
        id: nextMatId++, type: r.type, value: TYPES[r.type].value,
        x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, ttl: MATERIAL_TTL,
      });
    }
    // big asteroids split into two smaller ones of the same material
    if (r.radius >= ASTEROID_SPLIT_MIN_R) {
      for (let i = 0; i < 2; i++) {
        const a = Math.random() * Math.PI * 2, off = r.radius * 0.4;
        this.spawnRock({
          type: r.type, radius: r.radius * 0.6,
          x: r.x + Math.cos(a) * off, y: r.y + Math.sin(a) * off,
          vx: Math.cos(a) * 70 + r.vx, vy: Math.sin(a) * 70 + r.vy,
        });
      }
    }
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
