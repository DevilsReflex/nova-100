// Lobby Durable Object: the matchmaker.
// Tracks how many humans are in each room and hands new players the first room
// with a free human slot — opening a brand-new room only when the others are
// full. Rooms heartbeat their real population back here so counts stay accurate.
import { MAX_PLAYERS } from '../shared/constants.js';

const STALE_MS = 20000; // a room that hasn't reported in this long is dropped

export class Lobby {
  constructor(state, env) {
    this.state = state;
    this.rooms = new Map();  // roomId(number) -> { humans, ts }
    this.counter = 0;
  }

  prune(now) {
    for (const [id, r] of this.rooms) {
      if (now - r.ts > STALE_MS || r.humans <= 0) this.rooms.delete(id);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();

    if (url.pathname === '/assign') {
      this.prune(now);
      // first room that still has a free human slot, lowest id first
      let chosen = null;
      for (const [id, r] of [...this.rooms].sort((a, b) => a[0] - b[0])) {
        if (r.humans < MAX_PLAYERS) { chosen = id; break; }
      }
      if (chosen === null) {
        chosen = ++this.counter;
        this.rooms.set(chosen, { humans: 0, ts: now });
      } else {
        this.rooms.get(chosen).ts = now;
      }
      return json({ room: chosen });
    }

    if (url.pathname === '/report') {
      const { room, humans } = await request.json();
      if (typeof room === 'number') {
        if (humans > 0) this.rooms.set(room, { humans, ts: now });
        else this.rooms.delete(room);
        if (room > this.counter) this.counter = room;
      }
      return json({ ok: true });
    }

    if (url.pathname === '/stats') {
      this.prune(now);
      const rooms = [...this.rooms].map(([id, r]) => ({ id, humans: r.humans }));
      const humans = rooms.reduce((a, r) => a + r.humans, 0);
      return json({ rooms, humans, count: rooms.length });
    }

    return new Response('Not found', { status: 404 });
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
}
