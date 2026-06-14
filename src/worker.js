// Cloudflare Worker entry for Nova 100.
// Static assets (the public/ folder) are served by the [assets] binding.
// Matchmaking:
//   GET /assign        → Lobby DO picks a room with a free slot (or a new one)
//   WS  /ws?room=<id>  → routes to that room's GameRoom Durable Object
//   GET /stats         → live room/player counts (for the landing page)
export { GameRoom } from './game-room.js';
export { Lobby } from './lobby.js';

function lobby(env) { return env.LOBBY.get(env.LOBBY.idFromName('lobby')); }

// All-time Top 100 from D1. Best-effort: a DB hiccup returns an empty board so
// the landing page still loads.
async function leaderboard(env) {
  try {
    const { results } = await env.DB.prepare(
      'SELECT name, score, kills, created_at FROM scores ORDER BY score DESC, created_at ASC LIMIT 100'
    ).all();
    return Response.json(results ?? [], { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json([], { headers: { 'Cache-Control': 'no-store' } });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/assign') {
      return lobby(env).fetch('https://lobby/assign');
    }

    if (url.pathname === '/stats') {
      return lobby(env).fetch('https://lobby/stats');
    }

    if (url.pathname === '/leaderboard') {
      return leaderboard(env);
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      // resolve room: explicit ?room=, else ask the lobby
      let room = parseInt(url.searchParams.get('room'), 10);
      if (!Number.isFinite(room)) {
        const r = await lobby(env).fetch('https://lobby/assign');
        room = (await r.json()).room;
      }
      const id = env.GAME_ROOM.idFromName('room-' + room);
      return env.GAME_ROOM.get(id).fetch(request);
    }

    // everything else → static client
    return env.ASSETS.fetch(request);
  },
};
