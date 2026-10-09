'use client';

import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGameStore } from '@/game/store';
import { setAudioMuted, setMusicTrack, unlockAudio } from '@/game/audio';
import { getMusicTrack } from '@/game/music';
import { attachPreviewSession } from '@/game/previewSession';
import { CHEST_POSITION, DUNGEON_ENTRANCE, FIXED_STEP, GATE_POSITION, KEY_POSITION, type GameInput, type WorldData, type Zone } from '@/game/types';
import { getWorld } from '@/game/world';
import type { RenderStatistics } from '@/game/renderer';

// Keep the frame tally stable across development refreshes; the timer owns all
// formatting and React updates, while the render loop only increments a number.
const metricsHost = globalThis as typeof globalThis & { __zeldoRenderMetrics?: { frames: number; readStatistics?: () => RenderStatistics | null } };
const renderMetrics = metricsHost.__zeldoRenderMetrics ?? (metricsHost.__zeldoRenderMetrics = { frames: 0 });
const INPUT_EVENT = 'zeldo-input';
const CLEAR_INPUT_EVENT = 'zeldo-clear-input';
const emitInput = (detail: Partial<GameInput>) => window.dispatchEvent(new CustomEvent(INPUT_EVENT, { detail }));

type IconName = 'crown' | 'leaf' | 'sound' | 'muted' | 'pause' | 'play' | 'expand' | 'sword' | 'key' | 'gem' | 'arrow' | 'map' | 'close' | 'heart' | 'compass' | 'hand';
function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    crown: <><path d="m3 7 5 4 4-8 4 8 5-4-2 12H5Z"/><path d="M7 22h10"/></>,
    leaf: <><path d="M20 3C8 2 2 8 5 16c8 3 14-3 15-13Z"/><path d="M3 21 15 9M8 16l-1-6m1 6 7 1"/></>,
    sound: <><path d="m11 5-5 4H3v6h3l5 4Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
    muted: <><path d="m11 5-5 4H3v6h3l5 4Z"/><path d="m16 9 6 6m0-6-6 6"/></>,
    pause: <><path d="M8 5v14M16 5v14"/></>, play: <path d="m8 4 12 8-12 8Z"/>,
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>,
    sword: <><path d="m8 16 12-13 1 6-12 10m-4-8 8 8M3 21l4-4"/></>,
    key: <><circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-3-3 3-3m-6 0 3-3"/></>,
    gem: <><path d="m12 2 7 6v8l-7 6-7-6V8Z"/><path d="m12 2-3 6v8l3 6m0-20 3 6v8l-3 6M5 8h14M5 16h14"/></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    map: <><path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2ZM9 3v16m6-14v16"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    heart: <path d="M12 21 3.5 12.5C-2 6.8 6 0 12 6c6-6 14 1 8.5 6.5Z"/>,
    compass: <><circle cx="12" cy="12" r="10"/><path d="m16 8-3 5-5 3 3-5Z"/></>,
    hand: <path d="M8 12V5a2 2 0 0 1 4 0v6-3a2 2 0 0 1 4 0v4-2a2 2 0 0 1 4 0v6c0 4-3 6-7 6-3 0-5-2-7-5l-2-3a2 2 0 0 1 3-2l1 1Z"/>,
  };
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function formatTime(seconds: number) { return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
function begin() { unlockAudio(); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); useGameStore.getState().start(); }

