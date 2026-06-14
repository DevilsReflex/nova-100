// Shared game constants (authoritative). The client keeps a matching copy in
// public/game.js — if you change physics here, mirror it there for prediction.
export const TICK_RATE = 30;            // server simulation ticks / sec
export const SNAPSHOT_RATE = 20;        // state broadcasts / sec
export const DT = 1 / TICK_RATE;

export const WORLD = { w: 6000, h: 6000 };
export const MAX_PLAYERS = 100;         // humans + bots combined

// Ship physics — tuned for fluid, momentum-y flight
export const SHIP_RADIUS = 16;
export const ACCEL = 1000;              // px/s^2 (snappier response)
export const MAX_SPEED = 560;           // px/s
export const FRICTION = 0.94;           // velocity retained per tick (more glide)
export const SHIP_MAX_HP = 100;
export const RESPAWN_MS = 2500;

// Weapons — big, fast missiles on a slow trigger (not a rapid-fire machine gun).
// The long cooldown also keeps the projectile count (and the lag) low.
export const BULLET_SPEED = 1200;       // px/s — fast projectile
export const BULLET_TTL = 1.2;          // seconds → ~1440px range
export const BULLET_RADIUS = 12;        // bigger projectile / hit area
export const BULLET_DAMAGE = 50;        // two missiles down a full-HP ship
export const FIRE_COOLDOWN_MS = 1200;   // ~0.8 launches/sec — slow, deliberate trigger

// Networking / interest management
export const VIEW_RADIUS = 1500;        // detailed entities sent within range (wider for zoom-out)

// Bots
export const BOT_COUNT_TARGET = 100;    // top up arena to this many total ships
export const BOT_VIEW = 900;            // bot aggro/awareness range
