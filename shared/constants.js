// Shared game constants (authoritative). The client mirrors the physics block
// and the TYPES palette — keep them in sync if you change them.
export const TICK_RATE = 30;            // server simulation ticks / sec
export const SNAPSHOT_RATE = 20;        // state broadcasts / sec
export const DT = 1 / TICK_RATE;

export const WORLD = { w: 6000, h: 6000 };
export const MAX_PLAYERS = 100;         // humans cap per room

// Ship physics — fluid, momentum-y flight
export const SHIP_RADIUS = 16;
export const ACCEL = 1000;              // px/s^2
export const MAX_SPEED = 560;           // px/s
export const FRICTION = 0.94;           // velocity retained per tick
export const RESPAWN_MS = 5000;         // a ship destroyed by a meteor respawns after this

// Mining cannon — big, fast slug on a hold-to-charge trigger
export const BULLET_SPEED = 1200;       // px/s
export const BULLET_TTL = 1.2;          // seconds → ~1440px range
export const BULLET_RADIUS = 12;
export const BULLET_DAMAGE = 50;        // damage dealt to an asteroid per hit
export const CHARGE_MS = 1000;          // hold this long to launch a shot

// Networking / interest management
export const VIEW_RADIUS = 2500;        // entities within this range are sent — well
                                        // beyond the zoomed-out view so they load
                                        // off-screen (no pop-in as you fly)

// Asteroid + material types. Each asteroid is made of one material that bursts
// out when it's destroyed. Rarer types (lower weight) are worth more.
export const TYPES = [
  { name: 'Rock',    color: '#9aa6b2', value: 1,  weight: 34, hard: 1.0 },
  { name: 'Ice',     color: '#9fe8ff', value: 2,  weight: 20, hard: 0.8 },
  { name: 'Iron',    color: '#c08457', value: 4,  weight: 16, hard: 1.4 },
  { name: 'Copper',  color: '#e0794a', value: 6,  weight: 12, hard: 1.3 },
  { name: 'Silver',  color: '#cdd7e2', value: 10, weight: 8,  hard: 1.6 },
  { name: 'Crystal', color: '#c77dff', value: 16, weight: 5,  hard: 1.2 },
  { name: 'Gold',    color: '#ffd166', value: 28, weight: 3,  hard: 1.8 },
  { name: 'Plasma',  color: '#06d6a0', value: 45, weight: 2,  hard: 1.5 },
];

// Asteroids
export const ASTEROID_COUNT = 160;      // target population kept stocked in the arena
export const ASTEROID_R_MIN = 18;
export const ASTEROID_R_MAX = 64;
export const ASTEROID_SPLIT_MIN_R = 28; // larger than this splits into two on death
export const ASTEROID_DRIFT = 28;       // px/s max drift speed
export const ASTEROID_HP_K = 1.1;       // hp ≈ radius * hardness * K

// Material drops
export const MATERIAL_RADIUS = 7;
export const MATERIAL_TTL = 18;         // seconds before an uncollected drop fades
export const MATERIAL_EJECT = 200;      // initial burst speed when an asteroid breaks
export const MATERIAL_FRICTION = 0.95;  // drift damping per tick
export const COLLECT_RADIUS = 26;       // collected when a ship is within SHIP_RADIUS+this
export const MAGNET_RADIUS = 160;       // drops are pulled toward a ship within this
export const MAGNET_ACCEL = 700;        // px/s^2 magnet pull

// Bots
export const BOT_COUNT_TARGET = 40;     // miner bots keep the arena lively
export const BOT_VIEW = 1100;           // bot awareness range
