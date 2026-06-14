/* Nova 100 client — rendering, input, prediction, interpolation.
   Physics constants MUST match shared/constants.js for prediction to be smooth. */
'use strict';

const CFG = {
  TICK_RATE: 30, DT: 1 / 30,
  ACCEL: 1000, MAX_SPEED: 560, FRICTION: 0.94,
  SHIP_RADIUS: 16, WORLD: { w: 6000, h: 6000 },
  INPUT_RATE: 30,           // input packets / sec
  INTERP_DELAY: 100,        // ms we render other ships in the past
  ZOOM: 0.72,               // camera zoom-out (<1 shows more of the arena)
  FIRE_COOLDOWN_MS: 1200,   // mirrors server; drives muzzle flash + reload reticle
};

// ---------- canvas ----------
const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
let DPR = Math.min(window.devicePixelRatio || 1, 1.5);   // cap fill-rate on hi-DPI displays
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  cv.width = innerWidth * DPR; cv.height = innerHeight * DPR;
  cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
}
addEventListener('resize', resize); resize();

// Background is solid black with no animation (most performant possible).

// ---------- game state ----------
let ws = null, myId = 0;
let myName = 'Pilot';
const me = { x: CFG.WORLD.w / 2, y: CFG.WORLD.h / 2, vx: 0, vy: 0, hp: 100, alive: true };
let serverMe = null;
let score = 0, kills = 0, deaths = 0, respawnIn = 0, aliveCount = 0, playerCount = 0;

// other ships interpolation buffers: id -> { prev:{t,...}, cur:{t,...} }
const ships = new Map();
let board = [];
let bullets = [];          // current view missiles: [x, y, color, vx, vy]
let bulletsAt = 0;         // performance.now() when `bullets` arrived (for extrapolation)
const fxList = [];         // local particle effects
const rings = [];          // expanding shockwaves: {x,y,color,r0,r1,t,max}
let shake = 0;             // screen-shake magnitude (decays each frame)
let flash = 0;             // brief screen flash on very close kills
let muzzle = 0;            // muzzle-flash decay for own ship
let lastFireT = -1e9;      // client fire cadence (cosmetic; server stays authoritative)
let fps = 60;              // smoothed frames/sec, shown in the HUD

// ---------- input ----------
const keys = {};
let mouse = { x: innerWidth / 2, y: innerHeight / 2, down: false };
const inputHistory = [];   // {seq, mx, my} pending acknowledgement
let inputSeq = 0;

addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
});
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
function aimAngle() {
  // mouse position relative to screen centre → world angle (zoom is uniform, so unchanged)
  return Math.atan2(mouse.y - innerHeight / 2, mouse.x - innerWidth / 2);
}
function shooting() { return mouse.down || keys['Space']; }

// ---------- networking ----------
let myRoom = null, joined = false, roomTries = 0;

