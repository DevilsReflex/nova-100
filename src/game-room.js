// Durable Object: one live FFA arena. Holds the authoritative Game, runs the
// tick + broadcast loops, and owns every player's WebSocket. Loops start when
// the first client connects and stop when the last one leaves.
import { Game } from '../shared/game.js';
import { thinkBots, botName } from '../shared/bots.js';
import {
  TICK_RATE, SNAPSHOT_RATE, WORLD, MAX_PLAYERS, VIEW_RADIUS,
  BOT_COUNT_TARGET, SHIP_MAX_HP,
} from '../shared/constants.js';

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.game = new Game();
    this.clients = new Map();   // ws -> shipId
    this.humanCount = 0;
    this.roomId = null;         // set from the ?room= param on first connection
    this.tickTimer = null;
    this.snapTimer = null;
    this.beatTimer = null;
    this.botNameIdx = 0;

    // name bots nicely on creation
    const origAdd = this.game.addShip.bind(this.game);
    this.game.addShip = (opts) => {
      if (opts.isBot && !opts.name) opts.name = botName(this.botNameIdx++);
      return origAdd(opts);
    };
  }

  reconcileBots() {
    const desired = Math.max(0, BOT_COUNT_TARGET - this.humanCount);
    const bots = [...this.game.ships.values()].filter(s => s.isBot);
    if (bots.length < desired) {
      for (let i = bots.length; i < desired; i++) this.game.addShip({ isBot: true });
    } else if (bots.length > desired) {
      bots.sort((a, b) => a.score - b.score);
      for (let i = 0; i < bots.length - desired; i++) this.game.removeShip(bots[i].id);
    }
  }

  // tell the Lobby how many humans are really in this room
  reportLobby() {
    if (this.roomId == null || !this.env.LOBBY) return;
    try {
      const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('lobby'));
      lobby.fetch('https://lobby/report', {
        method: 'POST',
        body: JSON.stringify({ room: this.roomId, humans: this.humanCount }),
      });
    } catch { /* lobby unavailable; counts self-heal on next beat */ }
  }

  // Persist a human's finished run to the all-time D1 leaderboard. Fire-and-forget
  // and fully guarded — the live arena must never stall or crash on a DB hiccup.
  recordScore(ship) {
    if (!ship || ship.isBot || !this.env.DB) return;
    const score = Math.max(0, Math.round(ship.score || 0));
    if (score <= 0) return;                  // skip no-score join/leaves
    const name = ('' + (ship.name || 'Pilot')).slice(0, 16);
    const kills = Math.max(0, Math.round(ship.kills || 0));
    this.env.DB.prepare(
      'INSERT INTO scores (name, score, kills, created_at) VALUES (?, ?, ?, ?)'
    ).bind(name, score, kills, Date.now()).run().catch(() => {});
  }

  startLoops() {
    if (this.tickTimer) return;
    this.reconcileBots();
    this.tickTimer = setInterval(() => {
      thinkBots(this.game);
      this.game.step(Date.now());
    }, 1000 / TICK_RATE);
    this.snapTimer = setInterval(() => this.broadcast(), 1000 / SNAPSHOT_RATE);
    this.beatTimer = setInterval(() => this.reportLobby(), 5000);
  }

  stopLoops() {
    clearInterval(this.tickTimer); clearInterval(this.snapTimer); clearInterval(this.beatTimer);
    this.tickTimer = this.snapTimer = this.beatTimer = null;
    this.reportLobby();
    // reset arena so a fresh match starts next time someone joins
    this.game = new Game();
    const origAdd = this.game.addShip.bind(this.game);
    this.botNameIdx = 0;
    this.game.addShip = (opts) => {
      if (opts.isBot && !opts.name) opts.name = botName(this.botNameIdx++);
      return origAdd(opts);
    };
  }

  async fetch(request) {
    const rid = parseInt(new URL(request.url).searchParams.get('room'), 10);
    if (Number.isFinite(rid)) this.roomId = rid;

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();

    server.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.t === 'join') {
        if (this.humanCount >= MAX_PLAYERS) {
          // room filled up since assignment — tell client to grab a new room
          server.send(JSON.stringify({ t: 'full' }));
          return server.close();
        }
        const name = ('' + (msg.name || 'Pilot')).slice(0, 16).replace(/[<>]/g, '');
        const ship = this.game.addShip({ name, isBot: false });
        this.clients.set(server, ship.id);
        this.humanCount++;
        this.startLoops();
        this.reconcileBots();
        this.reportLobby();
        server.send(JSON.stringify({
          t: 'welcome', id: ship.id, world: WORLD, maxHp: SHIP_MAX_HP,
          tickRate: TICK_RATE, room: this.roomId,
        }));
      } else if (msg.t === 'input') {
        const id = this.clients.get(server);
        if (id) this.game.applyInput(id, msg);
      }
    });

    const drop = () => {
      const id = this.clients.get(server);
      if (id != null) {
        this.recordScore(this.game.ships.get(id));   // persist run to D1 (best-effort)
        this.game.removeShip(id);
        this.clients.delete(server);
        this.humanCount = Math.max(0, this.humanCount - 1);
        this.reconcileBots();
        this.reportLobby();
        if (this.humanCount === 0) this.stopLoops();
      }
    };
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  leaderboard() {
    return [...this.game.ships.values()]
      .sort((a, b) => b.score - a.score).slice(0, 10)
      .map(s => ({ name: s.name, score: s.score, kills: s.kills, bot: s.isBot }));
  }

  broadcast() {
    const now = Date.now();
    const board = this.leaderboard();
    const totalAlive = [...this.game.ships.values()].filter(s => s.alive).length;

    const allShips = [];
    for (const s of this.game.ships.values()) {
      allShips.push([s.id, Math.round(s.x), Math.round(s.y), +s.angle.toFixed(2),
        s.alive ? 1 : 0, Math.max(0, Math.round(s.hp)), s.isBot ? 1 : 0]);
    }
    const killFeed = this.game.events.filter(e => e.t === 'kill')
      .map(e => ({ k: e.killer, v: e.victim }));

    for (const [ws, id] of this.clients) {
      const me = this.game.ships.get(id);
      if (!me) continue;
      const bullets = [];
      for (const b of this.game.bullets) {
        if (Math.abs(b.x - me.x) < VIEW_RADIUS && Math.abs(b.y - me.y) < VIEW_RADIUS) {
          bullets.push([Math.round(b.x), Math.round(b.y), b.color, +Math.atan2(b.vy, b.vx).toFixed(2)]);
        }
      }
      const fx = this.game.events.filter(e =>
        e.t !== 'kill' &&
        Math.abs(e.x - me.x) < VIEW_RADIUS && Math.abs(e.y - me.y) < VIEW_RADIUS)
        .map(e => [Math.round(e.x), Math.round(e.y), e.t]);

      try {
        ws.send(JSON.stringify({
          t: 'snap', now,
          me: { x: me.x, y: me.y, vx: me.vx, vy: me.vy, hp: me.hp, seq: me.lastSeq,
            alive: me.alive, score: me.score, kills: me.kills, deaths: me.deaths,
            respawnIn: me.alive ? 0 : Math.max(0, me.respawnAt - now) },
          ships: allShips, bullets, fx, kills: killFeed, board,
          alive: totalAlive, players: this.game.ships.size, room: this.roomId,
        }));
      } catch { /* socket closing */ }
    }
  }
}