function GameCanvas({ onReady, onError, blocked }: { onReady: () => void; onError: (error: string) => void; blocked: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const blockedInput = useRef(blocked);
  const clearInputs = useRef<() => void>(() => {});
  blockedInput.current = blocked;
  useEffect(() => { clearInputs.current(); window.dispatchEvent(new Event(CLEAR_INPUT_EVENT)); }, [blocked]);
  useEffect(() => {
    let disposed = false;
    let frame = 0;
    let view: Awaited<ReturnType<typeof import('@/game/renderer')['createGameRenderer']>> | undefined;
    const keys = new Set<string>();
    const touch: GameInput = { x: 0, z: 0, attack: false, interact: false };
    let clickedAttack = false;
    let interaction = false;
    let accumulator = 0;
    let previous = 0;
    let consecutiveFrameErrors = 0;
    const keydown = (e: KeyboardEvent) => {
      const store = useGameStore.getState();
      const focusedButton = e.target instanceof HTMLElement && e.target.closest('button');
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) || e.code === 'Space' && store.status === 'playing' && !blockedInput.current || e.code === 'Tab' && ['playing', 'paused'].includes(store.status)) e.preventDefault();
      if (e.repeat || e.code === 'Enter' && focusedButton) return;
      if (e.code === 'Enter' && !blockedInput.current && ['title', 'gameover', 'victory'].includes(store.status)) { begin(); return; }
      if (blockedInput.current || store.status !== 'playing') return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyE'].includes(e.code)) unlockAudio();
      // Space always belongs to combat during play, even after using a toolbar.
      if (e.code === 'Space' && focusedButton) focusedButton.blur();
      keys.add(e.code);
      if (e.code === 'KeyE') interaction = true;
    };
    const keyup = (e: KeyboardEvent) => keys.delete(e.code);
    const clear = () => { keys.clear(); touch.x = 0; touch.z = 0; touch.attack = false; touch.interact = false; clickedAttack = false; interaction = false; accumulator = 0; previous = 0; };
    clearInputs.current = clear;
    const click = () => { if (blockedInput.current) return; unlockAudio(); const s = useGameStore.getState(); if (s.status === 'title' || s.status === 'gameover') begin(); else if (s.status === 'playing') clickedAttack = true; };
    const touchInput = (event: Event) => { if (!blockedInput.current && useGameStore.getState().status === 'playing') Object.assign(touch, (event as CustomEvent<Partial<GameInput>>).detail); };
    const unsubscribe = useGameStore.subscribe((state, previousState) => { if (state.status !== previousState.status) clear(); });
    const resize = () => view?.resize();
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', clear);
    window.addEventListener('resize', resize);
    window.addEventListener(INPUT_EVENT, touchInput);
    window.addEventListener(CLEAR_INPUT_EVENT, clear);
    document.addEventListener('visibilitychange', clear);
    canvas.current?.addEventListener('pointerdown', click);
    import('@/game/renderer').then(({ createGameRenderer }) => {
      if (disposed || !canvas.current) return;
      view = createGameRenderer(canvas.current);
      renderMetrics.readStatistics = view.getStatistics;
      onReady();
      const loop = (now: number) => {
        if (disposed) return;
        // Reserve the next frame before work so one thrown update can recover.
        frame = requestAnimationFrame(loop);
        try {
          const delta = previous ? Math.min((now - previous) / 1000, 0.12) : FIXED_STEP;
          previous = now;
          if (!document.hidden) {
            accumulator = blockedInput.current ? 0 : accumulator + delta;
            let ticks = 0;
            while (accumulator >= FIXED_STEP && ticks++ < 8) {
              const x = Number(keys.has('KeyD') || keys.has('ArrowRight')) - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
              const z = Number(keys.has('KeyW') || keys.has('ArrowUp')) - Number(keys.has('KeyS') || keys.has('ArrowDown'));
              useGameStore.getState().tick(FIXED_STEP, { x: x || touch.x, z: z || touch.z, attack: keys.has('Space') || clickedAttack || touch.attack, interact: interaction || touch.interact });
              clickedAttack = false; interaction = false; touch.interact = false;
              accumulator -= FIXED_STEP;
            }
            if (ticks >= 8) accumulator = 0;
            view?.render(delta);
            renderMetrics.frames++;
            if (consecutiveFrameErrors > 0) onError('');
            consecutiveFrameErrors = 0;
          }
        } catch (error: unknown) {
          clear();
          consecutiveFrameErrors++;
          const message = error instanceof Error ? error.message : 'An unexpected update failed.';
          if (consecutiveFrameErrors === 1) {
            console.error('The adventure frame failed:', error);
            onError(`The adventure hit an error: ${message}`);
          }
          if (consecutiveFrameErrors >= 3) {
            cancelAnimationFrame(frame);
            onError(`The adventure stopped after repeated errors: ${message}`);
          }
        }
      };
      frame = requestAnimationFrame(loop);
    }).catch((error: unknown) => onError(error instanceof Error ? error.message : 'Unable to create the 3D world.'));
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (renderMetrics.readStatistics === view?.getStatistics) renderMetrics.readStatistics = undefined;
      view?.dispose();
      unsubscribe();
      clearInputs.current = () => {};
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', clear);
      window.removeEventListener('resize', resize);
      window.removeEventListener(INPUT_EVENT, touchInput);
      window.removeEventListener(CLEAR_INPUT_EVENT, clear);
      document.removeEventListener('visibilitychange', clear);
      canvas.current?.removeEventListener('pointerdown', click);
    };
  // The renderer is created once; callbacks only update React state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <canvas ref={canvas} className="world-canvas" aria-label="ZELDO 3D adventure. Use WASD or the touch joystick to move, Space or the sword button to attack, and E or the hand button to interact." />;
}

