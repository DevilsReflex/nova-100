/* Nova 100 client — asteroid mining. Rendering, input, prediction, interpolation.
   Physics constants MUST match shared/constants.js for prediction to be smooth. */
'use strict';

const CFG = {
  TICK_RATE: 30, DT: 1 / 30,
  ACCEL: 1000, MAX_SPEED: 560, FRICTION: 0.94,
  SHIP_RADIUS: 16, WORLD: { w: 6000, h: 6000 },
  INPUT_RATE: 30,
  INTERP_DELAY: 100,        // ms we render other ships in the past
  ZOOM: 0.72,
  CHARGE_MS: 1000,          // hold-to-fire charge time (drives the reticle)
};

// material/asteroid palette — mirrors shared/constants.js TYPES order
const TYPES = [
  { name: 'Rock',    color: '#9aa6b2' },
  { name: 'Ice',     color: '#9fe8ff' },
  { name: 'Iron',    color: '#c08457' },
  { name: 'Copper',  color: '#e0794a' },
  { name: 'Silver',  color: '#cdd7e2' },
  { name: 'Crystal', color: '#c77dff' },
  { name: 'Gold',    color: '#ffd166' },
  { name: 'Plasma',  color: '#06d6a0' },
];
const SHIP_COLORS = ['#5ad1ff', '#ff6b6b', '#ffd166', '#06d6a0', '#c77dff', '#ff9f1c',
  '#4cc9f0', '#f72585', '#90be6d', '#f8961e', '#577590', '#e0aaff'];
const shipColor = id => SHIP_COLORS[id % SHIP_COLORS.length];
// precompute per-type derived colours (rock shading + glow) so the per-frame
// rock/material draw allocates no strings — matters with many rocks on screen
for (const t of TYPES) {
  t.dark = shade(t.color, -0.35); t.light = shade(t.color, 0.5);
  t.halo = hexA(t.color, 0.18); t.glow = hexA(t.color, 0.5);
}

// ---------- canvas ----------
const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
let DPR = Math.min(window.devicePixelRatio || 1, 1.5);
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  cv.width = innerWidth * DPR; cv.height = innerHeight * DPR;
  cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
}
addEventListener('resize', resize); resize();
// Background is solid black, no animation.

// ---------- game state ----------
let ws = null, myId = 0;
let myName = 'Pilot';
const me = { x: CFG.WORLD.w / 2, y: CFG.WORLD.h / 2, vx: 0, vy: 0 };
let score = 0, prevScore = 0, cargo = {}, playerCount = 0, rockTotal = 0;
let alive = true, respawnIn = 0;

const ships = new Map();   // id -> { buf: [{t,x,y,angle,bot}, …] } interpolation history
let board = [];
let bullets = [], bulletsAt = 0;   // [x,y,color,vx,vy]
let rocks = [], rocksAt = 0;       // [id,x,y,type,radius,hp%,vx,vy]
let mats = [], matsAt = 0;         // [x,y,type,vx,vy]
const fxList = [];                 // particles
const rings = [];                  // shockwaves
const floats = [];                 // floating "+value" texts
let shake = 0, flash = 0, muzzle = 0, chargeStart = 0, fps = 60;

// deterministic irregular polygon + spin per asteroid id
const rockShapes = new Map();
function rockShape(id) {
  let s = rockShapes.get(id);
  if (!s) {
    let seed = (id * 2654435761) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const n = 8 + (id % 4);
    const verts = [];
    for (let i = 0; i < n; i++) verts.push(0.74 + rnd() * 0.34);
    s = { verts, spin: rnd() * Math.PI * 2, rate: (rnd() - 0.5) * 0.5 };
    if (rockShapes.size > 1500) rockShapes.delete(rockShapes.keys().next().value);  // evict oldest, never clear()
    rockShapes.set(id, s);
  }
  return s;
}

