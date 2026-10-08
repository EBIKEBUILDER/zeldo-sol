export type Zone = 'overworld' | 'dungeon';
export type Status = 'title' | 'playing' | 'paused' | 'gameover' | 'victory';
export type TileKind = 'grass' | 'path' | 'water' | 'bridge' | 'stone';
export type ObjectKind = 'tree' | 'rock' | 'hedge' | 'wall' | 'flowers' | 'house' | 'sign' | 'arch' | 'torch' | 'pedestal' | 'gate' | 'chest' | 'stump' | 'mushroom' | 'reeds' | 'bench' | 'banner';
export interface WorldObject { id: string; kind: ObjectKind; x: number; z: number; scale?: number; rotation?: number; variant?: number; solid?: { w: number; d: number } | { r: number }; }
export interface Tile { x: number; z: number; kind: TileKind; variant: number; }
export interface WorldData { width: number; height: number; tiles: Tile[]; objects: WorldObject[]; }
export interface Player { x: number; z: number; vx: number; vz: number; facing: number; hp: number; invulnerable: number; attackTime: number; attackCooldown: number; }
export interface NavigationPoint { x: number; z: number; }
export interface EnemyNavigation { path: NavigationPoint[]; index: number; repath: number; targetX: number; targetZ: number; stuck: number; chasing: boolean; }
export type BossAttackMode = 'pursue' | 'telegraph' | 'fire' | 'chargeTelegraph' | 'charge' | 'recover';
export interface Projectile { id: string; x: number; z: number; vx: number; vz: number; age: number; duration: number; radius: number; ownerId: string; }
export interface Enemy { id: string; x: number; z: number; homeX: number; homeZ: number; vx: number; vz: number; hp: number; maxHp: number; alive: boolean; boss: boolean; hitstun: number; flash: number; contactCooldown: number; respawn: number; wanderAngle: number; wanderTime: number; lastAttack: number; navigation: EnemyNavigation; attackMode: BossAttackMode; attackTimer: number; rangedCooldown: number; damageCooldown: number; aimX: number; aimZ: number; phase: 1 | 2; }
export interface Breakable { id: string; kind: 'grass' | 'pot'; x: number; z: number; alive: boolean; }
export interface Pickup { id: string; kind: 'rupee' | 'heart' | 'key'; x: number; z: number; age: number; }
export interface Effect { id: string; kind: 'hit' | 'poof' | 'grass' | 'pot' | 'sparkle' | 'swing'; x: number; z: number; age: number; duration: number; angle: number; }
export interface Quest { key: boolean; gate: boolean; boss: boolean; treasure: boolean; }
export interface Notice { title: string; body: string; time: number; }
export interface GameData { status: Status; zone: Zone; player: Player; enemies: Enemy[]; breakables: Breakable[]; pickups: Pickup[]; projectiles: Projectile[]; effects: Effect[]; quest: Quest; elapsed: number; rupees: number; muted: boolean; area: string; shake: number; hurtFlash: number; notice: Notice | null; seed: number; }
export interface GameInput { x: number; z: number; attack: boolean; interact: boolean; }
export interface GameActions { start: () => void; togglePause: () => void; toggleMute: () => void; tick: (dt: number, input: GameInput) => void; }
export type GameStore = GameData & GameActions;
export const FIXED_STEP = 1 / 60;
export const OVERWORLD_SPAWN = { x: 8, z: 5 };
export const DUNGEON_ENTRANCE = { x: 42, z: 27 };
export const DUNGEON_SPAWN = { x: 12, z: 4 };
export const KEY_POSITION = { x: 7, z: 10 };
export const GATE_POSITION = { x: 12, z: 17 };
export const CHEST_POSITION = { x: 12, z: 32 };