// Terrain updates with the game's tile state. React redraws moving map markers
// eight times a second while the memoized terrain keeps its geometry stable.
const MapTerrain = memo(function MapTerrain({ zone, world }: { zone: Zone; world: WorldData }) {
  const colors = { grass: '#4f7144', path: '#c8b381', water: '#3e929e', bridge: '#e5cb91', stone: zone === 'dungeon' ? '#657367' : '#849274' };
  return <g>
    {Object.entries(colors).map(([kind, color]) => <path key={kind} fill={color} d={world.tiles.filter(tile => tile.kind === kind).map(tile => `M${tile.x - .5},${tile.z - .5}h1v1h-1Z`).join('')}/>)}
    {world.objects.filter(object => object.solid && object.kind !== 'gate').map(object => {
      const solid = object.solid!;
      const color = object.kind === 'tree' || object.kind === 'hedge' ? '#294b32' : object.kind === 'house' ? '#b57d4b' : '#33483c';
      return 'r' in solid ? <circle key={object.id} cx={object.x} cy={object.z} r={solid.r} fill={color}/> : <rect key={object.id} x={object.x - solid.w / 2} y={object.z - solid.d / 2} width={solid.w} height={solid.d} rx=".1" fill={color}/>;
    })}
  </g>;
});

function readMap() {
  const state = useGameStore.getState();
  return { zone: state.zone, tileOverrides: state.tileOverrides, x: state.player.x, z: state.player.z, facing: state.player.facing, quest: { ...state.quest }, enemies: state.enemies.filter(enemy => enemy.alive).map(enemy => ({ id: enemy.id, x: enemy.x, z: enemy.z, boss: enemy.boss })), pots: state.breakables.filter(item => item.alive && item.kind === 'pot').map(item => ({ id: item.id, x: item.x, z: item.z })) };
}

function MiniMap({ expanded = false }: { expanded?: boolean }) {
  const [state, setState] = useState(readMap);
  useEffect(() => { const timer = window.setInterval(() => setState(readMap()), 125); return () => window.clearInterval(timer); }, []);
  const { x, z, zone, tileOverrides, quest, enemies, pots, facing } = state;
  const world = useMemo(() => getWorld(zone, tileOverrides), [zone, tileOverrides]);
  const dungeon = zone === 'dungeon';
  const point = (position: { x: number; z: number }) => `translate(${position.x} ${position.z})`;
  return <div className={`minimap ${expanded ? 'expanded-map' : ''}`}>
    <div className="map-heading"><span>{dungeon ? 'THE HOLLOW' : 'LARKSPUR VALLEY'}</span><span>N ↑</span></div>
    <svg viewBox={`-.5 -.5 ${world.width} ${world.height}`} role="img" aria-label="Current area map: cream arrow is you, red dots are monsters, the orange crown is the boss, gold symbols mark the entrance, key, gate and treasure.">
      <g transform={`translate(0 ${world.height - 1}) scale(1 -1)`}>
        <MapTerrain zone={zone} world={world}/>
        {pots.map(pot => <circle key={pot.id} cx={pot.x} cy={pot.z} r=".4" fill="#ab8562"/>)}
        {dungeon ? <>
          <g transform={point({ x: 12, z: 2 })}><title>Return to the valley</title><path d="M-.9-.65v1.2a.9.9 0 0 0 1.8 0v-1.2" stroke="#eee4bf" strokeWidth=".35" fill="#243f32"/></g>
          {!quest.key && <g transform={point(KEY_POSITION)} fill="#ffe29a" stroke="#293e30" strokeWidth=".15"><title>Brass key</title><circle cx="-.3" cy=".35" r=".6"/><path d="M0 0 .9-.9m-.35.35.35.35" stroke="#ffe29a" strokeWidth=".4"/></g>}
          <g transform={point(GATE_POSITION)}><title>{quest.gate ? 'Open boss gate' : 'Sealed boss gate'}</title><path d="M-2.6 0h5.2" stroke={quest.gate ? '#ccb983' : '#da8a6e'} strokeWidth={quest.gate ? '.25' : '.75'}/></g>
          <g transform={point(CHEST_POSITION)}><title>{quest.treasure ? 'Claimed treasure' : 'Hollow Crown treasure'}</title><rect x="-.8" y="-.6" width="1.6" height="1.2" rx=".2" fill={quest.treasure ? '#7f8865' : '#e8c880'} stroke="#293e30" strokeWidth=".25"/><path d="M0-.6V.6" stroke="#8c6338" strokeWidth=".25"/></g>
        </> : <g transform={point(DUNGEON_ENTRANCE)}><title>Dungeon entrance</title><path d="M-1-.9v1.2a1 1 0 0 0 2 0V-.9Z" fill="#213b30" stroke="#efd798" strokeWidth=".35"/></g>}
        {enemies.map(enemy => enemy.boss ? <g key={enemy.id} transform={point(enemy)}><title>Cinder Warden</title><path d="M-1-.65-.9.9-.35.35 0 1.1.35.35.9.9 1-.65Z" fill="#f3a573" stroke="#5a3029" strokeWidth=".22"/></g> : <circle key={enemy.id} cx={enemy.x} cy={enemy.z} r=".58" fill="#ee8d79" stroke="#513f32" strokeWidth=".18"><title>Monster</title></circle>)}
        <g className="map-player" transform={`translate(${x} ${z}) rotate(${facing * 180 / Math.PI - 90})`}><title>You are here</title><circle r="1.15" fill="#203b30" fillOpacity=".7"/><path d="M0 1.15-.7-.65 0-.3.7-.65Z" fill="#fff4cb" stroke="#2a4435" strokeWidth=".18"/></g>
      </g>
    </svg>
    <div className="map-caption"><span className="legend-dot player-dot"/> You <span className="legend-dot enemy-dot"/> Foes <span className="legend-dot boss-dot"/> Boss <span className="legend-dot goal-dot"/> Goal</div>
    {expanded && <p className="map-details">{dungeon ? 'Find the brass key, approach the sealed gate, then face the Warden. The chest holds the forest’s light.' : 'Follow the trail over the bridge. The stone arch in the northeast leads into the Hollow.'}</p>}
  </div>;
}

