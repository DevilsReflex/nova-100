/* Nova 100 client — rendering, input, prediction, interpolation.
   Physics constants MUST match server/constants.js for prediction to be smooth. */
'use strict';

const CFG = {
  TICK_RATE: 30, DT: 1 / 30,
  ACCEL: 900, MAX_SPEED: 520, FRICTION: 0.92,
  SHIP_RADIUS: 16, WORLD: { w: 6000, h: 6000 },
  INPUT_RATE: 30,           // input packets / sec
  INTERP_DELAY: 100,        // ms we render other ships in the past
};

// ---------- canvas ----------
const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
let DPR = Math.min(window.devicePixelRatio || 1, 2);
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = innerWidth * DPR; cv.height = innerHeight * DPR;
  cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
}
addEventListener('resize', resize); resize();

// ---------- starfield (parallax layers, generated once) ----------
const STAR_LAYERS = [
  { n: 220, depth: 0.3, size: 1.0, alpha: 0.5 },
  { n: 160, depth: 0.6, size: 1.6, alpha: 0.7 },
  { n: 90,  depth: 1.0, size: 2.2, alpha: 0.95 },
];
const stars = STAR_LAYERS.map(L => {
  const arr = [];
  for (let i = 0; i < L.n; i++) arr.push({ x: Math.random() * 2400, y: Math.random() * 2400 });
  return { ...L, arr };
});

// ---------- game state ----------
let ws = null, myId = 0;
const me = { x: CFG.WORLD.w / 2, y: CFG.WORLD.h / 2, vx: 0, vy: 0, hp: 100, alive: true };
let serverMe = null;
let score = 0, kills = 0, deaths = 0, respawnIn = 0, aliveCount = 0, playerCount = 0;

// other ships interpolation buffers: id -> { prev:{t,...}, cur:{t,...} }
const ships = new Map();
let board = [];
let bullets = [];          // current view bullets [x,y,color]
const fxList = [];         // local particle effects
let shake = 0;             // screen-shake magnitude (decays each frame)

// ---------- input ----------
const keys = {};
let mouse = { x: innerWidth / 2, y: innerHeight / 2, down: false };
const inputHistory = [];   // {seq, mx, my, dt} pending acknowledgement
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
  // mouse position relative to screen centre → world angle
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
  if (m.hp < me.hp - 0.5) shake = Math.min(18, shake + (me.hp - m.hp) * 0.4); // hit feedback
  if (me.alive && !m.alive) shake = 26;                                       // death kick
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

  bullets = s.bullets;
  for (const [x, y, t] of s.fx) spawnFx(x, y, t);
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
    }
    ws.send(JSON.stringify({ t: 'input', seq: inputSeq, mx, my, aim, shoot }));
  }, 1000 / CFG.INPUT_RATE);
}

