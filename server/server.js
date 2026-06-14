// Nova 100 — Node dev server (mirrors the Cloudflare deployment).
// Serves the client, matchmakes players into rooms, opens a new room when one
// fills with 100 humans, and pads each room with bots so it always feels full.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Game } from '../shared/game.js';
import { thinkBots, botName } from '../shared/bots.js';
import {
  TICK_RATE, SNAPSHOT_RATE, WORLD, MAX_PLAYERS, VIEW_RADIUS,
  BOT_COUNT_TARGET, SHIP_MAX_HP,
} from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

// ---------- rooms / matchmaking ----------
const rooms = new Map();   // id -> room
let roomCounter = 0;

function makeRoom() {
  const id = ++roomCounter;
  const game = new Game();
  const room = { id, game, humanCount: 0, botNameIdx: 0 };
  const origAdd = game.addShip.bind(game);
  game.addShip = (opts) => {
    if (opts.isBot && !opts.name) opts.name = botName(room.botNameIdx++);
    return origAdd(opts);
  };
  rooms.set(id, room);
  reconcileBots(room);
  return room;
}

function reconcileBots(room) {
  const desired = Math.max(0, BOT_COUNT_TARGET - room.humanCount);
  const bots = [...room.game.ships.values()].filter(s => s.isBot);
  if (bots.length < desired) {
    for (let i = bots.length; i < desired; i++) room.game.addShip({ isBot: true });
  } else if (bots.length > desired) {
    bots.sort((a, b) => a.score - b.score);
    for (let i = 0; i < bots.length - desired; i++) room.game.removeShip(bots[i].id);
  }
}

// first room with a free human slot (lowest id), else a brand-new room
function assignRoom() {
  for (const room of [...rooms.values()].sort((a, b) => a.id - b.id)) {
    if (room.humanCount < MAX_PLAYERS) return room;
  }
  return makeRoom();
}

// ---------- static file server + matchmaking endpoints ----------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/assign') {
    const room = assignRoom();
    return sendJSON(res, { room: room.id });
  }
  if (url.pathname === '/stats') {
    const list = [...rooms.values()].map(r => ({ id: r.id, humans: r.humanCount }));
    return sendJSON(res, { rooms: list, humans: list.reduce((a, r) => a + r.humans, 0), count: list.length });
  }

  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});
function sendJSON(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server });
const clients = new Map(); // ws -> { roomId, shipId }

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const url = new URL(req.url, 'http://localhost');
  const wantRoom = parseInt(url.searchParams.get('room'), 10);

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join') {
      let room = rooms.get(wantRoom) || assignRoom();
      if (room.humanCount >= MAX_PLAYERS) {       // filled since assignment
        ws.send(JSON.stringify({ t: 'full' }));
        return ws.close();
      }
      const name = ('' + (msg.name || 'Pilot')).slice(0, 16).replace(/[<>]/g, '');
      const ship = room.game.addShip({ name, isBot: false });
      clients.set(ws, { roomId: room.id, shipId: ship.id });
      room.humanCount++;
      reconcileBots(room);
      ws.send(JSON.stringify({
        t: 'welcome', id: ship.id, world: WORLD, maxHp: SHIP_MAX_HP,
        tickRate: TICK_RATE, room: room.id,
      }));
    } else if (msg.t === 'input') {
      const c = clients.get(ws);
      if (c) { const room = rooms.get(c.roomId); if (room) room.game.applyInput(c.shipId, msg); }
    }
  });

  const drop = () => {
    const c = clients.get(ws);
    if (!c) return;
    const room = rooms.get(c.roomId);
    if (room) {
      room.game.removeShip(c.shipId);
      room.humanCount = Math.max(0, room.humanCount - 1);
      reconcileBots(room);
      // retire empty extra rooms (always keep room #1 warm)
      if (room.humanCount === 0 && room.id !== 1) rooms.delete(room.id);
    }
    clients.delete(ws);
  };
  ws.on('close', drop);
  ws.on('error', drop);
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 15000);

// ---------- simulation loop (all rooms) ----------
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) { thinkBots(room.game); room.game.step(now); }
}, 1000 / TICK_RATE);

// ---------- broadcast loop (per room, interest-managed) ----------
function leaderboard(game) {
  return [...game.ships.values()].sort((a, b) => b.score - a.score).slice(0, 10)
    .map(s => ({ name: s.name, score: s.score, kills: s.kills, bot: s.isBot }));
}

setInterval(() => {
  const now = Date.now();
  const byRoom = new Map();  // roomId -> [ws,...]
  for (const [ws, c] of clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!byRoom.has(c.roomId)) byRoom.set(c.roomId, []);
    byRoom.get(c.roomId).push(ws);
  }

  for (const [roomId, sockets] of byRoom) {
    const room = rooms.get(roomId); if (!room) continue;
    const game = room.game;
    const board = leaderboard(game);
    let totalAlive = 0;
    const allShips = [];
    for (const s of game.ships.values()) {
      if (s.alive) totalAlive++;
      allShips.push([s.id, Math.round(s.x), Math.round(s.y), +s.angle.toFixed(2),
        s.alive ? 1 : 0, Math.max(0, Math.round(s.hp)), s.isBot ? 1 : 0]);
    }
    const killFeed = game.events.filter(e => e.t === 'kill').map(e => ({ k: e.killer, v: e.victim }));

    // serialize the shared roster/board/killfeed once, not once per client
    const shipsJson = JSON.stringify(allShips);
    const boardJson = JSON.stringify(board);
    const killsJson = JSON.stringify(killFeed);
    const players = game.ships.size;

    for (const ws of sockets) {
      const c = clients.get(ws);
      const me = game.ships.get(c.shipId);
      if (!me) continue;
      const mx = me.x, my = me.y;
      const bullets = [];
      for (const b of game.bullets) {
        if (Math.abs(b.x - mx) < VIEW_RADIUS && Math.abs(b.y - my) < VIEW_RADIUS)
          bullets.push([Math.round(b.x), Math.round(b.y), b.color, Math.round(b.vx), Math.round(b.vy)]);
      }
      const fx = [];
      for (const e of game.events) {
        if (e.t !== 'kill' && Math.abs(e.x - mx) < VIEW_RADIUS && Math.abs(e.y - my) < VIEW_RADIUS)
          fx.push([Math.round(e.x), Math.round(e.y), e.t]);
      }
      const meJson = JSON.stringify({
        x: me.x, y: me.y, vx: me.vx, vy: me.vy, hp: me.hp, seq: me.lastSeq,
        alive: me.alive, score: me.score, kills: me.kills, deaths: me.deaths,
        respawnIn: me.alive ? 0 : Math.max(0, me.respawnAt - now),
      });
      ws.send('{"t":"snap","now":' + now + ',"me":' + meJson +
        ',"ships":' + shipsJson + ',"bullets":' + JSON.stringify(bullets) +
        ',"fx":' + JSON.stringify(fx) + ',"kills":' + killsJson +
        ',"board":' + boardJson + ',"alive":' + totalAlive +
        ',"players":' + players + ',"room":' + roomId + '}');
    }
  }
}, 1000 / SNAPSHOT_RATE);

makeRoom(); // keep room #1 warm

server.listen(PORT, () => {
  console.log(`\n  Nova 100 running → http://localhost:${PORT}`);
  console.log(`  Arena ${WORLD.w}×${WORLD.h} · ${MAX_PLAYERS} humans/room · new room on overflow · ${TICK_RATE} ticks/s\n`);
});