function PerformanceHud() {
  const [sample, setSample] = useState<({ fps: number; frameMs: number } & RenderStatistics) | null>(null);
  useEffect(() => {
    let previousFrames = renderMetrics.frames;
    let previousTime = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const frames = renderMetrics.frames - previousFrames;
      const statistics = renderMetrics.readStatistics?.();
      setSample(document.hidden || frames <= 0 || !statistics ? null : {
        fps: Math.round(frames * 1000 / (now - previousTime)),
        frameMs: (now - previousTime) / frames,
        ...statistics,
      });
      previousFrames = renderMetrics.frames; previousTime = now;
    }, 500);
    return () => window.clearInterval(timer);
  }, []);
  const count = (value: number | undefined) => value === undefined ? '—' : value >= 10000 ? `${(value / 1000).toFixed(1)}k` : value.toLocaleString('en-US');
  return <div className="fps-counter performance-hud" role="group" aria-label="Rendering performance statistics">
    <div title="Rendered frames per second, sampled every half second">{sample?.fps ?? '—'} <span>FPS</span></div>
    <div title="Average time between frames, including browser scheduling and display refresh">{sample?.frameMs.toFixed(1) ?? '—'} <span>MS / FRAME</span></div>
    <div title="Draw calls in the last rendered frame, including shadows">{count(sample?.drawCalls)} <span>DRAW CALLS</span></div>
    <div title="Meshes active in the camera view">{count(sample?.activeMeshes)} <span>MESHES</span></div>
    <div title="Submitted triangles in the last rendered frame, including shadow passes">{count(sample?.triangles)} <span>TRIS</span></div>
  </div>;
}