// ---------- effects ----------
function spawnFx(x, y, type) {
  const n = type === 'kill' ? 26 : 6;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (type === 'kill' ? 120 : 60) * (0.4 + Math.random());
    fxList.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 1, max: type === 'kill' ? 0.8 : 0.4,
      color: type === 'kill' ? '#ffae3b' : '#9fe8ff', r: type === 'kill' ? 3 : 2 });
  }
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

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);

  // screen shake
  shake *= 0.86; if (shake < 0.3) shake = 0;
  const shX = (Math.random() - 0.5) * shake, shY = (Math.random() - 0.5) * shake;

  const camX = me.x, camY = me.y;
  const cx = innerWidth / 2 + shX, cy = innerHeight / 2 + shY;
  const w2s = (wx, wy) => [wx - camX + cx, wy - camY + cy];

  drawNebula();
  drawStars(camX, camY);
  drawGrid(camX, camY, cx, cy);
  drawBounds(w2s);

  // bullets
  for (const [bx, by, color] of bullets) {
    const [sx, sy] = w2s(bx, by);
    ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.shadowBlur = 0;

  // other ships (interpolated)
  const renderTime = now - CFG.INTERP_DELAY;
  for (const e of ships.values()) {
    const p = interp(e, renderTime);
    if (!p.alive) continue;
    const [sx, sy] = w2s(p.x, p.y);
    if (sx < -40 || sy < -40 || sx > innerWidth + 40 || sy > innerHeight + 40) continue;
    const moving = Math.hypot(e.cur.x - e.prev.x, e.cur.y - e.prev.y) > 1.5;
    drawShip(sx, sy, p.angle, p.bot ? '#9fb3c8' : '#ff6b6b', p.hp, false, moving);
  }

  // self (predicted)
  if (me.alive) {
    const { mx, my } = inputVector();
    drawShip(cx, cy, aimAngle(), '#5ad1ff', me.hp, true, (mx || my) !== 0);
  }

  // effects
  for (let i = fxList.length - 1; i >= 0; i--) {
    const f = fxList[i];
    f.life -= dt / f.max;
    if (f.life <= 0) { fxList.splice(i, 1); continue; }
    f.x += f.vx * dt; f.y += f.vy * dt;
    const [sx, sy] = w2s(f.x, f.y);
    ctx.globalAlpha = Math.max(0, f.life);
    ctx.fillStyle = f.color;
    ctx.beginPath(); ctx.arc(sx, sy, f.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  drawVignette();
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

function drawStars(camX, camY) {
  ctx.fillStyle = '#fff';
  for (const L of stars) {
    const ox = (camX * L.depth) % 2400, oy = (camY * L.depth) % 2400;
    ctx.globalAlpha = L.alpha;
    for (const st of L.arr) {
      let sx = (st.x - ox); let sy = (st.y - oy);
      sx = ((sx % 2400) + 2400) % 2400; sy = ((sy % 2400) + 2400) % 2400;
      // tile across screen
      for (let tx = -2400; tx < innerWidth + 2400; tx += 2400)
        for (let ty = -2400; ty < innerHeight + 2400; ty += 2400) {
          const px = sx + tx, py = sy + ty;
          if (px < 0 || py < 0 || px > innerWidth || py > innerHeight) continue;
          ctx.fillRect(px, py, L.size, L.size);
        }
    }
  }
  ctx.globalAlpha = 1;
}

function drawBounds(w2s) {
  const [x0, y0] = w2s(0, 0);
  const [x1, y1] = w2s(CFG.WORLD.w, CFG.WORLD.h);
  ctx.strokeStyle = 'rgba(90,209,255,.35)'; ctx.lineWidth = 3;
  ctx.shadowColor = '#5ad1ff'; ctx.shadowBlur = 12;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  ctx.shadowBlur = 0;
}

function drawShip(sx, sy, angle, color, hp, self, thrust) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(angle);

  // engine flame (flickers) behind the hull when thrusting
  if (thrust) {
    const len = 12 + Math.random() * 10;
    const g = ctx.createLinearGradient(-6, 0, -6 - len, 0);
    g.addColorStop(0, '#fff'); g.addColorStop(0.4, '#ffd166'); g.addColorStop(1, 'rgba(255,107,43,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-6, 6); ctx.lineTo(-6 - len, 0); ctx.lineTo(-6, -6);
    ctx.closePath(); ctx.fill();
  }

  // hull with glow
  ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = self ? 16 : 9;
  ctx.beginPath();
  ctx.moveTo(18, 0); ctx.lineTo(-12, 11); ctx.lineTo(-6, 0); ctx.lineTo(-12, -11);
  ctx.closePath(); ctx.fill();
  // bright outline + cockpit
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.beginPath(); ctx.arc(4, 0, 3, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // health pip above non-self ships
  if (!self && hp < 100) {
    ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(sx - 16, sy - 26, 32, 4);
    ctx.fillStyle = hp > 50 ? '#06d6a0' : hp > 25 ? '#ffd166' : '#ff6b6b';
    ctx.fillRect(sx - 16, sy - 26, 32 * hp / 100, 4);
  }
}

// soft drifting nebula clouds + base gradient
let nebulaT = 0;
function drawNebula() {
  nebulaT += 0.0016;
  const g = ctx.createRadialGradient(
    innerWidth * 0.5, innerHeight * 0.4, 60,
    innerWidth * 0.5, innerHeight * 0.5, Math.max(innerWidth, innerHeight));
  g.addColorStop(0, '#0a1330'); g.addColorStop(1, '#03040a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, innerWidth, innerHeight);

  const blobs = [['#3a1d6e', 0.18], ['#0d4a6b', 0.16], ['#5a1d4e', 0.14]];
  ctx.globalCompositeOperation = 'lighter';
  blobs.forEach(([c, a], i) => {
    const px = innerWidth * (0.3 + 0.4 * Math.sin(nebulaT + i * 2.1));
    const py = innerHeight * (0.35 + 0.3 * Math.cos(nebulaT * 0.8 + i));
    const r = Math.max(innerWidth, innerHeight) * 0.45;
    const rg = ctx.createRadialGradient(px, py, 0, px, py, r);
    rg.addColorStop(0, hexA(c, a)); rg.addColorStop(1, hexA(c, 0));
    ctx.fillStyle = rg; ctx.fillRect(0, 0, innerWidth, innerHeight);
  });
  ctx.globalCompositeOperation = 'source-over';
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

// faint world-space grid for motion/depth cues
function drawGrid(camX, camY, cx, cy) {
  const step = 200;
  ctx.strokeStyle = 'rgba(90,209,255,.05)'; ctx.lineWidth = 1;
  ctx.beginPath();
  const startX = -((camX - cx) % step);
  for (let x = startX; x < innerWidth; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, innerHeight); }
  const startY = -((camY - cy) % step);
  for (let y = startY; y < innerHeight; y += step) { ctx.moveTo(0, y); ctx.lineTo(innerWidth, y); }
  ctx.stroke();
}

// vignette to focus the eye on the action
function drawVignette() {
  const g = ctx.createRadialGradient(
    innerWidth / 2, innerHeight / 2, innerHeight * 0.45,
    innerWidth / 2, innerHeight / 2, innerHeight * 0.95);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.55)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, innerWidth, innerHeight);
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
    `Room <b>${myRoom ?? '–'}</b> · Alive <b>${aliveCount}</b> / ${playerCount}`;
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
let myName = 'Pilot';
function setStatus(s) { document.getElementById('status').textContent = s; }
function launch() {
  myName = (document.getElementById('name').value || 'Pilot').slice(0, 16);
  connect(myName);
}
document.getElementById('play').addEventListener('click', launch);
document.getElementById('name').addEventListener('keydown', e => { if (e.key === 'Enter') launch(); });
document.getElementById('name').focus();
requestAnimationFrame(render);