// ---------- input ----------
const keys = {};
let mouse = { x: innerWidth / 2, y: innerHeight / 2, down: false };
const inputHistory = [];
let inputSeq = 0;
addEventListener('keydown', e => { keys[e.code] = true; if (e.code === 'Space') e.preventDefault(); });
addEventListener('keyup', e => { keys[e.code] = false; });
cv.addEventListener('mousemove', e => { mouse.x = e.clientX; mouse.y = e.clientY; });
cv.addEventListener('mousedown', () => { mouse.down = true; });
addEventListener('mouseup', () => { mouse.down = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.down = false; });

function inputVector() {
  let mx = 0, my = 0;
  if (keys['KeyW'] || keys['ArrowUp']) my -= 1;
  if (keys['KeyS'] || keys['ArrowDown']) my += 1;
  if (keys['KeyA'] || keys['ArrowLeft']) mx -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) mx += 1;
  const m = Math.hypot(mx, my);
  if (m > 0) { mx /= m; my /= m; }
  return { mx, my };
}
const aimAngle = () => Math.atan2(mouse.y - innerHeight / 2, mouse.x - innerWidth / 2);
const shooting = () => mouse.down || keys['Space'];

// ---------- networking ----------
let myRoom = null, joined = false, roomTries = 0;
async function connect(name) {
  myName = name;
  let room;
  try {
    setStatus('Finding a field…');
    const r = await fetch('/assign');
    room = (await r.json()).room;
  } catch (e) { setStatus('Could not reach matchmaker. Retry.'); return; }
  myRoom = room;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${room}`);
  setStatus('Joining sector ' + room + '…');
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name }));
  ws.onmessage = ev => onMessage(JSON.parse(ev.data));
  ws.onclose = () => { if (!joined) setStatus('Disconnected. Refresh to rejoin.'); };
  ws.onerror = () => setStatus('Connection error.');
}
function onMessage(msg) {
  if (msg.t === 'welcome') {
    myId = msg.id; myRoom = msg.room; joined = true;
    CFG.WORLD = msg.world;
    document.getElementById('start').style.display = 'none';
    cv.style.cursor = 'none';
    startInputLoop();
  } else if (msg.t === 'full') {
    if (roomTries++ < 8) { setStatus('Sector full — finding another…'); connect(myName); }
    else setStatus('All sectors full right now. Try again shortly.');
  } else if (msg.t === 'snap') {
    applySnapshot(msg);
  }
}

function applySnapshot(s) {
  playerCount = s.players; rockTotal = s.rockTotal; board = s.board;
  const m = s.me;
  prevScore = score; score = m.score; cargo = m.cargo || {};
  alive = m.alive !== false; respawnIn = m.respawnIn || 0;
  if (score > prevScore && joined) {
    floats.push({ x: me.x, y: me.y - 26, life: 1, text: '+' + (score - prevScore), color: '#ffe08a' });
    if (floats.length > 24) floats.shift();
  }

  // reconcile own ship: snap to server, replay unacked inputs (only while alive)
  me.x = m.x; me.y = m.y; me.vx = m.vx; me.vy = m.vy;
  while (inputHistory.length && inputHistory[0].seq <= m.seq) inputHistory.shift();
  if (alive) for (const cmd of inputHistory) stepLocal(me, cmd.mx, cmd.my);

  const now = performance.now();
  // other ships → interpolation history buffer
  const seen = new Set();
  for (const arr of s.ships) {
    const [id, x, y, angle, bot, alv] = arr;
    seen.add(id);
    if (id === myId) continue;
    const sample = { t: now, x, y, angle, bot, alive: alv };
    const e = ships.get(id);
    if (!e) ships.set(id, { buf: [sample] });
    else {
      e.buf.push(sample);
      const cutoff = now - 400;
      while (e.buf.length > 2 && e.buf[0].t < cutoff) e.buf.shift();
    }
  }
  for (const id of ships.keys()) if (!seen.has(id)) ships.delete(id);

  bullets = s.bullets; bulletsAt = now;
  rocks = s.rocks; rocksAt = now;
  mats = s.mats; matsAt = now;

  for (const ev of s.fx) {
    const [x, y, t, c, sz] = ev;
    if (t === 'boom') {
      const col = (TYPES[c] || TYPES[0]).color;
      pushParticles(x, y, Math.min(28, Math.max(8, Math.round((sz || 20) / 5))),
        (sz || 20) * 4, 0.85, [col, '#ffffff', '#ffd9a0'], 2.6);
      spawnRing(x, y, col, (sz || 20) * 0.5, (sz || 20) * 4, 0.5);
      const d = Math.hypot(x - me.x, y - me.y);
      if (d < 520) flash = Math.min(0.4, flash + (1 - d / 520) * 0.35);
    } else if (t === 'pickup') {
      const col = (TYPES[c] || TYPES[0]).color;
      pushParticles(x, y, 8, 90, 0.4, [col, '#ffffff'], 1.6);
      spawnRing(x, y, col, 3, 30, 0.3);
    } else if (t === 'ship') {
      pushParticles(x, y, 30, 260, 1.0, ['#ff6b6b', '#ffd166', '#ffffff'], 3);
      spawnRing(x, y, '#ff8a5a', 6, 130, 0.6);
      const d = Math.hypot(x - me.x, y - me.y);
      if (d < 600) { shake = Math.min(30, shake + (1 - d / 600) * 22); flash = Math.min(0.5, flash + (1 - d / 600) * 0.4); }
    } else {
      pushParticles(x, y, 6, 90, 0.3, ['#bfe9ff', '#ffffff'], 1.5);  // hit
    }
  }
}

function stepLocal(o, mx, my) {
  o.vx += mx * CFG.ACCEL * CFG.DT;
  o.vy += my * CFG.ACCEL * CFG.DT;
  const sp = Math.hypot(o.vx, o.vy);
  if (sp > CFG.MAX_SPEED) { o.vx = o.vx / sp * CFG.MAX_SPEED; o.vy = o.vy / sp * CFG.MAX_SPEED; }
  o.vx *= CFG.FRICTION; o.vy *= CFG.FRICTION;
  o.x += o.vx * CFG.DT; o.y += o.vy * CFG.DT;
  const r = CFG.SHIP_RADIUS;
  o.x = Math.max(r, Math.min(CFG.WORLD.w - r, o.x));
  o.y = Math.max(r, Math.min(CFG.WORLD.h - r, o.y));
}

function startInputLoop() {
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const { mx, my } = inputVector();
    const aim = aimAngle();
    const shoot = shooting();
    inputSeq++;
    if (alive) {
      stepLocal(me, mx, my);                       // predict only while alive
      inputHistory.push({ seq: inputSeq, mx, my });
      if (inputHistory.length > 120) inputHistory.shift();
      const t = performance.now();
      if (shoot) {
        if (!chargeStart) chargeStart = t;
        if (t - chargeStart >= CFG.CHARGE_MS) { chargeStart = t; muzzle = 1; shake = Math.min(22, shake + 7); }
      } else chargeStart = 0;
    } else chargeStart = 0;
    ws.send(JSON.stringify({ t: 'input', seq: inputSeq, mx, my, aim, shoot: alive && shoot }));
  }, 1000 / CFG.INPUT_RATE);
}

// ---------- effects ----------
function pushParticles(x, y, n, spd, life, colors, rad) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = spd * (0.35 + Math.random() * 0.8);
    fxList.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: 1, max: life * (0.6 + Math.random() * 0.6),
      color: colors[(Math.random() * colors.length) | 0], r: rad * (0.6 + Math.random() * 0.8),
    });
  }
  if (fxList.length > 400) fxList.splice(0, fxList.length - 400);
}
function spawnRing(x, y, color, r0, r1, max) {
  rings.push({ x, y, color, r0, r1, t: 0, max });
  if (rings.length > 60) rings.shift();
}
function esc(s) { return ('' + s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

// ---------- render ----------
let lastFrame = performance.now(), lastHud = 0;
function render(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (dt > 0) fps = fps * 0.92 + (1 / dt) * 0.08;
  const Z = CFG.ZOOM;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  shake *= 0.86; if (shake < 0.3) shake = 0;
  muzzle *= 0.7; if (muzzle < 0.02) muzzle = 0;
  flash *= 0.88; if (flash < 0.02) flash = 0;
  const shX = (Math.random() - 0.5) * shake, shY = (Math.random() - 0.5) * shake;
  const camX = me.x, camY = me.y;
  const cx = innerWidth / 2 + shX, cy = innerHeight / 2 + shY;
  // world→screen is inlined at every call site (sx=(wx-camX)*Z+cx) to avoid
  // allocating a throwaway array per entity per frame — that GC churn was the
  // source of the micro-freezes when lots of entities stream into view.

  drawBounds(camX, camY, cx, cy, Z);

  // asteroids (extrapolated along drift)
  const rAge = Math.min(0.2, (now - rocksAt) / 1000);
  for (const r of rocks) {
    const [id, rx, ry, type, radius, hpPct, vx, vy] = r;
    const sx = (rx + vx * rAge - camX) * Z + cx, sy = (ry + vy * rAge - camY) * Z + cy;
    const screenR = radius * Z;
    if (sx < -screenR - 30 || sy < -screenR - 30 || sx > innerWidth + screenR + 30 || sy > innerHeight + screenR + 30) continue;
    drawRock(sx, sy, type, radius, hpPct, id, now, Z);
  }

  // material drops (extrapolated)
  const mAge = Math.min(0.2, (now - matsAt) / 1000);
  for (const m of mats) {
    const [mx, my, type, vx, vy] = m;
    const sx = (mx + vx * mAge - camX) * Z + cx, sy = (my + vy * mAge - camY) * Z + cy;
    if (sx < -30 || sy < -30 || sx > innerWidth + 30 || sy > innerHeight + 30) continue;
    drawMat(sx, sy, type, Z, now + sx);
  }

  // bullets (extrapolated)
  const bAge = Math.min(0.2, (now - bulletsAt) / 1000);
  for (const b of bullets) {
    const [bx, by, color, vx, vy] = b;
    const sx = (bx + vx * bAge - camX) * Z + cx, sy = (by + vy * bAge - camY) * Z + cy;
    if (sx < -60 || sy < -60 || sx > innerWidth + 60 || sy > innerHeight + 60) continue;
    drawMissile(sx, sy, Math.atan2(vy, vx), color, Z);
  }

  // other ships (interpolated)
  const renderTime = now - CFG.INTERP_DELAY;
  for (const [id, e] of ships) {
    const p = sampleAt(e, renderTime);
    if (p.alive === 0) continue;                 // destroyed ship — gone (explosion via fx)
    const sx = (p.x - camX) * Z + cx, sy = (p.y - camY) * Z + cy;
    if (sx < -50 || sy < -50 || sx > innerWidth + 50 || sy > innerHeight + 50) continue;
    drawShip(sx, sy, p.angle, shipColor(id), false, p.moving, Z);
  }

  // self (predicted) — hidden while waiting to respawn
  if (alive) {
    const { mx, my } = inputVector();
    drawShip(cx, cy, aimAngle(), '#5ad1ff', true, (mx || my) !== 0, Z);
  }

  // particles
  for (let i = fxList.length - 1; i >= 0; i--) {
    const f = fxList[i];
    f.life -= dt / f.max;
    if (f.life <= 0) { fxList.splice(i, 1); continue; }
    f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.96; f.vy *= 0.96;
    const sx = (f.x - camX) * Z + cx, sy = (f.y - camY) * Z + cy;
    ctx.globalAlpha = Math.max(0, f.life);
    ctx.fillStyle = f.color;
    ctx.beginPath(); ctx.arc(sx, sy, f.r * Z, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // shockwave rings (additive)
  ctx.globalCompositeOperation = 'lighter';
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.t += dt / r.max;
    if (r.t >= 1) { rings.splice(i, 1); continue; }
    const e = 1 - (1 - r.t) * (1 - r.t);
    const sx = (r.x - camX) * Z + cx, sy = (r.y - camY) * Z + cy;
    ctx.globalAlpha = (1 - r.t) * 0.8;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = (1 + (1 - r.t) * 2.5) * Z;
    ctx.beginPath(); ctx.arc(sx, sy, (r.r0 + (r.r1 - r.r0) * e) * Z, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // floating "+value" texts
  ctx.textAlign = 'center'; ctx.font = '700 14px system-ui, sans-serif';
  for (let i = floats.length - 1; i >= 0; i--) {
    const f = floats[i];
    f.life -= dt / 1.1; f.y -= 34 * dt;
    if (f.life <= 0) { floats.splice(i, 1); continue; }
    const sx = (f.x - camX) * Z + cx, sy = (f.y - camY) * Z + cy;
    ctx.globalAlpha = Math.max(0, Math.min(1, f.life * 1.4));
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, sx, sy);
  }
  ctx.globalAlpha = 1; ctx.textAlign = 'left';

  if (flash > 0) { ctx.fillStyle = `rgba(255,240,210,${flash})`; ctx.fillRect(0, 0, innerWidth, innerHeight); }
  if (joined && alive) drawReticle(now);
  if (joined && !alive) {
    ctx.fillStyle = 'rgba(120,20,30,0.28)'; ctx.fillRect(0, 0, innerWidth, innerHeight);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff7a7a'; ctx.font = '800 34px system-ui, sans-serif';
    ctx.fillText('SHIP DESTROYED', innerWidth / 2, innerHeight / 2 - 8);
    ctx.fillStyle = '#e8f0ff'; ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillText('Respawning in ' + Math.ceil(respawnIn / 1000) + 's…', innerWidth / 2, innerHeight / 2 + 24);
    ctx.textAlign = 'left';
  }
  drawMinimap();
  if (now - lastHud > 100) { drawHUD(); lastHud = now; }   // HUD at ~10Hz — innerHTML/reflow every frame was costly
  requestAnimationFrame(render);
}

function sampleAt(e, t) {
  const buf = e.buf, n = buf.length;
  if (n === 1) return { ...buf[0], moving: false };
  let i = n - 1;
  while (i > 0 && buf[i].t > t) i--;
  const a = buf[i], b = buf[i + 1] || a;
  const span = b.t - a.t;
  let f = span > 0 ? (t - a.t) / span : 0;
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    angle: lerpAngle(a.angle, b.angle, f),
    bot: b.bot, alive: b.alive,
    moving: Math.hypot(b.x - a.x, b.y - a.y) > 1.5,
  };
}
function lerpAngle(a, b, f) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

function drawBounds(camX, camY, cx, cy, Z) {
  const x0 = (0 - camX) * Z + cx, y0 = (0 - camY) * Z + cy;
  const x1 = (CFG.WORLD.w - camX) * Z + cx, y1 = (CFG.WORLD.h - camY) * Z + cy;
  ctx.strokeStyle = 'rgba(90,209,255,.28)'; ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function drawRock(sx, sy, type, radius, hpPct, id, now, Z) {
  const t = TYPES[type] || TYPES[0];
  const shp = rockShape(id);
  const ang = shp.spin + now * 0.001 * shp.rate;
  const verts = shp.verts, n = verts.length;
  ctx.save();
  ctx.translate(sx, sy);
  // rare materials get a soft halo so they stand out
  if (type >= 5) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = t.halo;
    ctx.beginPath(); ctx.arc(0, 0, radius * Z * 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.rotate(ang);
  ctx.scale(Z, Z);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, rr = radius * verts[i];
    const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = t.color; ctx.fill();
  // darker offset inner blob for a touch of depth
  ctx.fillStyle = t.dark;
  ctx.beginPath(); ctx.arc(-radius * 0.18, radius * 0.16, radius * 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = t.light; ctx.lineWidth = 1.4; ctx.stroke();
  // damage darkening as it gets mined down
  if (hpPct < 100) {
    ctx.globalAlpha = (100 - hpPct) / 100 * 0.5;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, rr = radius * verts[i];
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawMat(sx, sy, type, Z, phase) {
  const mt = TYPES[type] || TYPES[0], col = mt.color;
  const r = 7 * Z * (0.85 + 0.15 * Math.sin(phase * 0.012));
  ctx.save();
  ctx.translate(sx, sy);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = mt.glow;
  ctx.beginPath(); ctx.arc(0, 0, r * 1.7, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.rotate(phase * 0.004);
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.72, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.72, 0); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
}

function drawShip(sx, sy, angle, color, self, thrust, Z) {
  ctx.save();
  ctx.translate(sx, sy);
  if (self) {
    const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, 34 * Z);
    gr.addColorStop(0, hexA(color, 0.32)); gr.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(0, 0, 34 * Z, 0, Math.PI * 2); ctx.fill();
  }
  ctx.rotate(angle);
  ctx.scale(Z, Z);
  if (thrust) {
    const len = 12 + Math.random() * 10;
    const g = ctx.createLinearGradient(-6, 0, -6 - len, 0);
    g.addColorStop(0, '#fff'); g.addColorStop(0.4, '#ffd166'); g.addColorStop(1, 'rgba(255,107,43,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(-6, 5); ctx.lineTo(-6 - len, 0); ctx.lineTo(-6, -5); ctx.closePath(); ctx.fill();
  }
  if (self) {
    const hg = ctx.createLinearGradient(-12, -11, 16, 11);
    hg.addColorStop(0, shade(color, -0.4)); hg.addColorStop(0.5, color); hg.addColorStop(1, shade(color, 0.55));
    ctx.fillStyle = hg;
  } else ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(18, 0); ctx.lineTo(-12, 11); ctx.lineTo(-6, 0); ctx.lineTo(-12, -11);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = self ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.45)';
  ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = 'rgba(220,245,255,.9)';
  ctx.beginPath(); ctx.arc(3, 0, 2.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawMissile(sx, sy, angle, color, Z) {
  ctx.save();
  ctx.translate(sx, sy); ctx.rotate(angle); ctx.scale(Z, Z);
  ctx.globalCompositeOperation = 'lighter';
  const tg = ctx.createLinearGradient(-6, 0, -60, 0);
  tg.addColorStop(0, hexA(color, 0.9)); tg.addColorStop(0.5, hexA(color, 0.25)); tg.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = tg;
  ctx.beginPath(); ctx.moveTo(-3, 5.5); ctx.lineTo(-60, 0); ctx.lineTo(-3, -5.5); ctx.closePath(); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(-7, 4.5); ctx.lineTo(-13, 9); ctx.lineTo(-4, 4.5); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-7, -4.5); ctx.lineTo(-13, -9); ctx.lineTo(-4, -4.5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#eaf4ff';
  ctx.beginPath();
  ctx.moveTo(16, 0); ctx.lineTo(5, 7); ctx.lineTo(-10, 4.5); ctx.lineTo(-10, -4.5); ctx.lineTo(5, -7);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(11, 0, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawReticle(now) {
  const prog = chargeStart ? Math.min(1, (now - chargeStart) / CFG.CHARGE_MS) : 0;
  const x = mouse.x, y = mouse.y, R = 15;
  ctx.save(); ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
  if (prog < 1) {
    ctx.strokeStyle = 'rgba(255,160,90,.95)';
    ctx.beginPath(); ctx.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); ctx.stroke();
  } else {
    ctx.strokeStyle = 'rgba(90,209,255,.95)';
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(90,209,255,.9)';
    ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawMinimap() {
  const S = 150, pad = 16;
  const x0 = innerWidth - S - pad, y0 = innerHeight - S - pad - 70;
  ctx.fillStyle = 'rgba(6,12,24,.6)';
  ctx.strokeStyle = 'rgba(90,209,255,.3)'; ctx.lineWidth = 1;
  ctx.fillRect(x0, y0, S, S); ctx.strokeRect(x0, y0, S, S);
  const sx = S / CFG.WORLD.w, sy = S / CFG.WORLD.h;
  ctx.fillStyle = 'rgba(150,160,175,.5)';
  for (const r of rocks) ctx.fillRect(x0 + r[1] * sx - 1, y0 + r[2] * sy - 1, 1.5, 1.5);
  for (const [id, e] of ships) {
    const p = e.buf[e.buf.length - 1];
    if (p.alive === 0) continue;
    ctx.fillStyle = p.bot ? 'rgba(159,179,200,.7)' : '#ffd166';
    ctx.fillRect(x0 + p.x * sx - 1, y0 + p.y * sy - 1, 2, 2);
  }
  ctx.fillStyle = '#5ad1ff';
  ctx.fillRect(x0 + me.x * sx - 2, y0 + me.y * sy - 2, 4, 4);
}

function drawHUD() {
  document.getElementById('stats').innerHTML =
    `<b>${esc(myName)}</b> &nbsp; Score <b>${score.toLocaleString()}</b><br>` +
    `Sector <b>${myRoom ?? '–'}</b> · Miners <b>${playerCount}</b> · Rocks ${rockTotal}<br>` +
    `<span style="opacity:.55">${Math.round(fps)} fps</span>`;

  // cargo hold (per-type counts)
  let cg = '';
  for (let i = 0; i < TYPES.length; i++) {
    const c = cargo[i] | 0;
    if (!c) continue;
    cg += `<span class="ci"><i style="background:${TYPES[i].color}"></i>${TYPES[i].name} <b>${c}</b></span>`;
  }
  const cargoEl = document.getElementById('cargo');
  if (cargoEl) cargoEl.innerHTML = cg || '<span class="empty">cargo empty — go mine!</span>';

  let rows = '';
  for (const r of board) {
    rows += `<div class="row ${r.name === myName ? 'me' : ''} ${r.bot ? 'bot' : ''}">` +
      `<span>${esc(r.name)}</span><span>${(r.score | 0).toLocaleString()}</span></div>`;
  }
  document.getElementById('boardRows').innerHTML = rows;
}

// ---------- boot ----------
function setStatus(s) { document.getElementById('status').textContent = s; }
function launch() {
  myName = (document.getElementById('name').value || 'Pilot').slice(0, 16);
  connect(myName);
}
document.getElementById('play').addEventListener('click', launch);
document.getElementById('name').addEventListener('keydown', e => { if (e.key === 'Enter') launch(); });
document.getElementById('name').focus();

// ---------- all-time leaderboard (Cloudflare D1) ----------
async function loadHallOfFame() {
  const wrap = document.getElementById('halloffame');
  const rows = document.getElementById('hofRows');
  if (!wrap || !rows) return;
  try {
    const r = await fetch('/leaderboard', { cache: 'no-store' });
    if (!r.ok) throw new Error('no leaderboard endpoint');
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      rows.innerHTML = '<li class="muted">Be the first to make the board</li>';
      return;
    }
    rows.innerHTML = data.map((d, i) =>
      `<li class="${i === 0 ? 'top1' : ''}">` +
        `<span class="rank">${i + 1}</span>` +
        `<span class="nm">${esc(d.name)}</span>` +
        `<span class="sc">${(d.score | 0).toLocaleString()}</span>` +
      `</li>`).join('');
  } catch {
    wrap.style.display = 'none';
  }
}
loadHallOfFame();
setInterval(() => {
  const s = document.getElementById('start');
  if (s && s.style.display !== 'none') loadHallOfFame();
}, 20000);

requestAnimationFrame(render);