function QuestHud() {
  const { area, zone, key, gate, boss, treasure, time, hp, rupees, bossHP, bossMaxHP, bossAlive } = useGameStore(useShallow(s => ({ area: s.area, zone: s.zone, key: s.quest.key, gate: s.quest.gate, boss: s.quest.boss, treasure: s.quest.treasure, time: Math.floor(s.elapsed), hp: s.player.hp, rupees: s.rupees, bossHP: s.enemies.find(e => e.boss)?.hp ?? 0, bossMaxHP: s.enemies.find(e => e.boss)?.maxHp ?? 1, bossAlive: s.enemies.some(e => e.boss && e.alive) })));
  const objective = treasure ? 'The forest’s light is yours' : boss ? 'Claim the treasure' : gate ? 'Defeat the Cinder Warden' : key ? 'Approach the sealed boss gate' : zone === 'dungeon' ? 'Find the old brass key' : 'Find the dungeon entrance';
  const progress = treasure ? 5 : boss ? 4 : gate ? 3 : key ? 2 : zone === 'dungeon' ? 1 : 0;
  return <>
    <div className="vitals glass"><div className="heart-row" aria-label={`${hp} of 3 hearts`}>{[0, 1, 2].map(i => <Icon key={i} name="heart" className={hp > i ? 'heart-full' : 'heart-empty'}/>)}</div><div className="vitals-divider"/><Icon name="gem" className="rupee-icon"/><span className="rupee-count" aria-label={`${rupees} rupees`}>{rupees.toString().padStart(3, '0')}</span><span className={`key-slot ${key ? 'has-key' : ''}`} aria-label={key ? 'Dungeon key acquired' : 'Dungeon key not yet found'}><Icon name="key" className="key-icon"/></span></div>
    <div className="area-hud"><div className="area-label"><span/>{area}<span/></div><div className="quest-pill" aria-label={`Objective ${Math.min(progress + 1, 5)} of 5: ${objective}`}><Icon name={key ? 'key' : 'compass'}/><span>{objective}</span><span className="quest-step">{Math.min(progress + 1, 5)} / 5</span></div></div>
    {zone === 'dungeon' && gate && bossAlive && <div className="boss-bar"><div><span>THE CINDER WARDEN</span><span>{Math.max(0, bossHP)} / {bossMaxHP}</span></div><div className="boss-track" role="progressbar" aria-label="Cinder Warden health" aria-valuenow={bossHP} aria-valuemin={0} aria-valuemax={bossMaxHP}><div style={{ width: `${Math.max(0, bossHP) / bossMaxHP * 100}%` }}/></div></div>}
    <div className="adventure-time">YOUR ADVENTURE <span>{formatTime(time)}</span></div>
  </>;
}

function InteractionPrompt() {
  const label = useGameStore(s => {
    const p = s.player;
    const near = (v: { x: number; z: number }, distance: number) => Math.hypot(p.x - v.x, p.z - v.z) < distance;
    if (s.zone === 'overworld' && near(DUNGEON_ENTRANCE, 2.2)) return 'Walk into the Hollow';
    if (s.zone === 'dungeon' && near({ x: 12, z: 2 }, 1.65)) return 'Walk out to the valley';
    if (s.zone === 'dungeon' && !s.quest.gate && !s.quest.key && near(GATE_POSITION, 3.15)) return 'The gate needs a key';
    if (s.zone === 'dungeon' && near(CHEST_POSITION, 2.15) && s.quest.boss) return 'Open the treasure';
    return '';
  });
  if (!label) return null;
  return <div className="interaction-prompt glass">{label === 'The gate needs a key' ? <Icon name="key"/> : label.startsWith('Walk ') ? <Icon name="arrow"/> : <><kbd className="keyboard-interact">E</kbd><Icon name="hand" className="touch-interact-icon"/></>}{label}</div>;
}

function Notice() {
  const { title, body } = useGameStore(useShallow(s => ({ title: s.notice?.title ?? '', body: s.notice?.body ?? '' })));
  if (!title) return null;
  return <div className="notice glass" role="status"><Icon name="leaf"/><div><strong>{title}</strong><p>{body}</p></div></div>;
}

function DamageOverlay() {
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => useGameStore.subscribe(state => { if (overlay.current) overlay.current.style.opacity = String(Math.min(1, state.hurtFlash * 2)); }), []);
  return <div ref={overlay} className="damage-overlay" style={{ opacity: 0 }} />;
}

