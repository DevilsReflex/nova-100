# Nova 100 — 100-Player Multiplayer Space Shooter

A real-time, authoritative-server free-for-all space shooter. Up to **100 ships**
fight in one arena; the server simulates everything and bots top the arena up to
100 so it always feels full. Built to run locally on Node and to deploy on
**Cloudflare Workers + Durable Objects**.

```
┌────────────┐  WebSocket   ┌──────────────────────────────┐
│  Browser   │ ───────────► │  Authoritative game server   │
│  client    │ ◄─────────── │  (Node  OR  Cloudflare DO)   │
│ predict +  │  snapshots   │  30 Hz sim · 20 Hz snapshots │
│ interpolate│              │  shared/ simulation core     │
└────────────┘              └──────────────────────────────┘
```

## Controls

- **W A S D** / arrow keys — thrust
- **Mouse** — aim
- **Click** or **Space** — fire
- Destroy ships for +100 score. You respawn 2.5s after dying.

## Run locally (Node)

```bash
npm install
npm start
# open http://localhost:3000  (open multiple tabs to add real players)
```

## Put it on GitHub + Cloudflare (play with 100 people on the web)

The arena is a Durable Object; the browser client is served as static assets by
the Worker. SQLite-backed Durable Objects are on the **Workers free plan**, so no
paid plan is required. Once it's live, share the URL — everyone who opens it joins
the same 100-player arena.

### Option A — push to GitHub, auto-deploy on every push (recommended)

This repo includes a GitHub Action (`.github/workflows/deploy.yml`) that deploys
to Cloudflare automatically whenever you push to `main`.

1. **Create the repo and push** (from this project folder):

   ```bash
   git init && git add -A && git commit -m "Nova 100"
   git branch -M main
   git remote add origin https://github.com/<your-user>/nova-100.git
   git push -u origin main
   ```

   (Create the empty `nova-100` repo first at https://github.com/new.)

2. **Make a Cloudflare API token**: https://dash.cloudflare.com/profile/api-tokens
   → *Create Token* → use the **"Edit Cloudflare Workers"** template → Create →
   copy the token.

3. **Add it to GitHub**: your repo → *Settings ▸ Secrets and variables ▸ Actions*
   → *New repository secret* → name `CLOUDFLARE_API_TOKEN`, paste the token.

4. Push again (or re-run the workflow from the **Actions** tab). It deploys and
   prints your live URL, e.g. `https://nova-100.<your-subdomain>.workers.dev`.

### Option B — one-click button

After your code is on GitHub, click this (edit the URL to your repo):

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/<your-user>/nova-100)

It clones the repo to your GitHub and deploys to your Cloudflare in one flow.

### Option C — deploy straight from your machine (no GitHub)

```bash
npm install
npx wrangler login      # authorizes your Cloudflare account in your browser
npm run deploy          # = wrangler deploy  → prints your live URL
```

Test the Cloudflare build locally first with `npm run cf:dev` (runs the Worker +
Durable Object on your machine).

> Every path needs **your** Cloudflare/GitHub login at least once — that auth step
> can't be done for you. Everything else (code, CI, config) is already wired up.

## Offline / single-player

`nova-100.html` in the project root is a standalone build — you vs 99 bots, no
server. Double-click it to play instantly, or host it as a plain static page.

## Project layout

```
shared/        single source of truth for the simulation
  constants.js   arena size, physics, weapon + net tuning
  game.js        authoritative world: ships, bullets, collisions, scoring
  bots.js        bot AI (aim-with-lead, strafe, engagement ring)
server/
  server.js      Node dev server: static files + ws + game loop
public/
  index.html     UI shell, HUD, start screen
  game.js        renderer, input, client-side prediction + interpolation
src/             Cloudflare deployment
  worker.js      routes /ws → Durable Object, serves static assets
  game-room.js   Durable Object: the live arena
wrangler.jsonc   Cloudflare config (assets + Durable Object binding)
```

## Networking notes

- **Authoritative server.** Clients send only inputs `{seq, mx, my, aim, shoot}`;
  the server owns all positions, damage, and scoring (cheat-resistant).
- **Client-side prediction** for your own ship — inputs are replayed on top of
  the last server-confirmed state, so movement feels instant.
- **Entity interpolation** (~100 ms buffer) renders other ships smoothly between
  20 Hz snapshots.
- **Interest management** — bullets and hit effects are only sent to clients
  within view range; the ~100-ship roster (used for the minimap) is compact.

## Tuning

Edit `shared/constants.js` — e.g. `MAX_PLAYERS`, `BOT_COUNT_TARGET`,
`BULLET_DAMAGE`, `MAX_SPEED`, `WORLD`. If you change movement physics, mirror the
same numbers in the `CFG` block at the top of `public/game.js` so client
prediction stays in sync with the server.

## Scaling past 100

One Durable Object = one arena. To host many arenas, shard by room name in
`src/worker.js` (`idFromName('arena-' + roomId)`) and add a room picker to the
client.