async function connect(name) {
  myName = name;
  // ask the matchmaker for a room with a free slot (or a fresh room)
  let room;
  try {
    setStatus('Finding a match…');
    const r = await fetch('/assign');
    room = (await r.json()).room;
  } catch (e) { setStatus('Could not reach matchmaker. Retry.'); return; }
  myRoom = room;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${room}`);
  setStatus('Joining room ' + room + '…');
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name }));
  ws.onmessage = ev => onMessage(JSON.parse(ev.data));
  ws.onclose = () => { if (!joined) setStatus('Disconnected. Refresh to rejoin.'); };
  ws.onerror = () => setStatus('Connection error.');
}

function onMessage(msg) {
  if (msg.t === 'welcome') {
    myId = msg.id;
    myRoom = msg.room;
    joined = true;
    CFG.WORLD = msg.world;
    document.getElementById('start').style.display = 'none';
    cv.style.cursor = 'none';      // we draw our own reticle while playing
    startInputLoop();
  } else if (msg.t === 'full') {
    // room filled between assignment and join — grab another one
    if (roomTries++ < 8) { setStatus('Room full — finding another…'); connect(myName); }
    else setStatus('All rooms full right now. Try again shortly.');
  } else if (msg.t === 'snap') {
    applySnapshot(msg);
  }
}

function applySnapshot(s) {
  aliveCount = s.alive; playerCount = s.players; board = s.board;
  const m = s.me;
  score = m.score; kills = m.kills; deaths = m.deaths;
  respawnIn = m.respawnIn;
  if (m.hp < me.hp - 0.5) shake = Math.min(22, shake + (me.hp - m.hp) * 0.45); // hit feedback
  if (me.alive && !m.alive) shake = 30;                                        // death kick
  me.hp = m.hp; me.alive = m.alive;

  // --- reconcile own ship: snap to server, replay unacked inputs ---
  serverMe = m;
  me.x = m.x; me.y = m.y; me.vx = m.vx; me.vy = m.vy;
  while (inputHistory.length && inputHistory[0].seq <= m.seq) inputHistory.shift();
  for (const cmd of inputHistory) stepLocal(me, cmd.mx, cmd.my);

  // --- other ships into interpolation buffers ---
  const now = performance.now();
  const seen = new Set();
  for (const arr of s.ships) {
    const [id, x, y, angle, alive, hp, bot] = arr;
    seen.add(id);
    if (id === myId) continue;
    let e = ships.get(id);
    const sample = { t: now, x, y, angle, alive, hp, bot };
    if (!e) ships.set(id, { prev: sample, cur: sample });
    else { e.prev = e.cur; e.cur = sample; }
  }
  for (const id of ships.keys()) if (!seen.has(id)) ships.delete(id);

  bullets = s.bullets; bulletsAt = now;
  for (const ev of s.fx) {
    const [x, y, t] = ev;
    spawnFx(x, y, t);
    if (t === 'kill') {
      spawnRing(x, y, '#ffd08a', 10, 150, 0.55);
      spawnRing(x, y, '#ff7b4a', 4, 90, 0.4);
      const d = Math.hypot(x - me.x, y - me.y);
      if (d < 520) flash = Math.min(0.5, flash + (1 - d / 520) * 0.45);
    } else {
      spawnRing(x, y, '#bfe9ff', 2, 26, 0.28);
    }
  }
  for (const k of s.kills) addFeed(k.k, k.v);
}

// local physics step (mirrors server) used for prediction
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

// send inputs at fixed rate + predict locally
function startInputLoop() {
  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const { mx, my } = inputVector();
    const aim = aimAngle();
    const shoot = shooting();
    inputSeq++;
    if (me.alive) {
      stepLocal(me, mx, my);                       // client-side prediction
      inputHistory.push({ seq: inputSeq, mx, my });
      if (inputHistory.length > 120) inputHistory.shift();
      // cosmetic launch feedback when our cooldown is up
      const t = performance.now();
      if (shoot && t - lastFireT >= CFG.FIRE_COOLDOWN_MS) {
        lastFireT = t; muzzle = 1;
        shake = Math.min(20, shake + 5);            // recoil kick
      }
    }
    ws.send(JSON.stringify({ t: 'input', seq: inputSeq, mx, my, aim, shoot }));
  }, 1000 / CFG.INPUT_RATE);
}

// ---------- effects ----------
function spawnFx(x, y, type) {
  const kill = type === 'kill';
  const n = kill ? 30 : 8;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (kill ? 150 : 80) * (0.35 + Math.random());
    fxList.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 1, max: kill ? 0.6 + Math.random() * 0.5 : 0.35,
      color: kill ? (Math.random() < 0.5 ? '#ffd166' : '#ff7b4a') : '#bfe9ff',
      r: kill ? 2 + Math.random() * 2.5 : 1.6,
    });
  }
  if (fxList.length > 500) fxList.splice(0, fxList.length - 500);   // soft cap
}
function spawnRing(x, y, color, r0, r1, max) {
  rings.push({ x, y, color, r0, r1, t: 0, max });
  if (rings.length > 60) rings.shift();
}
function addFeed(k, v) {
  const f = document.getElementById('feed');
  const d = document.createElement('div');
  d.innerHTML = `<span class="k">${esc(k)}</span> ▸ <span class="v">${esc(v)}</span>`;
  f.prepend(d);
  while (f.children.length > 6) f.lastChild.remove();
  setTimeout(() => d.remove(), 5200);
}
function esc(s) { return ('' + s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

// ---------- render ----------
let lastFrame = performance.now();
function render(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  if (dt > 0) fps = fps * 0.92 + (1 / dt) * 0.08;
  const Z = CFG.ZOOM;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#000';                              // solid black, no animation
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  // decay transient feedback
  shake *= 0.86; if (shake < 0.3) shake = 0;
  muzzle *= 0.7; if (muzzle < 0.02) muzzle = 0;
  flash *= 0.88; if (flash < 0.02) flash = 0;
  const shX = (Math.random() - 0.5) * shake, shY = (Math.random() - 0.5) * shake;

  const camX = me.x, camY = me.y;
  const cx = innerWidth / 2 + shX, cy = innerHeight / 2 + shY;
  const w2s = (wx, wy) => [(wx - camX) * Z + cx, (wy - camY) * Z + cy];

  drawBounds(w2s);

  // missiles — extrapolate along velocity between 20 Hz snapshots so fast
  // projectiles glide every frame instead of teleporting once per snapshot.
  const bAge = Math.min(0.2, (now - bulletsAt) / 1000);
  for (const b of bullets) {
    const [bx, by, color, vx, vy] = b;
    const [sx, sy] = w2s(bx + vx * bAge, by + vy * bAge);
    if (sx < -60 || sy < -60 || sx > innerWidth + 60 || sy > innerHeight + 60) continue;
    drawMissile(sx, sy, Math.atan2(vy, vx), color, Z);
  }

  // other ships (interpolated)
  const renderTime = now - CFG.INTERP_DELAY;
  for (const e of ships.values()) {
    const p = interp(e, renderTime);
    if (!p.alive) continue;
    const [sx, sy] = w2s(p.x, p.y);
    if (sx < -50 || sy < -50 || sx > innerWidth + 50 || sy > innerHeight + 50) continue;
    const moving = Math.hypot(e.cur.x - e.prev.x, e.cur.y - e.prev.y) > 1.5;
    drawShip(sx, sy, p.angle, p.bot ? '#9fb3c8' : '#ff6b6b', p.hp, false, moving, Z);
  }

  // self (predicted)
  if (me.alive) {
    const { mx, my } = inputVector();
    drawShip(cx, cy, aimAngle(), '#5ad1ff', me.hp, true, (mx || my) !== 0, Z);
  }

  // particles
  for (let i = fxList.length - 1; i >= 0; i--) {
    const f = fxList[i];
    f.life -= dt / f.max;
    if (f.life <= 0) { fxList.splice(i, 1); continue; }
    f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.96; f.vy *= 0.96;
    const [sx, sy] = w2s(f.x, f.y);
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
    const e = 1 - (1 - r.t) * (1 - r.t);             // ease-out
    const rad = (r.r0 + (r.r1 - r.r0) * e) * Z;
    const [sx, sy] = w2s(r.x, r.y);
    ctx.globalAlpha = (1 - r.t) * 0.8;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = (1 + (1 - r.t) * 2.5) * Z;
    ctx.beginPath(); ctx.arc(sx, sy, rad, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  if (flash > 0) { ctx.fillStyle = `rgba(255,240,210,${flash})`; ctx.fillRect(0, 0, innerWidth, innerHeight); }
  if (joined && me.alive) drawReticle(now);
  drawMinimap();
  drawHUD();
  requestAnimationFrame(render);
}

function interp(e, t) {
  const a = e.prev, b = e.cur;
  if (b.t === a.t) return b;
  let f = (t - a.t) / (b.t - a.t);
  f = Math.max(0, Math.min(1, f));
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    angle: lerpAngle(a.angle, b.angle, f),
    alive: b.alive, hp: b.hp, bot: b.bot,
  };
}
function lerpAngle(a, b, f) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

function drawBounds(w2s) {
  const [x0, y0] = w2s(0, 0);
  const [x1, y1] = w2s(CFG.WORLD.w, CFG.WORLD.h);
  ctx.strokeStyle = 'rgba(90,209,255,.35)'; ctx.lineWidth = 3;
  ctx.shadowColor = '#5ad1ff'; ctx.shadowBlur = 12;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.shadowBlur = 0;
}

// lighten (amt>0 toward white) or darken (amt<0 toward black) a #rrggbb colour
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

function drawShip(sx, sy, angle, color, hp, self, thrust, Z) {
  ctx.save();
  ctx.translate(sx, sy);

  // soft glow under self only — one gradient, cheap, reads clearly in the crowd
  if (self) {
    const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, 34 * Z);
    gr.addColorStop(0, hexA(color, 0.32));
    gr.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.arc(0, 0, 34 * Z, 0, Math.PI * 2); ctx.fill();
  }

  ctx.rotate(angle);
  ctx.scale(Z, Z);

  // engine flame when thrusting
  if (thrust) {
    const len = 12 + Math.random() * 10;
    const g = ctx.createLinearGradient(-6, 0, -6 - len, 0);
    g.addColorStop(0, '#fff'); g.addColorStop(0.4, '#ffd166'); g.addColorStop(1, 'rgba(255,107,43,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-6, 5); ctx.lineTo(-6 - len, 0); ctx.lineTo(-6, -5);
    ctx.closePath(); ctx.fill();
  }

  // hull — gradient only for your own ship; the crowd uses a flat fill (creating
  // a gradient per ship per frame was the real framerate killer at 100 ships).
  if (self) {
    const hg = ctx.createLinearGradient(-12, -11, 16, 11);
    hg.addColorStop(0, shade(color, -0.4));
    hg.addColorStop(0.5, color);
    hg.addColorStop(1, shade(color, 0.55));
    ctx.fillStyle = hg;
  } else {
    ctx.fillStyle = color;
  }
  ctx.beginPath();
  ctx.moveTo(18, 0); ctx.lineTo(-12, 11); ctx.lineTo(-6, 0); ctx.lineTo(-12, -11);
  ctx.closePath(); ctx.fill();
  // bright edge + cockpit
  ctx.strokeStyle = self ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.45)';
  ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = 'rgba(220,245,255,.9)';
  ctx.beginPath(); ctx.arc(3, 0, 2.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // health pip above non-self ships (screen-space, scaled with zoom)
  if (!self && hp < 100) {
    const w = 30 * Z, yo = 24 * Z;
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(sx - w / 2, sy - yo, w, 3.5);
    ctx.fillStyle = hp > 50 ? '#06d6a0' : hp > 25 ? '#ffd166' : '#ff6b6b';
    ctx.fillRect(sx - w / 2, sy - yo, w * hp / 100, 3.5);
  }
}

// a deliberate, glowing missile with fins and an exhaust trail
function drawMissile(sx, sy, angle, color, Z) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(angle);
  ctx.scale(Z, Z);

  // exhaust trail (additive)
  ctx.globalCompositeOperation = 'lighter';
  const tg = ctx.createLinearGradient(-6, 0, -60, 0);
  tg.addColorStop(0, hexA(color, 0.9));
  tg.addColorStop(0.5, hexA(color, 0.25));
  tg.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = tg;
  ctx.beginPath();
  ctx.moveTo(-3, 5.5); ctx.lineTo(-60, 0); ctx.lineTo(-3, -5.5); ctx.closePath(); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // fins
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(-7, 4.5); ctx.lineTo(-13, 9); ctx.lineTo(-4, 4.5); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-7, -4.5); ctx.lineTo(-13, -9); ctx.lineTo(-4, -4.5); ctx.closePath(); ctx.fill();

  // body
  ctx.fillStyle = '#eaf4ff';
  ctx.beginPath();
  ctx.moveTo(16, 0); ctx.lineTo(5, 7); ctx.lineTo(-10, 4.5); ctx.lineTo(-10, -4.5); ctx.lineTo(5, -7);
  ctx.closePath(); ctx.fill();

  // hot warhead tip
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(11, 0, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

// crosshair + missile reload indicator at the mouse
function drawReticle(now) {
  const prog = Math.min(1, (now - lastFireT) / CFG.FIRE_COOLDOWN_MS);
  const x = mouse.x, y = mouse.y, R = 15;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
  if (prog < 1) {
    // reloading: an arc that sweeps to full
    ctx.strokeStyle = 'rgba(255,160,90,.95)';
    ctx.beginPath(); ctx.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + prog * Math.PI * 2); ctx.stroke();
  } else {
    // armed
    ctx.strokeStyle = 'rgba(90,209,255,.95)';
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(90,209,255,.9)';
    ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  // tiny tick marks
  ctx.strokeStyle = 'rgba(255,255,255,.4)';
  for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * (R + 3), y + Math.sin(a) * (R + 3));
    ctx.lineTo(x + Math.cos(a) * (R + 7), y + Math.sin(a) * (R + 7));
    ctx.stroke();
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
  for (const e of ships.values()) {
    const p = e.cur; if (!p.alive) continue;
    ctx.fillStyle = p.bot ? 'rgba(159,179,200,.7)' : '#ff6b6b';
    ctx.fillRect(x0 + p.x * sx - 1, y0 + p.y * sy - 1, 2, 2);
  }
  if (me.alive) {
    ctx.fillStyle = '#5ad1ff';
    ctx.fillRect(x0 + me.x * sx - 2, y0 + me.y * sy - 2, 4, 4);
  }
}

function drawHUD() {
  document.getElementById('stats').innerHTML =
    `<b>${esc(myName)}</b> &nbsp; Score <b>${score}</b><br>` +
    `Kills ${kills} · Deaths ${deaths}<br>` +
    `Room <b>${myRoom ?? '–'}</b> · Alive <b>${aliveCount}</b> / ${playerCount}<br>` +
    `<span style="opacity:.55">${Math.round(fps)} fps</span>`;
  document.getElementById('hpfill').style.width = Math.max(0, me.hp) + '%';

  let rows = '';
  for (const r of board) {
    rows += `<div class="row ${r.name === myName ? 'me' : ''} ${r.bot ? 'bot' : ''}">` +
      `<span>${esc(r.name)}</span><span>${r.score}</span></div>`;
  }
  document.getElementById('boardRows').innerHTML = rows;

  const death = document.getElementById('death');
  if (!me.alive) {
    death.style.display = 'grid';
    document.getElementById('respawnT').textContent = (respawnIn / 1000).toFixed(1);
  } else death.style.display = 'none';
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
    wrap.style.display = 'none';   // e.g. the Node dev server has no /leaderboard
  }
}
loadHallOfFame();
setInterval(() => {
  const s = document.getElementById('start');
  if (s && s.style.display !== 'none') loadHallOfFame();
}, 20000);

requestAnimationFrame(render);