function TouchControls() {
  const joystick = useRef<HTMLButtonElement>(null);
  const knob = useRef<HTMLSpanElement>(null);
  const movePointer = useRef<number | null>(null);
  const attackPointer = useRef<number | null>(null);
  const interactPointer = useRef<number | null>(null);
  const reset = () => {
    movePointer.current = null; attackPointer.current = null; interactPointer.current = null;
    if (knob.current) knob.current.style.transform = 'translate(0, 0)';
    joystick.current?.classList.remove('is-active');
    emitInput({ x: 0, z: 0, attack: false, interact: false });
  };
  useEffect(() => {
    window.addEventListener('blur', reset);
    window.addEventListener(CLEAR_INPUT_EVENT, reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      reset(); window.removeEventListener('blur', reset); window.removeEventListener(CLEAR_INPUT_EVENT, reset); document.removeEventListener('visibilitychange', reset);
    };
  // All held input lives in refs; listeners keep the same reset callback.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (movePointer.current !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const radius = bounds.width * .29;
    const dx = (event.clientX - bounds.left - bounds.width / 2) / radius;
    const dz = -(event.clientY - bounds.top - bounds.height / 2) / radius;
    const distance = Math.hypot(dx, dz);
    const deflection = Math.min(1, distance);
    const strength = Math.max(0, (deflection - .08) / .92);
    const x = distance ? dx / distance * strength : 0;
    const z = distance ? dz / distance * strength : 0;
    if (knob.current) knob.current.style.transform = `translate(${distance ? dx / distance * deflection * radius : 0}px, ${distance ? -dz / distance * deflection * radius : 0}px)`;
    emitInput({ x, z });
  };
  const releaseMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (movePointer.current !== event.pointerId) return;
    movePointer.current = null;
    if (knob.current) knob.current.style.transform = 'translate(0, 0)';
    event.currentTarget.classList.remove('is-active');
    emitInput({ x: 0, z: 0 });
  };
  const releaseAttack = (event: ReactPointerEvent<HTMLButtonElement>) => { if (attackPointer.current === event.pointerId) { attackPointer.current = null; emitInput({ attack: false }); } };
  const releaseInteract = (event: ReactPointerEvent<HTMLButtonElement>) => { if (interactPointer.current === event.pointerId) { interactPointer.current = null; emitInput({ interact: false }); } };
  return <div className="touch-controls">
    <div className="joystick-wrap"><button ref={joystick} className="touch-joystick" aria-label="Movement joystick. Drag farther from the center to run faster." onPointerDown={event => {
      event.preventDefault(); if (movePointer.current !== null) return;
      unlockAudio(); movePointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.classList.add('is-active'); move(event);
    }} onPointerMove={move} onPointerUp={releaseMove} onPointerCancel={releaseMove} onLostPointerCapture={releaseMove}><span className="joystick-cross"/><span ref={knob} className="joystick-knob"/></button><span className="touch-label">MOVE</span></div>
    <div className="touch-actions"><button className="touch-key touch-interact" aria-label="Read signs or open treasure" onPointerDown={event => {
      event.preventDefault(); if (interactPointer.current !== null) return;
      interactPointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); unlockAudio(); emitInput({ interact: true });
    }} onPointerUp={releaseInteract} onPointerCancel={releaseInteract} onLostPointerCapture={releaseInteract}><Icon name="hand"/><span>ACT</span></button>
    <button className="touch-key touch-sword" aria-label="Swing sword" onPointerDown={event => {
      event.preventDefault(); if (attackPointer.current !== null) return;
      attackPointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); unlockAudio(); emitInput({ attack: true });
    }} onPointerUp={releaseAttack} onPointerCancel={releaseAttack} onLostPointerCapture={releaseAttack}><Icon name="sword"/><span>ATTACK</span></button></div>
  </div>;
}

