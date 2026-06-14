// Shared game constants (authoritative). The client keeps a matching copy in
// public/game.js — if you change physics here, mirror it there for prediction.
export const TICK_RATE = 30;            // server simulation ticks / sec
export const SNAPSHOT_RATE = 20;        // state broadcasts / sec
export const DT = 1 / TICK_RATE;

export const WORLD = { w: 6000, h: 6000 };
export const MAX_PLAYERS = 100;         // humans + bots combined

// Ship physics
export const SHIP_RADIUS = 16;
export const ACCEL = 900;               // px/s^2
export const MAX_SPEED = 520;           // px/s
export const FRICTION = 0.92;           // velocity retained per tick
export const SHIP_MAX_HP = 100;
export const RESPAWN_MS = 2500;

// Weapons
export const BULLET_SPEED = 900;        // px/s
export const BULLET_TTL = 1.1;          // seconds
export const BULLET_RADIUS = 4;
export const BULLET_DAMAGE = 18;
export const FIRE_COOLDOWN_MS = 160;

// Networking / interest management
export const VIEW_RADIUS = 1300;        // detailed entities sent within this range

// Bots
export const BOT_COUNT_TARGET = 100;    // top up arena to this many total ships
export const BOT_VIEW = 900;            // bot aggro/awareness range