export default function Game() {
  const { status, muted } = useGameStore(useShallow(s => ({ status: s.status, muted: s.muted })));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [rendererGeneration, setRendererGeneration] = useState(0);
  const [help, setHelp] = useState(false);
  const [map, setMap] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenMessage, setFullscreenMessage] = useState('');
  const [sessionReady, setSessionReady] = useState(process.env.NODE_ENV !== 'development');
  const title = status === 'title';
  useEffect(() => {
    const detach = attachPreviewSession(useGameStore);
    setSessionReady(true);
    return detach;
  }, []);
  useEffect(() => { setAudioMuted(muted); }, [muted]);
  useEffect(() => {
    const syncMusic = () => setMusicTrack(getMusicTrack(useGameStore.getState(), help || map || !!error || document.hidden));
    const unsubscribe = useGameStore.subscribe(syncMusic);
    document.addEventListener('visibilitychange', syncMusic);
    syncMusic();
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', syncMusic);
      setMusicTrack(null);
    };
  }, [help, map, error]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const store = useGameStore.getState();
      if (e.code === 'Tab' && ['playing', 'paused'].includes(store.status)) { e.preventDefault(); setHelp(false); setMap(m => !m); }
      if (e.code === 'Escape') {
        if (help || map) { setHelp(false); setMap(false); }
        else store.togglePause();
      }
      if (e.code === 'KeyP' && !help && !map) store.togglePause();
      if (e.code === 'KeyM') { unlockAudio(); store.toggleMute(); }
    };
    const full = () => setFullscreen(!!document.fullscreenElement);
    window.addEventListener('keydown', listener);
    document.addEventListener('fullscreenchange', full);
    return () => { window.removeEventListener('keydown', listener); document.removeEventListener('fullscreenchange', full); };
  }, [help, map]);
  useEffect(() => { if (status === 'title' || status === 'gameover' || status === 'victory') { setHelp(false); setMap(false); } }, [status]);
  useEffect(() => { if (!fullscreenMessage) return; const timer = window.setTimeout(() => setFullscreenMessage(''), 4500); return () => window.clearTimeout(timer); }, [fullscreenMessage]);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen && document.fullscreenEnabled) await document.documentElement.requestFullscreen();
      else setFullscreenMessage('Fullscreen is unavailable in this browser. You can keep playing here.');
    } catch { setFullscreenMessage('This browser could not open fullscreen. You can keep playing here.'); }
  };
  const toggleHelp = () => { setMap(false); setHelp(v => !v); };
  if (!sessionReady) return <main className="game-shell"><div className="modal-backdrop"><section className="menu-card"><p>Loading your adventure…</p></section></div></main>;
  return <main className={`game-shell ${title ? 'is-title' : 'is-playing'} ${status === 'paused' ? 'is-paused' : ''}`}>
    <GameCanvas key={rendererGeneration} onReady={() => { setReady(true); setError(''); }} onError={setError} blocked={help || map}/>
    <div className="scene-vignette"/>
    {title && <div className="title-shade"/>}
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Icon name="crown"/></div><span>ZELDO<span className="brand-separator">/</span><span className="brand-edition">A SMALL ADVENTURE</span></span></div>
      <div className="toolbar">
        {!title && <button className="tool-button" aria-label={status === 'paused' ? 'Resume game' : 'Pause game'} title="Pause · Esc" onClick={() => useGameStore.getState().togglePause()}><Icon name={status === 'paused' ? 'play' : 'pause'}/></button>}
        <button className="tool-button" aria-label={muted ? 'Unmute sound' : 'Mute sound'} title="Sound · M" onClick={() => { unlockAudio(); useGameStore.getState().toggleMute(); }}><Icon name={muted ? 'muted' : 'sound'}/><span className="sound-label">SOUND {muted ? 'OFF' : 'ON'}</span></button>
        <button className="tool-button help-button" aria-label="How to play" onClick={toggleHelp}>?</button>
        <button className="tool-button fullscreen-button" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}><Icon name="expand"/></button>
      </div>
    </header>
    {fullscreenMessage && <div className="fullscreen-message glass" role="status">{fullscreenMessage}</div>}
    {title ? <>
      <section className="title-content">
        <div className="eyebrow"><span className="little-line"/> SOMEWHERE, BEYOND THE PINES</div>
        <h1>ZELDO<span className="title-dot">.</span></h1>
        <div className="chapter"><span/>THE HOLLOW CROWN<span/></div>
        <p className="title-story">A little courage goes a long way.</p>
        <p className="title-description">Follow the winding paths of Larkspur Valley.<br/>Find the forgotten Hollow. Bring the forest’s light home.</p>
        <button className="begin-button" disabled={!ready || !!error} onClick={begin}><span>{error ? 'THE WORLD COULD NOT LOAD' : ready ? 'BEGIN YOUR ADVENTURE' : 'GROWING YOUR WORLD…'}</span><Icon name="arrow"/></button>
        <div className="start-hint"><span className="hint-line"/><span>or press <kbd>ENTER</kbd></span><span className="hint-line"/></div>
        {error && <p className="error-message">{error} Try a browser with WebGL enabled.</p>}
        <div className="adventure-details"><span><span className="detail-dot"/>5–10 MINUTES</span><span>ONE SMALL, COMPLETE ADVENTURE</span></div>
      </section>
      <div className="world-stamp"><Icon name="compass"/><div><span>YOUR STORY STARTS HERE</span><strong>Larkspur Valley</strong><span>38° NORTH · A LITTLE OFF THE MAP</span></div></div>
      <footer className="title-footer"><div><Icon name="leaf"/><span>A hand-built world. A heart-filled quest.</span></div><span>NO SAVES. NO RUSH. JUST ADVENTURE.</span></footer>
    </> : <>
      <QuestHud/><PerformanceHud/>
      <div className="hud-bottom"><div className="control-strip glass"><span><kbd>W</kbd><span className="wasd-small"><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><small>MOVE</small></span><i/><span><kbd className="wide-key">SPACE</kbd><small>SWING SWORD</small></span><i/><span><kbd>E</kbd><small>INTERACT</small></span><i/><button onClick={() => setMap(v => !v)}><Icon name="map"/><small>MAP <span className="key-subtle">TAB</span></small></button></div><button className="minimap-button" aria-label="Expand map" onClick={() => setMap(v => !v)}><MiniMap/></button></div>
      <InteractionPrompt/><Notice/><DamageOverlay/>{status === 'playing' && !help && !map && <TouchControls/>}
    </>}
    {status === 'paused' && !help && !map && <div className="modal-backdrop"><section className="menu-card"><div className="modal-emblem"><Icon name="leaf"/></div><div className="eyebrow">TAKE A BREATH</div><h2>The forest can wait.</h2><p>Your adventure is right where you left it.</p><button className="begin-button" onClick={() => useGameStore.getState().togglePause()}>CONTINUE ADVENTURE<Icon name="play"/></button><button className="text-button" onClick={() => setHelp(true)}>A little guidance</button></section></div>}
    {(status === 'gameover' || status === 'victory') && <EndScreen victory={status === 'victory'}/>}
    {help && <div className="modal-backdrop"><section className="menu-card help-card"><button className="close-button" aria-label="Close instructions" onClick={() => setHelp(false)}><Icon name="close"/></button><div className="eyebrow">A LITTLE GUIDANCE</div><h2>Every hero starts small.</h2><div className="help-controls"><div><kbd>W A S D</kbd><p>Move through the valley.<br/>On touchscreens, drag the left joystick. A small drag walks slowly.</p></div><div><kbd>SPACE</kbd><p>Swing your sword.<br/>Use the right sword button on touchscreens. A click works, too.</p></div><div><kbd>E</kbd><p>Read signs and open treasure.<br/>Walk into doorways to enter or leave. With the key, the gate opens as you approach.</p></div><div><kbd>M / ESC</kbd><p>Toggle sound / take a break.<br/>Tab or a tap on the minimap opens your map. The corner button toggles fullscreen.</p></div></div><p className="help-quest">Follow the path east, cross the little bridge, and head northeast to the stone arch. In the Hollow, find the key before facing its king. Dodge the orange lunge path and move clear of glowing ember pools. Cut grass and break pots for hearts and gems.</p><button className="begin-button" onClick={() => setHelp(false)}>GOT IT<Icon name="arrow"/></button></section></div>}
    {map && ['playing', 'paused'].includes(status) && <div className="modal-backdrop map-backdrop"><div className="map-overlay glass"><button className="close-button" aria-label="Close map" onClick={() => setMap(false)}><Icon name="close"/></button><div className="eyebrow">A LITTLE PERSPECTIVE</div><MiniMap expanded/></div></div>}
    {!title && error && <div className="modal-backdrop"><section className="menu-card" role="alert"><h2>The world hit a snag.</h2><p>Your adventure is still here. Reload the view to continue.</p><p className="error-message">{error}</p><button className="begin-button" onClick={() => { setReady(false); setError(''); setRendererGeneration(value => value + 1); }}>CONTINUE ADVENTURE<Icon name="play"/></button></section></div>}
  </main>;
}

function EndScreen({ victory }: { victory: boolean }) {
  const { elapsed, rupees } = useGameStore(useShallow(s => ({ elapsed: s.elapsed, rupees: s.rupees })));
  return <div className="modal-backdrop ending"><section className="menu-card end-card"><div className={`modal-emblem ${victory ? 'victory-emblem' : 'lost-emblem'}`}><Icon name={victory ? 'crown' : 'heart'}/></div><div className="eyebrow">{victory ? 'A SMALL HERO. A GREAT ADVENTURE.' : 'THE PATH IS STILL THERE'}</div><h2>{victory ? <>The forest breathes<br/>again.</> : <>Even brave hearts<br/>need another try.</>}</h2><p>{victory ? 'You returned the Hollow Crown to the light. Somewhere in Larkspur Valley, the flowers are waking up.' : 'The Hollow keeps its secrets a little longer. Take a breath, sharpen your sword, and begin again.'}</p><div className="end-stats"><div><span>ADVENTURE TIME</span><strong>{formatTime(elapsed)}</strong></div><div><span>RUPEES FOUND</span><strong><Icon name="gem"/>{rupees}</strong></div></div><button className="begin-button" onClick={begin}>{victory ? 'WANDER ONCE MORE' : 'TRY AGAIN'}<Icon name="arrow"/></button><div className="start-hint">or press <kbd>ENTER</kbd></div></section></div>;
}
