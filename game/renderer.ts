'use client';

import {
  Camera, Color3, Color4, DirectionalLight, Engine, FreeCamera,
  HemisphericLight, Mesh, MeshBuilder, PointLight, Scene, ShadowGenerator,
  Quaternion, SceneInstrumentation, StandardMaterial, TransformNode, Vector3, VertexData,
} from '@babylonjs/core';
import { useGameStore } from './store';
import { getWorld } from './world';
import { getSwordSweep } from './swordMotion';
import { getEnemyYaw } from './enemyMotion';
import { BOSS_BLAST_RADIUS, BOSS_BLAST_SPREAD, BOSS_CHARGE_DURATION, BOSS_CHARGE_SPEED, BOSS_CHARGE_TELEGRAPH, BOSS_TELEGRAPH } from './simulation';
import type { Effect, Enemy, GameStore, Hazard, Pickup, Projectile, WorldObject, Zone } from './types';

export interface RenderStatistics { drawCalls: number; activeMeshes: number; triangles: number; }

// The renderer owns only geometry and animation. The store owns every game rule.
export function createGameRenderer(canvas: HTMLCanvasElement) {
  const engine = new Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  const touchDevice = window.matchMedia('(pointer: coarse)').matches;
  engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, touchDevice ? 1.5 : 1.7));
  const scene = new Scene(engine);
  // Draw counting is already built into Babylon; instrumentation resets it for
  // each scene frame, including its shadow pass. Read these counters only on demand.
  const instrumentation = new SceneInstrumentation(scene);
  scene.clearColor = new Color4(.57, .67, .50, 1);
  scene.ambientColor = new Color3(.09, .12, .08);
  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = 1;
  scene.imageProcessingConfiguration.exposure = 1.0;
  scene.imageProcessingConfiguration.contrast = 1.16;
  const camera = new FreeCamera('adventure-camera', new Vector3(8, 25, -15), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = .1;
  camera.maxZ = 140;
  scene.activeCamera = camera;
  const sky = new HemisphericLight('soft-sky', new Vector3(-.3, 1, -.3), scene);
  sky.intensity = .60;
  sky.diffuse = Color3.FromHexString('#d3e8d6');
  sky.groundColor = Color3.FromHexString('#4c6242');
  const sun = new DirectionalLight('afternoon-sun', new Vector3(-.48, -1, .38), scene);
  sun.position = new Vector3(26, 38, -12);
  sun.diffuse = Color3.FromHexString('#ffe1a5');
  sun.intensity = 1.08;
  sun.shadowMinZ = 1;
  sun.shadowMaxZ = 85;
  sun.autoUpdateExtends = false;
  sun.orthoLeft = -25;
  sun.orthoRight = 25;
  sun.orthoTop = 25;
  sun.orthoBottom = -25;
  const shadows = new ShadowGenerator(2048, sun);
  shadows.usePercentageCloserFiltering = true;
  shadows.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  shadows.bias = .0012;
  shadows.normalBias = .015;
  shadows.darkness = .18;

  const materials = new Map<string, StandardMaterial>();
  function mat(name: string, color: string, emissive = 0, alpha = 1) {
    // Materials with the same appearance share one GPU program and batch.
    const key = `${color}:${emissive}:${alpha}`;
    let material = materials.get(key);
    if (!material) {
      material = new StandardMaterial(name, scene);
      material.diffuseColor = Color3.FromHexString(color);
      material.specularColor = Color3.Black();
      material.emissiveColor = material.diffuseColor.scale(emissive);
      material.alpha = alpha;
      material.backFaceCulling = false;
      materials.set(key, material);
    }
    return material;
  }
  const palette = {
    grass: ['#56813e', '#597f3d', '#5c8542', '#527b3a'],
    path: ['#aa8e59', '#b19661', '#a78b56', '#af955f'],
    leaf: ['#174d34', '#20673f', '#328044', '#427e41'],
    stone: ['#777f75', '#919788', '#666f67', '#8c9083'],
    dungeon: ['#4e5955', '#505b56', '#55615a', '#47544f'],
    bark: '#704629', wood: '#a56a35', darkWood: '#60402b', gold: '#d8ab43',
    cream: '#e3cc9a', pot: '#b5693e', pink: '#d95e98', water: '#267f86',
  };
  let serial = 0;
  let staticGroups = new Map<StandardMaterial, Mesh[]>();
  let staticCasters = new Set<Mesh>();
  const frozenMaterials = new Set<StandardMaterial>();
  let zoneRoot: TransformNode | null = null;
  let activeZone: Zone | null = null;
  let activeTileOverrides: GameStore['tileOverrides'][Zone];
  let clock = 0;
  let torchLights: PointLight[] = [];
  let flames: Mesh[] = [];
  let gate: TransformNode | null = null;
  let chestLid: TransformNode | null = null;
  let waterRipples: Mesh[] = [];
  const decorFloat: { mesh: Mesh; phase: number; speed: number; y: number }[] = [];
  let titleCameraBlend = 1;
  let viewHeight = 20;
  const random = (x: number, z = 0) => {
    const a = Math.sin(x * 127.1 + z * 311.7 + 17.43) * 43758.5453;
    return a - Math.floor(a);
  };

  function finish(mesh: Mesh, material: StandardMaterial, parent: TransformNode | null, cast = false, stat = false) {
    mesh.material = material;
    mesh.parent = parent;
    mesh.isPickable = false;
    if (stat) {
      const meshes = staticGroups.get(material) || [];
      meshes.push(mesh);
      staticGroups.set(material, meshes);
      if (cast) staticCasters.add(mesh);
    } else if (cast) shadows.addShadowCaster(mesh);
    return mesh;
  }
  function box(name: string, w: number, h: number, d: number, x: number, y: number, z: number, material: StandardMaterial, parent: TransformNode | null = zoneRoot, cast = false, stat = true) {
    const mesh = MeshBuilder.CreateBox(`${name}-${serial++}`, { width: w, height: h, depth: d }, scene);
    mesh.position.set(x, y, z);
    return finish(mesh, material, parent, cast, stat);
  }
  function cylinder(name: string, top: number, bottom: number, h: number, sides: number, x: number, y: number, z: number, material: StandardMaterial, parent: TransformNode | null = zoneRoot, cast = false, stat = true) {
    const mesh = MeshBuilder.CreateCylinder(`${name}-${serial++}`, { diameterTop: top, diameterBottom: bottom, height: h, tessellation: sides }, scene);
    mesh.position.set(x, y, z);
    return finish(mesh, material, parent, cast, stat);
  }
  function rock(name: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, material: StandardMaterial, parent: TransformNode | null = zoneRoot, cast = true, stat = true) {
    const mesh = MeshBuilder.CreateIcoSphere(`${name}-${serial++}`, { radius: 1, subdivisions: 1, flat: true }, scene);
    mesh.position.set(x, y, z);
    mesh.scaling.set(sx, sy, sz);
    mesh.rotation.set(random(x, z) * .4, random(z, x) * 6.28, random(x + 7, z) * .5);
    return finish(mesh, material, parent, cast, stat);
  }
  function sphere(name: string, size: number, x: number, y: number, z: number, material: StandardMaterial, parent: TransformNode, cast = false, smooth = false) {
    const mesh = MeshBuilder.CreateSphere(`${name}-${serial++}`, { diameter: size, segments: smooth ? 16 : 10 }, scene);
    mesh.position.set(x, y, z);
    if (!smooth) mesh.convertToFlatShadedMesh();
    return finish(mesh, material, parent, cast, false);
  }
  function blade(x: number, z: number, size: number, angle: number, material: StandardMaterial, parent: TransformNode | null = zoneRoot, stat = true, leafy = false) {
    const mesh = new Mesh(`grass-blade-${serial++}`, scene);
    const data = new VertexData();
    // Broad, folded leaves make sword-cut clumps read differently from tiny meadow blades.
    data.positions = leafy
      ? [-size * .15, 0, 0, size * .15, 0, 0, -size * .20, size * .46, -.015,
        size * .23, size * .46, -.015, size * .16, size * .77, .07, size * .29, size, .16]
      : [-size * .12, 0, 0, size * .12, 0, 0, size * .08, size * .52, .01, size * .26, size, .06];
    data.indices = leafy ? [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4] : [0, 1, 2, 1, 3, 2];
    const normals: number[] = [];
    VertexData.ComputeNormals(data.positions, data.indices, normals);
    data.normals = normals;
    data.applyToMesh(mesh);
    mesh.position.set(x, .04, z);
    mesh.rotation.y = angle;
    return finish(mesh, material, parent, leafy, stat);
  }
  function tuft(x: number, z: number, size: number, parent: TransformNode | null = zoneRoot, stat = true, bright = false) {
    const material = mat('grass-blades', bright ? '#94ab4d' : '#3f662e');
    for (let j = 0; j < 6; j++) blade(x + (random(x + j, z) - .5) * size * .5, z + (random(z + j, x) - .5) * size * .5, size * (.65 + random(j + x, z) * .35), j * 1.24 + random(x, z), material, parent, stat);
  }
  function flower(x: number, z: number, color: string, size = 1) {
    cylinder('flower-stem', .027, .036, .25 * size, 3, x, .125 * size, z, mat('flower-stem', '#5c743a'));
    const petal = mat('petal', color, .08);
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2;
      const p = rock('flower-petal', x + Math.cos(a) * .075 * size, .28 * size, z + Math.sin(a) * .075 * size, .085 * size, .026 * size, .073 * size, petal, zoneRoot, false);
      p.rotation.y = a;
    }
    rock('flower-center', x, .30 * size, z, .035 * size, .025 * size, .035 * size, mat('flower-pollen', '#e9be65', .08), zoneRoot, false);
  }
  function tree(o: WorldObject) {
    const s = o.scale ?? 1;
    const phase = random(o.x, o.z);
    const treeRoot = new TransformNode(`tree-${o.id}`, scene);
    treeRoot.parent = zoneRoot;
    treeRoot.position.set(o.x, 0, o.z);
    treeRoot.rotation.y = o.rotation ?? phase * 6.28;
    cylinder('pine-trunk', .23 * s, .37 * s, 1.3 * s, 6, 0, .65 * s, 0, mat('pine-bark', palette.bark), treeRoot, true);
    cylinder('pine-roots', .30 * s, .62 * s, .28 * s, 5, 0, .14 * s, 0, mat('pine-root', '#685139'), treeRoot);
    const colorIndex = (o.variant ?? Math.floor(phase * 4)) % 4;
    for (let layer = 0; layer < 3; layer++) {
      const foliage = cylinder('pine-boughs', 0, (2.65 - layer * .56) * s, (1.8 - layer * .18) * s, 7, 0, (1.50 + layer * .75) * s, 0, mat(`pine-${layer}`, palette.leaf[(colorIndex + layer) % 4]), treeRoot, true);
      foliage.rotation.y = layer * .43;
      foliage.scaling.z = .84 + phase * .14;
    }
  }
  function stoneObject(o: WorldObject) {
    const s = o.scale ?? 1;
    const variation = random(o.x, o.z);
    rock('stone', o.x, .40 * s, o.z, .75 * s, .62 * s, .55 * s, mat('stone', palette.stone[(o.variant ?? Math.floor(variation * 4)) % 4]));
    if (s > 1) rock('little-stone', o.x + .64 * s, .19, o.z - .34 * s, .31, .25, .28, mat('stone', palette.stone[0]));
    if (variation > .6) rock('moss', o.x - .10, .76 * s, o.z + .05, .38 * s, .06 * s, .29 * s, mat('stone-moss', '#758448'), zoneRoot, false);
  }
  function house(o: WorldObject) {
    const houseRoot = new TransformNode('willow-cottage', scene);
    houseRoot.parent = zoneRoot;
    houseRoot.position.set(o.x, 0, o.z);
    houseRoot.rotation.y = o.rotation || 0;
    const plaster = mat('cottage-plaster', '#d3c19a');
    const timber = mat('cottage-timber', '#755339');
    const roof = mat('roof-terracotta', '#ad6449');
    box('cottage', 3.5, 2.3, 3.2, 0, 1.15, 0, plaster, houseRoot, true);
    for (const x of [-1.70, 1.70]) {
      for (const z of [-1.55, 1.55]) box('corner-beam', .12, 2.38, .12, x, 1.19, z, timber, houseRoot, true);
    }
    box('house-foot', 3.65, .20, 3.35, 0, .10, 0, mat('cottage-stone', '#898473'), houseRoot, true);
    // The roof is a closed, asymmetric pitched prism, not two floating slabs.
    const mesh = new Mesh('cottage-pitched-roof', scene);
    const v = new VertexData();
    v.positions = [-2.1, 2.22, -1.94, 2.1, 2.22, -1.94, 0, 3.65, -1.94, -2.1, 2.22, 1.94, 2.1, 2.22, 1.94, 0, 3.65, 1.94];
    v.indices = [0, 1, 2, 3, 5, 4, 0, 5, 3, 0, 2, 5, 1, 5, 2, 1, 4, 5, 0, 4, 1, 0, 3, 4];
    const normals: number[] = [];
    VertexData.ComputeNormals(v.positions, v.indices, normals);
    v.normals = normals;
    v.applyToMesh(mesh);
    mesh.convertToFlatShadedMesh();
    finish(mesh, roof, houseRoot, true, true);
    for (const x of [-.96, 1.0]) {
      box('window-inset', .7, .8, .045, x, 1.34, -1.623, mat('window-dark', '#4b6553'), houseRoot);
      box('window-cross', .08, .85, .055, x, 1.34, -1.66, timber, houseRoot);
      box('window-cross', .74, .08, .055, x, 1.34, -1.66, timber, houseRoot);
      box('flower-box', .88, .22, .35, x, .82, -1.76, mat('flowerbox', '#a67847'), houseRoot, true);
      for (let i = 0; i < 3; i++) {
        rock('window-flower', x - .22 + i * .22, 1.04, -1.78, .15, .13, .13, mat('window-petals', i === 1 ? '#e4be66' : '#dd8b93'), houseRoot, false);
      }
    }
    box('door', .68, 1.65, .08, 0, .87, -1.65, mat('door', '#785035'), houseRoot);
    for (const x of [-.23, 0, .23]) box('door-plank', .025, 1.62, .04, x, .87, -1.71, timber, houseRoot);
    rock('door-handle', .20, .94, -1.77, .053, .053, .04, mat('brass', palette.gold), houseRoot, false);
    box('doorstep', 1.2, .16, .58, 0, .08, -1.9, mat('step', '#a5a28c'), houseRoot, true);
    box('chimney', .62, 1.38, .60, 1.05, 3.34, .60, mat('chimney', '#85766a'), houseRoot, true);
    box('chimney-top', .79, .15, .74, 1.05, 4.03, .6, mat('chimney', '#75695f'), houseRoot, true);
    for (let i = 0; i < 3; i++) {
      const smoke = sphere('chimney-puff', .7 + i * .25, o.x + 1.1 + i * .20, 4.4 + i * .6, o.z + .6, mat('smoke', '#d4d7bd', .1, .28), zoneRoot!);
      decorFloat.push({ mesh: smoke, phase: i * 1.8, speed: .6, y: smoke.position.y });
    }
  }
  function arch(o: WorldObject, dungeon: boolean) {
    const root = new TransformNode(`arch-${o.id}`, scene);
    root.position.set(o.x, 0, o.z);
    root.rotation.y = o.rotation || 0;
    root.parent = zoneRoot;
    const stone = mat('arch-stone', dungeon ? '#73746a' : '#858b77');
    for (const x of [-1.10, 1.10]) {
      for (let i = 0; i < 4; i++) {
        const b = box('arch-block', .70 - (i % 2) * .04, .6, .85, x, .30 + i * .61, 0, stone, root, true);
        b.rotation.y = (i % 2 ? 1 : -1) * .025;
      }
      box('arch-foot', .90, .24, 1.02, x, .12, 0, mat('arch-base', '#687465'), root, true);
    }
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI + (i + .5) / 5 * Math.PI;
      const b = box('arch-crown', .69, .70, .85, Math.cos(a) * 1.10, 2.24 - Math.sin(a) * .75, 0, stone, root, true);
      b.rotation.z = a + Math.PI / 2;
    }
    if (!dungeon) {
      const darkness = mat('entrance-dark', '#203d33', .1);
      box('portal-dark', 1.72, 2.58, .07, 0, 1.29, .46, darkness, root);
      box('threshold', 2.10, .10, 1.6, 0, .05, -.3, mat('threshold', '#989d85'), root);
      rock('arch-ivy', -.95, 2.2, -.47, .46, .29, .11, mat('ivy', '#48694b'), root, false);
      rock('arch-ivy', -1.27, 1.66, -.47, .25, .46, .13, mat('ivy', '#48694b'), root, false);
      const sigil = rock('door-sigil', 0, 2.77, -.49, .15, .21, .04, mat('door-gold', '#e9c375', .45), root, false);
      sigil.rotation.z = .25;
    }
  }
  function chest(o: WorldObject) {
    const root = new TransformNode('crown-chest', scene);
    root.parent = zoneRoot;
    root.position.set(o.x, .12, o.z);
    const timber = mat('chest-wood', '#986337');
    const metal = mat('treasure-brass', '#d1a452');
    box('chest-body', 1.45, .65, 1.0, 0, .32, 0, timber, root, true, false);
    for (const x of [-.57, .57]) {
      box('chest-band', .10, .72, 1.04, x, .37, 0, metal, root, false, false);
    }
    box('chest-lock', .22, .29, .11, 0, .53, -.55, metal, root, false, false);
    chestLid = new TransformNode('chest-lid-pivot', scene);
    chestLid.parent = root;
    chestLid.position.set(0, .68, .48);
    const lid = cylinder('chest-lid', .9, .9, 1.45, 8, 0, 0, -.48, timber, chestLid, true, false);
    lid.rotation.z = Math.PI / 2;
    lid.scaling.z = .65;
    for (const x of [-.57, .57]) {
      const band = cylinder('chest-lid-band', .94, .94, .10, 8, x, 0, -.48, metal, chestLid, false, false);
      band.rotation.z = Math.PI / 2;
      band.scaling.z = .65;
    }
    box('chest-interior', 1.22, .035, .79, 0, .7, 0, mat('treasure-glow', '#ffe296', .7), root, false, false);
  }
  function makeObject(o: WorldObject, dungeon: boolean) {
    const s = o.scale ?? 1;
    switch (o.kind) {
      case 'tree': tree(o); break;
      case 'rock': stoneObject(o); break;
      case 'house': house(o); break;
      case 'flowers':
        for (let j = 0; j < 9; j++) flower(o.x + (random(o.x + j, o.z) - .5) * 1.6 * s, o.z + (random(o.z + j, o.x) - .5) * 1.2 * s, ['#e2c76a', '#e2bfc1', '#eed9a5'][j % 3], .7 + random(j, o.z) * .35);
        break;
      case 'hedge':
        for (let j = 0; j < 3; j++) rock('hedge', o.x + (j - 1) * .55 * s, .54 * s, o.z, .60 * s, .7 * s, .6 * s, mat('hedge', palette.leaf[(j + (o.variant || 0)) % 4]));
        break;
      case 'wall': {
        const dims = o.solid && 'w' in o.solid ? o.solid : { w: 1, d: 1 };
        box('dungeon-wall', dims.w, 1.8 * s, dims.d, o.x, .9 * s, o.z, mat('wall', '#3e4e49'), zoneRoot, true);
        box('wall-cap', dims.w + .08, .14, dims.d + .08, o.x, 1.82 * s, o.z, mat('wall-cap', '#68736a'), zoneRoot, true);
        if (dims.w > 2) for (let i = -dims.w / 2 + 1; i < dims.w / 2; i += 2) box('wall-mortar', .045, 1.62, dims.d + .01, o.x + i, .83, o.z, mat('wall-seam', '#33443f'));
        break;
      }
      case 'arch': arch(o, dungeon); break;
      case 'gate': {
        gate = new TransformNode('locked-gate', scene);
        gate.parent = zoneRoot;
        gate.position.set(o.x, 0, o.z);
        const iron = mat('gate-iron', '#667363');
        const gateWidth = o.solid && 'w' in o.solid ? o.solid.w : 5.2;
        const jambWidth = .26;
        const openingWidth = gateWidth - jambWidth;
        // Jambs overlap the existing wall ends; the entire doorway remains clear when the bars lower.
        for (const side of [-1, 1]) box('gate-jamb', jambWidth, 2.85, 1.24, o.x + side * gateWidth / 2, 1.425, o.z, mat('gate-jamb', '#68736a'), zoneRoot, true);
        for (let i = -4; i <= 4; i++) {
          const x = i * openingWidth / 8;
          cylinder('gate-bar', .13, .13, 2.50, 5, x, 1.25, 0, iron, gate, true, false);
          cylinder('gate-point', 0, .27, .35, 5, x, 2.66, 0, mat('gate-gold', '#b2a16b'), gate, true, false);
        }
        for (const y of [.65, 1.8]) box('gate-crossbar', gateWidth, .16, .19, 0, y, 0, iron, gate, true, false);
        box('gate-lock', .42, .51, .32, 0, 1.3, -.14, mat('gate-lock', '#bd9f55'), gate, true, false);
        box('gate-keyhole', .07, .18, .02, 0, 1.33, -.31, mat('keyhole', '#37493d'), gate, false, false);
        break;
      }
      case 'chest': chest(o); break;
      case 'torch': {
        cylinder('torch-post', .1, .17, 1.12, 5, o.x, .62, o.z, mat('torch-wood', '#805d3e'));
        cylinder('torch-cup', .34, .15, .28, 6, o.x, 1.2, o.z, mat('torch-cup', '#7c836b'));
        const flame = rock('torch-flame', o.x, 1.55, o.z, .15, .35, .15, mat('flame', '#ffc464', 1.5), zoneRoot, false, false);
        flames.push(flame);
        rock('flame-heart', o.x, 1.43, o.z - .02, .11, .17, .1, mat('flame-core', '#ffe7a0', 2), zoneRoot, false);
        if (dungeon) {
          if (torchLights.length < 6) {
            const light = new PointLight(`torchlight-${o.id}`, new Vector3(o.x, 2.0, o.z), scene);
            light.diffuse = Color3.FromHexString('#ffbb70');
            light.intensity = 2.0;
            light.range = 8;
            torchLights.push(light);
          }
          // The warm pool is visible even on inexpensive GPUs that limit active lights.
          const pool = cylinder('torch-pool', 3.5, 3.5, .015, 32, o.x, .037, o.z, mat('torch-glow', '#b69151', .35, .12), zoneRoot, false, false);
          pool.receiveShadows = false;
        }
        break;
      }
      case 'pedestal':
        cylinder('pedestal-base', 1.5, 1.8, .19, 8, o.x, .09, o.z, mat('pedestal', '#7c8376'));
        cylinder('pedestal-column', .98, 1.13, .46, 8, o.x, .4, o.z, mat('pedestal', '#6b776d'));
        cylinder('pedestal-top', 1.50, 1.45, .19, 8, o.x, .71, o.z, mat('pedestal-top', '#b7af89'));
        for (let i = 0; i < 4; i++) rock('pedestal-rune', o.x + Math.cos(i * 1.57) * .54, .82, o.z + Math.sin(i * 1.57) * .54, .065, .035, .065, mat('rune', '#e2c77f', .4), zoneRoot, false);
        break;
      case 'sign': {
        cylinder('sign-post', .13, .18, 1.05, 5, o.x, .5, o.z, mat('sign-post', '#7f5d3b'));
        box('sign-board', .99, .55, .13, o.x, .92, o.z, mat('sign', '#b59360'), zoneRoot, true);
        const arrow = box('sign-arrow', .39, .075, .02, o.x + .08, .92, o.z - .076, mat('sign-ink', '#725d3d'));
        arrow.rotation.z = .05;
        const point = box('sign-arrow-tip', .16, .16, .02, o.x + .28, .92, o.z - .076, mat('sign-ink', '#725d3d'));
        point.rotation.z = Math.PI / 4;
        break;
      }
      case 'stump':
        cylinder('stump', .65 * s, .92 * s, .5 * s, 7, o.x, .25 * s, o.z, mat('stump', '#856344'), zoneRoot, true);
        cylinder('stump-ring', .57 * s, .57 * s, .015, 7, o.x, .51 * s, o.z, mat('cut-wood', '#bcaa77'));
        cylinder('stump-core', .30 * s, .30 * s, .017, 7, o.x, .52 * s, o.z, mat('wood-ring', '#9d8d62'));
        break;
      case 'mushroom':
        for (let i = 0; i < 3; i++) {
          const x = o.x + (i - 1) * .24, z = o.z + random(i, o.z) * .2;
          cylinder('mushroom-stem', .05, .08, .22, 5, x, .11, z, mat('mushroom-stem', '#e7d6ad'));
          cylinder('mushroom-cap', .02, .37, .18, 7, x, .26, z, mat('mushroom-cap', '#ca785b'));
          rock('mushroom-dot', x + .045, .33, z - .07, .032, .012, .032, mat('mushroom-dot', '#ebdfba'), zoneRoot, false);
        }
        break;
      case 'reeds':
        for (let i = 0; i < 5; i++) {
          const x = o.x + (random(i, o.x) - .5) * .56, z = o.z + (random(i, o.z) - .5) * .4;
          cylinder('reed', .027, .045, .68 + i * .08, 3, x, .34 + i * .04, z, mat('reeds', '#6b804b'));
          cylinder('cattail', .07, .09, .19, 5, x, .75 + i * .08, z, mat('reed-head', '#806a46'));
        }
        break;
      case 'bench':
        box('bench-seat', 1.6, .13, .64, o.x, .48, o.z, mat('bench', '#9f784a'), zoneRoot, true);
        for (const x of [-.60, .60]) box('bench-leg', .14, .49, .42, o.x + x, .24, o.z, mat('bench-leg', '#745539'));
        box('bench-back', 1.6, .35, .10, o.x, .91, o.z + .25, mat('bench', '#9f784a'), zoneRoot, true);
        break;
      case 'banner': {
        cylinder('banner-pole', .055, .09, 2.2, 6, o.x, 1.1, o.z, mat('banner-pole', '#a89c73'));
        const b = box('banner', .7, 1.0, .035, o.x + .4, 1.55, o.z, mat('banner-cloth', '#bc7361'), zoneRoot, true);
        b.rotation.z = -.08;
        box('banner-symbol', .23, .28, .05, o.x + .4, 1.55, o.z - .025, mat('banner-symbol', '#e7cc8a'));
        break;
      }
    }
  }

  function buildZone(zone: Zone, tileOverrides: GameStore['tileOverrides']) {
    for (const material of frozenMaterials) material.unfreeze();
    frozenMaterials.clear();
    if (zoneRoot) {
      const doomed = zoneRoot.getChildMeshes();
      for (const mesh of doomed) shadows.removeShadowCaster(mesh);
      zoneRoot.dispose(false, false);
    }
    for (const light of torchLights) light.dispose();
    torchLights = [];
    flames = [];
    waterRipples = [];
    decorFloat.length = 0;
    gate = null;
    chestLid = null;
    staticGroups = new Map();
    staticCasters = new Set();
    zoneRoot = new TransformNode(`world-${zone}`, scene);
    activeZone = zone;
    activeTileOverrides = tileOverrides[zone];
    const world = getWorld(zone, tileOverrides);
    const dungeon = zone === 'dungeon';
    scene.clearColor = Color4.FromHexString(dungeon ? '#22372fff' : '#829270ff');
    sky.intensity = dungeon ? .54 : .60;
    sky.diffuse = Color3.FromHexString(dungeon ? '#b8c7b2' : '#d3e8d6');
    sun.intensity = dungeon ? .28 : 1.08;
    sun.diffuse = Color3.FromHexString(dungeon ? '#fff2c3' : '#ffe1a5');
    scene.ambientColor = dungeon ? new Color3(.14, .18, .11) : new Color3(.09, .12, .08);
    scene.imageProcessingConfiguration.exposure = dungeon ? 1.12 : 1.0;
    scene.imageProcessingConfiguration.contrast = dungeon ? 1.12 : 1.16;
    const ground = box('earth', world.width + 28, .5, world.height + 28, (world.width - 1) / 2, -.35, (world.height - 1) / 2, mat('earth', dungeon ? '#3e4b45' : palette.grass[0]), zoneRoot, false, false);
    ground.receiveShadows = true;
    for (const tile of world.tiles) {
      const variant = tile.variant % 4;
      let material: StandardMaterial;
      if (tile.kind === 'grass') material = mat('meadow-ground', palette.grass[variant]);
      else if (tile.kind === 'path') material = mat('path', palette.path[variant]);
      else if (tile.kind === 'water') material = mat('creek-water', ['#287f88', '#27838c', '#328b92', '#2c828b'][variant], .06);
      else if (tile.kind === 'bridge') material = mat('bridge-planks', variant % 2 ? '#a88750' : '#b49159');
      else material = mat('dungeon-floor', palette.dungeon[variant]);
      const y = tile.kind === 'water' ? -.12 : tile.kind === 'bridge' ? .09 : -.04;
      const width = tile.kind === 'stone' ? .96 : 1.003;
      const mesh = box('tile', width, .10, width, tile.x, y, tile.z, material);
      mesh.receiveShadows = true;
      if (tile.kind === 'bridge') {
        box('bridge-plank-gap', 1.01, .012, .02, tile.x, .147, tile.z - .36, mat('plank-seam', '#6f6340'));
        box('bridge-plank-gap', 1.01, .012, .02, tile.x, .147, tile.z + .12, mat('plank-seam', '#6f6340'));
      }
      if (tile.kind === 'water' && random(tile.x, tile.z) > .85) {
        const ripple = box('stream-ripple', .22 + random(tile.z, tile.x) * .6, .013, .027, tile.x + .15, -.053, tile.z + .05, mat('stream-gleam', '#b4c9a1', .15, .62), zoneRoot, false, false);
        waterRipples.push(ripple);
      }
      if (tile.kind === 'grass' && random(tile.x, tile.z) > .71) {
        tuft(tile.x + (random(tile.z, tile.x) - .5) * .8, tile.z + (random(tile.x + 3, tile.z) - .5) * .8, .23 + random(tile.x, tile.z + 2) * .14);
      }
      if (tile.kind === 'path' && random(tile.x, tile.z) > .90) {
        rock('trail-pebble', tile.x + .22, .042, tile.z -.28, .065, .045, .07, mat('trail-pebble', '#a39b76'), zoneRoot, false);
      }
    }
    for (const o of world.objects) makeObject(o, dungeon);
    if (!dungeon) {
      // Hand-built railings give the crossing a visible silhouette.
      for (const x of [22.7, 27.3]) {
        for (const z of [12.6, 14.0, 15.6]) cylinder('bridge-post', .12, .18, .86, 5, x, .50, z, mat('bridge-rails', '#8b6942'), zoneRoot, true);
        for (const y of [.65, .95]) box('bridge-rail', .10, .09, 3.2, x, y, 14.1, mat('bridge-rails', '#9f7b4b'), zoneRoot, true);
      }
      // Occasional buttercups, little mushrooms, and pale river banks reward looking closely.
      for (let i = 0; i < 75; i++) {
        const x = random(i + 64, 21) * (world.width - 2) + 1;
        const z = random(i + 93, 50) * (world.height - 2) + 1;
        const tile = world.tiles.find(t => Math.abs(t.x - x) < .51 && Math.abs(t.z - z) < .51);
        if (tile?.kind === 'grass') flower(x, z, i % 4 === 0 ? '#dfb2b3' : '#e1c76c', .65 + random(i, 8) * .5);
      }
      for (let i = 0; i < 18; i++) {
        const puff = rock('floating-pollen', random(i + 30, 2) * world.width, 1.0 + random(i + 3, 44) * 2.5, random(i + 49, 5) * world.height, .035, .035, .035, mat('pollen', '#e5d7a0', .4, .55), zoneRoot, false, false);
        decorFloat.push({ mesh: puff, phase: i * .89, speed: .45 + random(i, 40), y: puff.position.y });
      }
      // Larger tufts sit alongside the welcoming path to the cottage.
      for (let i = 0; i < 13; i++) tuft(10.5 + i * .65, 3.1 + random(i, 9) * .3, .30);
    } else {
      const rug = box('crown-room-runner', 2.3, .014, 10.5, 12, .025, 27.2, mat('faded-carpet', '#7f5853'));
      rug.receiveShadows = true;
      for (const x of [10.93, 13.07]) box('rug-gold-edge', .038, .016, 10.55, x, .035, 27.2, mat('rug-edge', '#ad8a58'));
      for (let i = 0; i < 4; i++) {
        const r = box('floor-rune', .53, .02, .53, 12 + Math.cos(i * 1.57) * 2.4, .033, 27 + Math.sin(i * 1.57) * 2.4, mat('floor-rune', '#6b7866'));
        r.rotation.y = Math.PI / 4;
      }
    }
    // Shared-material batches stay small enough for offscreen groves and halls to be culled.
    // Shadow casters and receiving floor pieces keep independent render flags.
    for (const [material, meshes] of staticGroups) {
      const chunks = new Map<string, Mesh[]>();
      for (const mesh of meshes) {
        mesh.computeWorldMatrix(true);
        const position = mesh.getAbsolutePosition();
        const cast = staticCasters.has(mesh);
        const chunk = `${Math.floor(position.x / 16)}:${Math.floor(position.z / 16)}:${cast}:${mesh.receiveShadows}`;
        const pieces = chunks.get(chunk) || [];
        pieces.push(mesh);
        chunks.set(chunk, pieces);
      }
      for (const [chunk, pieces] of chunks) {
        const cast = staticCasters.has(pieces[0]);
        const receive = pieces[0].receiveShadows;
        const merged = Mesh.MergeMeshes(pieces, true, true, undefined, false, false);
        if (!merged) continue;
        merged.name = `baked-${material.name}-${chunk}`;
        merged.material = material;
        merged.parent = zoneRoot;
        merged.isPickable = false;
        merged.receiveShadows = receive;
        if (cast) shadows.addShadowCaster(merged);
        merged.freezeWorldMatrix();
        frozenMaterials.add(material);
      }
    }
    ground.freezeWorldMatrix();
    staticGroups.clear();
    staticCasters.clear();
  }

  const heroRoot = new TransformNode('moss-the-hero', scene);
  const heroBody = new TransformNode('hero-body-bob', scene);
  heroBody.parent = heroRoot;
  const cloth = mat('hero-tunic', '#5b8861');
  const darkGreen = mat('hero-hat', '#3a7250');
  const skin = mat('hero-skin', '#e8bd8c');
  const boots = mat('hero-boots', '#695038');
  const shirt = MeshBuilder.CreateCapsule('little-tunic', { radius: .27, height: .75, tessellation: 10, capSubdivisions: 3, subdivisions: 1 }, scene);
  shirt.position.y = .70;
  shirt.scaling.z = .84;
  finish(shirt, cloth, heroBody, true, false);
  const head = sphere('hero-face', .54, 0, 1.22, .025, skin, heroBody, true);
  head.scaling.z = .91;
  for (const x of [-.28, .28]) sphere('hero-ear', .12, x, 1.23, .015, skin, heroBody);
  sphere('hero-nose', .08, 0, 1.22, .292, skin, heroBody);
  for (const x of [-.105, .105]) {
    const eye = sphere('hero-eye', .048, x, 1.28, .265, mat('hero-eye', '#283a32'), heroBody);
    eye.scaling.z = .35;
  }
  const hair = sphere('hero-hair', .57, 0, 1.36, -.06, mat('hero-hair', '#735439'), heroBody);
  hair.scaling.y = .44;
  hair.scaling.z = .85;
  const hat = cylinder('hero-cap', .35, .60, .19, 9, 0, 1.48, -.025, darkGreen, heroBody, true, false);
  hat.rotation.x = -.12;
  const hatTip = cylinder('hero-cap-tip', .03, .42, .58, 7, 0, 1.60, -.19, darkGreen, heroBody, true, false);
  hatTip.rotation.x = -.70;
  const hatFold = rock('cap-tail', 0, 1.62, -.40, .11, .10, .14, mat('hat-tip', '#467f54'), heroBody, true, false);
  hatFold.rotation.x = -.4;
  box('belt', .52, .12, .44, 0, .59, 0, mat('belt', '#806340'), heroBody, false, false);
  box('belt-buckle', .12, .13, .035, 0, .59, .238, mat('hero-brass', '#d3b36c'), heroBody, false, false);
  const leftFoot = sphere('left-boot', .23, -.15, .20, .045, boots, heroBody, true);
  const rightFoot = sphere('right-boot', .23, .15, .20, .045, boots, heroBody, true);
  leftFoot.scaling.set(.76, 1.0, 1.35);
  rightFoot.scaling.set(.76, 1.0, 1.35);
  const leftArm = sphere('left-arm', .21, -.32, .78, .025, cloth, heroBody);
  const rightArm = sphere('right-arm', .21, .32, .79, .025, cloth, heroBody);
  leftArm.scaling.y = rightArm.scaling.y = 1.4;
  sphere('left-hand', .13, -.34, .61, .10, skin, heroBody);
  const rightHand = sphere('right-hand', .13, .37, .61, .14, skin, heroRoot);
  const shieldRoot = new TransformNode('little-round-shield', scene);
  shieldRoot.parent = heroBody;
  shieldRoot.position.set(-.38, .74, .09);
  shieldRoot.rotation.z = -.13;
  const shield = cylinder('shield', .49, .49, .10, 8, 0, 0, 0, mat('shield-rim', '#c7b07e'), shieldRoot, true, false);
  shield.rotation.x = Math.PI / 2;
  const inset = cylinder('shield-inset', .40, .40, .105, 8, 0, 0, .015, mat('shield-face', '#71897a'), shieldRoot, false, false);
  inset.rotation.x = Math.PI / 2;
  box('shield-emblem', .11, .19, .025, 0, 0, .075, mat('shield-mark', '#e0cf93'), shieldRoot, false, false).rotation.z = Math.PI / 4;
  const swordRoot = new TransformNode('little-sword', scene);
  swordRoot.parent = heroRoot;
  swordRoot.position.set(.38, .64, .17);
  swordRoot.rotation.x = -.52;
  box('sword-grip', .067, .20, .063, 0, 0, 0, mat('sword-grip', '#806449'), swordRoot, false, false);
  box('sword-guard', .30, .062, .085, 0, .13, 0, mat('sword-brass', '#dbc17e'), swordRoot, false, false);
  box('sword-blade', .085, .53, .034, 0, .43, 0, mat('sword-steel', '#d7e1d9', .10), swordRoot, true, false);
  const swordPoint = cylinder('sword-point', 0, .085, .11, 4, 0, .75, 0, mat('sword-steel', '#d7e1d9', .10), swordRoot, false, false);
  swordPoint.scaling.z = .4;

  type GroundMarker = { root: TransformNode; fill: Mesh; ring: Mesh };
  type EnemyVisual = { root: TransformNode; body: Mesh; eyes: Mesh[]; normal: StandardMaterial; tell?: Mesh; aim?: TransformNode; line?: Mesh; targets?: GroundMarker[]; orb?: Mesh; chargeAim?: TransformNode; corridor?: Mesh; arrows?: Mesh[]; guard?: Mesh };
  type ProjectileVisual = { root: TransformNode; body: TransformNode; landing?: GroundMarker; shadow?: Mesh };
  const enemyVisuals = new Map<string, EnemyVisual>();
  const breakableVisuals = new Map<string, TransformNode>();
  const pickupVisuals = new Map<string, TransformNode>();
  const projectileVisuals = new Map<string, ProjectileVisual>();
  const hazardVisuals = new Map<string, GroundMarker & { embers: Mesh[] }>();
  const effectVisuals = new Map<string, { root: TransformNode; pieces: Mesh[]; kind: Effect['kind']; flare?: GroundMarker }>();
  let stateZone: Zone | null = null;
  const flashMat = mat('enemy-hit-white', '#fff0ca', .65);

  function groundMarker(name: string, radius: number, color: string, parent: TransformNode | null, opacity = .38, rimColor = color): GroundMarker {
    const root = new TransformNode(`${name}-${serial++}`, scene);
    root.parent = parent;
    root.scaling.set(radius, 1, radius);
    const fill = cylinder(`${name}-fill`, 2, 2, .012, 48, 0, .052, 0, mat(`${name}-fill`, color, .35, opacity), root, false, false);
    // The torus's outer edge is exactly unit radius, so it matches the damaging area.
    const ring = MeshBuilder.CreateTorus(`${name}-rim`, { diameter: 1.94, thickness: .06, tessellation: 48 }, scene);
    ring.position.y = .072;
    finish(ring, mat(`${name}-rim`, rimColor, .55, .95), root, false, false);
    return { root, fill, ring };
  }

  function jellyBody(size: number, seed: number, material: StandardMaterial, parent: TransformNode) {
    const mesh = new Mesh(`jelly-body-${serial++}`, scene);
    const data = new VertexData();
    const positions: number[] = [], indices: number[] = [], normals: number[] = [];
    const profile = [[.03, .0], [.055, .50], [.16, .56], [.37, .52], [.60, .42], [.77, .27], [.85, .095], [.865, .0]]
      .map(([height, radius]) => new Vector3(radius, height, 0));
    // Round the contour between its original landmarks, preserving the jelly's shape.
    const rings = [profile[0]];
    for (let ring = 0; ring < profile.length - 1; ring++) {
      for (let step = 1; step <= 4; step++) {
        rings.push(Vector3.CatmullRom(profile[Math.max(0, ring - 1)], profile[ring],
          profile[ring + 1], profile[Math.min(profile.length - 1, ring + 2)], step / 4));
      }
    }
    const sides = size > 1 ? 48 : 32;
    // Each cap has one shared vertex so lighting blends across the entire pole.
    positions.push(profile[0].y ** 2 * .19 * size, profile[0].y * size, profile[0].y ** 2 * .19 * .35 * size);
    for (const { x: radius, y: height } of rings.slice(1, -1)) {
      for (let i = 0; i < sides; i++) {
        const angle = i / sides * Math.PI * 2;
        const skirt = 1 - height / .865;
        const wobble = 1 + Math.sin(angle * 3 + seed) * .10 * skirt + Math.sin(angle * 5 + seed * 2) * .06 * skirt;
        const drift = height * height * .19;
        positions.push((Math.cos(angle) * radius * wobble + drift) * size,
          (height + (radius ? Math.sin(angle * 2 + seed) * .016 * skirt : 0)) * size,
          (Math.sin(angle) * radius * wobble * .91 + drift * .35) * size);
      }
    }
    const top = positions.length / 3;
    const topHeight = profile[profile.length - 1].y;
    positions.push(topHeight ** 2 * .19 * size, topHeight * size, topHeight ** 2 * .19 * .35 * size);
    const lastRing = 1 + (rings.length - 3) * sides;
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      indices.push(0, 1 + next, 1 + side, lastRing + side, lastRing + next, top);
    }
    for (let ring = 0; ring < rings.length - 3; ring++) {
      for (let side = 0; side < sides; side++) {
        const a = 1 + ring * sides + side, b = 1 + ring * sides + (side + 1) % sides;
        indices.push(a, b, a + sides, b, b + sides, a + sides);
      }
    }
    VertexData.ComputeNormals(positions, indices, normals);
    data.positions = positions; data.indices = indices; data.normals = normals;
    data.applyToMesh(mesh);
    return finish(mesh, material, parent, true, false);
  }
  function makeEnemy(enemy: Enemy): EnemyVisual {
    const root = new TransformNode(`enemy-${enemy.id}`, scene);
    const seed = random(enemy.homeX, enemy.homeZ);
    const normal = mat(enemy.boss ? 'crown-keeper' : 'mossling', enemy.boss ? '#b94583' : seed > .5 ? '#4d9d58' : '#43a785');
    normal.specularColor = new Color3(.08, .10, .07);
    normal.specularPower = 28;
    const body = jellyBody(enemy.boss ? 2.25 : .96, seed * 6.28, normal, root);
    const faceZ = enemy.boss ? -.99 : -.43;
    const faceY = enemy.boss ? 1.03 : .46;
    const eyes: Mesh[] = [];
    let tell: Mesh | undefined, line: Mesh | undefined, orb: Mesh | undefined, corridor: Mesh | undefined, guard: Mesh | undefined;
    let aim: TransformNode | undefined, chargeAim: TransformNode | undefined;
    const targets: GroundMarker[] = [], arrows: Mesh[] = [];
    for (const x of [-1, 1]) {
      const eye = sphere('monster-eye-white', enemy.boss ? .30 : .18, x * (enemy.boss ? .39 : .19), faceY + (x === 1 ? .025 : 0), faceZ, mat('monster-eye', '#eae5c4'), body, false, true);
      eye.scaling.set(1, 1.10, .52);
      const pupil = sphere('monster-pupil', enemy.boss ? .15 : .082, x * (enemy.boss ? .39 : .19), faceY -.008, faceZ - .079, mat('monster-pupil', '#243e32'), body, false, true);
      pupil.scaling.set(.83, 1.14, .40);
      eyes.push(eye, pupil);
      if (!enemy.boss) {
        const cheek = sphere('jelly-cheek', .09, x * .31, faceY -.12, faceZ + .016, mat('jelly-cheek', '#e69387'), body, false, true);
        cheek.scaling.set(1.15, .44, .24);
      }
    }
    sphere('monster-mouth', enemy.boss ? .21 : .095, .025, faceY - (enemy.boss ? .24 : .15), faceZ - .01, mat('monster-mouth', '#593348'), body, false, true).scaling.set(1.3, .45, .4);
    if (enemy.boss) {
      const crown = new TransformNode('keeper-crown', scene);
      crown.parent = body;
      crown.position.x = .22;
      crown.rotation.z = -.10;
      cylinder('crown-ring', 1.10, 1.2, .30, 7, 0, 1.97, 0, mat('crown', '#d6b365'), crown, true, false);
      for (let i = 0; i < 7; i++) {
        const a = i / 7 * 6.28;
        const jewel = cylinder('crown-prong', 0, .26, .50, 4, Math.cos(a) * .45, 2.29, Math.sin(a) * .45, mat('crown', '#d6b365'), crown, true, false);
        jewel.rotation.z = Math.cos(a) * -.12;
      }
      rock('crown-jewel', 0, 2.06, -.57, .13, .16, .065, mat('crown-jewel', '#7fd4b4', .4), crown, false, false);
      for (const side of [-1, 1]) {
        const horn = cylinder('keeper-horn', 0, .35, .83, 5, side * 1.08, 1.39, -.05, mat('horn', '#decda5'), body, true, false);
        horn.rotation.z = side * -.65;
      }
      tell = MeshBuilder.CreateTorus('warden-charge-warning', { diameter: 3.1, thickness: .055, tessellation: 32 }, scene);
      tell.position.y = .063;
      finish(tell, mat('charge-warning', '#ff6c20', .5), root, false, false);
      tell.setEnabled(false);
      aim = new TransformNode('warden-aim-warning', scene);
      aim.parent = root;
      const magic = mat('warden-magic-warning', '#f7a569', .8, .45);
      line = box('warden-aim-line', .065, .013, 1, 0, .085, 0, magic, aim, false, false);
      for (let i = 0; i < 3; i++) targets.push(groundMarker('warden-landing-warning', BOSS_BLAST_RADIUS, '#f56013', aim));
      orb = sphere('warden-charged-magic', .34, 0, 1.13, -1.19, mat('warden-magic-core', '#ffd391', 1.1), body);
      chargeAim = new TransformNode('warden-lunge-warning', scene);
      chargeAim.parent = root;
      const chargeLength = BOSS_CHARGE_SPEED * BOSS_CHARGE_DURATION;
      corridor = box('warden-lunge-corridor', 1.66, .012, chargeLength, 0, .066, chargeLength / 2, mat('warden-lunge-area', '#eb5a12', .45, .50), chargeAim, false, false);
      for (const side of [-1, 1]) box('warden-lunge-edge', .045, .012, chargeLength, side * .83, .078, chargeLength / 2, mat('warden-lunge-edge', '#ff6519', .55, .90), chargeAim, false, false);
      const endpoint = groundMarker('warden-lunge-end', .83, '#f56013', chargeAim, .20);
      endpoint.root.position.z = chargeLength;
      for (const z of [.75, 1.5, 2.25]) for (const side of [-1, 1]) {
        const arrow = box('warden-lunge-arrow', .075, .013, .40, side * .135, .094, z - .135, mat('warden-lunge-arrow', '#ffe9ac', 1.2), chargeAim, false, false);
        arrow.rotation.y = -side * Math.PI / 4;
        arrows.push(arrow);
      }
      guard = sphere('warden-charge-guard', 2.65, .18, 1.03, .05, mat('warden-charge-guard', '#ffd186', .9, .16), root, false, true);
      guard.scaling.y = .82;
      aim.setEnabled(false);
      chargeAim.setEnabled(false);
      orb.setEnabled(false);
      guard.setEnabled(false);
    } else {
      const leaf = cylinder('monster-sprout', 0, .20, .34, 5, .10, .94, -.02, mat('sprout', '#266a3c'), body, true, false);
      leaf.rotation.z = -.55;
      const sideLeaf = cylinder('monster-side-leaf', 0, .16, .28, 5, .22, .86, -.02, mat('sprout', '#266a3c'), body, true, false);
      sideLeaf.rotation.z = -1.2;
    }
    return { root, body, eyes, normal, tell, aim, line, targets, orb, chargeAim, corridor, arrows, guard };
  }
  function batchProp(root: TransformNode) {
    const groups = new Map<StandardMaterial, Mesh[]>();
    for (const child of root.getChildMeshes()) {
      if (!(child instanceof Mesh) || !(child.material instanceof StandardMaterial)) continue;
      const group = groups.get(child.material) || [];
      group.push(child);
      groups.set(child.material, group);
    }
    for (const [material, meshes] of groups) {
      if (meshes.length < 2) continue;
      const casterList = shadows.getShadowMap()?.renderList;
      const casts = meshes.some(mesh => casterList?.includes(mesh));
      for (const mesh of meshes) shadows.removeShadowCaster(mesh);
      const merged = Mesh.MergeMeshes(meshes, true, true, undefined, false, false);
      if (!merged) continue;
      merged.material = material;
      merged.parent = root;
      merged.isPickable = false;
      if (casts) shadows.addShadowCaster(merged);
    }
  }
  function makeBreakable(kind: 'grass' | 'pot', id: string) {
    const root = new TransformNode(`breakable-${id}`, scene);
    if (kind === 'grass') {
      for (let i = 0; i < 15; i++) blade((random(i, serial) - .5) * .61, (random(i + 12, serial) - .5) * .54, .65 + random(i + 30, serial) * .28, i * 1.41, mat('cuttable-grass', ['#4c862f', '#6caa3d', '#91bb48'][i % 3]), root, false, true);
      // A few taller folded tips give the clump a lush, bushy crown.
      for (let i = 0; i < 4; i++) blade((i - 1.5) * .12, -.05, .84 + i * .035, i * 1.13, mat('cuttable-grass', '#6caa3d'), root, false, true);
    } else {
      cylinder('pot-foot', .36, .29, .17, 9, 0, .085, 0, mat('clay-dark', '#976044'), root, true, false);
      const belly = sphere('clay-pot', .65, 0, .38, 0, mat('clay', '#b67a53'), root, true);
      belly.scaling.set(.90, .94, .90);
      cylinder('pot-neck', .42, .48, .18, 9, 0, .65, 0, mat('clay', '#b67a53'), root, true, false);
      cylinder('pot-lip', .47, .43, .11, 9, 0, .76, 0, mat('clay-rim', '#cf996b'), root, false, false);
      cylinder('pot-opening', .34, .34, .012, 9, 0, .822, 0, mat('pot-inside', '#684935'), root, false, false);
      cylinder('pot-decoration', .58, .59, .072, 9, 0, .46, 0, mat('clay-band', '#d6ae7a'), root, false, false);
    }
    batchProp(root);
    return root;
  }
  function makePickup(pickup: Pickup) {
    const root = new TransformNode(`pickup-${pickup.id}`, scene);
    if (pickup.kind === 'rupee') {
      const gem = MeshBuilder.CreatePolyhedron(`rupee-gem-${serial++}`, { type: 1, size: .19 }, scene);
      gem.scaling.set(.62, 1.4, .48);
      finish(gem, mat('rupee', '#63c393', .33), root, false, false);
      rock('gem-gleam', -.024, .065, -.079, .037, .13, .019, mat('gem-highlight', '#c1f0bd', .50), root, false, false);
    } else if (pickup.kind === 'heart') {
      const red = mat('heart-pickup', '#d46c73', .17);
      sphere('heart-left', .22, -.08, .06, 0, red, root);
      sphere('heart-right', .22, .08, .06, 0, red, root);
      const point = cylinder('heart-tip', .29, 0, .25, 5, 0, -.10, 0, red, root, false, false);
      point.scaling.z = .7;
    } else {
      const gold = mat('key-gold', '#e5c67a', .40);
      const ring = MeshBuilder.CreateTorus('little-key-ring', { diameter: .38, thickness: .09, tessellation: 10 }, scene);
      ring.position.y = .23;
      ring.rotation.x = Math.PI / 2;
      finish(ring, gold, root, false, false);
      box('key-stem', .083, .39, .078, 0, -.11, 0, gold, root, false, false);
      box('key-tooth', .19, .085, .081, .053, -.23, 0, gold, root, false, false);
      box('key-tooth', .19, .085, .081, .053, -.12, 0, gold, root, false, false);
      for (let i = 0; i < 5; i++) rock('key-sparkle', Math.cos(i * 1.25) * .52, Math.sin(i * 1.25) * .37, 0, .029, .042, .025, mat('key-sparkle', '#e6d594', .6), root, false, false);
    }
    batchProp(root);
    return root;
  }
  function makeProjectile(projectile: Projectile): ProjectileVisual {
    const root = new TransformNode(`projectile-${projectile.id}`, scene);
    const body = new TransformNode('magic-bolt-flight', scene);
    body.parent = root;
    const core = sphere('magic-bolt-core', projectile.radius * 1.4, 0, 0, 0, mat('magic-core', '#ffe3b0', 1.1), body, false, true);
    const shell = sphere('magic-bolt-shell', projectile.radius * 2.35, 0, 0, 0, mat('magic-shell', '#ed9e69', .8, .55), body, false, true);
    shell.scaling.z = 1.15;
    for (let i = 0; i < 3; i++) {
      const trail = sphere('magic-bolt-trail', projectile.radius * (.9 - i * .22), 0, 0, -(i + 1) * .20, mat('magic-trail', '#ffd09a', .7, .48 - i * .10), body, false, true);
      trail.scaling.z = 1.35;
    }
    core.rotation.z = Math.PI / 4;
    const targeted = projectile.flightTime !== undefined && projectile.targetX !== undefined && projectile.targetZ !== undefined;
    const landing = targeted ? groundMarker('magic-bolt-landing', BOSS_BLAST_RADIUS, '#f56013', root, .32) : undefined;
    const shadow = targeted ? cylinder('magic-bolt-shadow', .50, .50, .010, 24, 0, .034, 0, mat('magic-bolt-shadow', '#32291f', 0, .26), root, false, false) : undefined;
    return { root, body, landing, shadow };
  }
  function makeHazard(hazard: Hazard) {
    const marker = groundMarker('burning-ember-area', hazard.radius, '#922607', null, .68, '#ff5e0e');
    const embers: Mesh[] = [];
    for (let i = 0; i < 6; i++) {
      const angle = i / 6 * Math.PI * 2;
      const distance = .30 + random(i, hazard.x) * .48;
      const ember = cylinder('burning-ember-flame', 0, .16, .40, 4, Math.cos(angle) * distance, .26, Math.sin(angle) * distance, mat('burning-ember', i % 2 ? '#f65c0c' : '#ff9213', .45, .95), marker.root, false, false);
      ember.scaling.z = .55;
      ember.rotation.z = (i % 2 ? 1 : -1) * .18;
      embers.push(ember);
    }
    return { ...marker, embers };
  }
  function makeEffect(effect: Effect) {
    const root = new TransformNode(`effect-${effect.id}`, scene);
    const pieces: Mesh[] = [];
    const flare = effect.kind === 'blast' ? groundMarker('ember-impact-flare', BOSS_BLAST_RADIUS, '#ff6813', root, .60) : undefined;
    if (effect.kind === 'swing') {
      // This ribbon is re-shaped every frame so the bright arc really sweeps forward.
      for (let i = 0; i < 3; i++) {
        const ribbon = new Mesh(`sword-sweep-${i}`, scene);
        finish(ribbon, mat(`sword-sweep-${i}`, i === 0 ? '#fff5c0' : '#cce9aa', .7, i === 0 ? .80 : .28), root, false, false);
        pieces.push(ribbon);
      }
    } else {
      const count = effect.kind === 'grass' ? 11 : effect.kind === 'poof' ? 10 : effect.kind === 'sparkle' ? 9 : effect.kind === 'blast' ? 10 : 8;
      const colors = effect.kind === 'grass' ? ['#b1bd66', '#7f9b4f', '#d3ca81'] : effect.kind === 'pot' ? ['#c99467', '#a56946', '#e0b47c'] : effect.kind === 'poof' ? ['#d8d7b5', '#adc3a2', '#ece7c3'] : effect.kind === 'blast' ? ['#ff751b', '#ffc353', '#e33c13'] : ['#ffdfa3', '#ffffd2', '#c5df9b'];
      for (let i = 0; i < count; i++) {
        const size = effect.kind === 'poof' ? .15 + random(i, 2) * .08 : effect.kind === 'blast' ? .08 + random(i, 2) * .05 : .035 + random(i, 2) * .04;
        const piece = rock('effect-particle', 0, .4, 0, size, effect.kind === 'grass' ? size * 2.4 : size, size, mat(`effect-${effect.kind}-${i % 3}`, colors[i % 3], effect.kind === 'blast' ? .55 : effect.kind === 'hit' || effect.kind === 'sparkle' ? .6 : .08), root, false, false);
        piece.metadata = { baseScale: piece.scaling.clone() };
        pieces.push(piece);
      }
    }
    return { root, pieces, kind: effect.kind, flare };
  }
  function updateSweep(mesh: Mesh, start: number, end: number, radius: number, thickness: number, height: number, alpha: number) {
    const positions: number[] = [], indices: number[] = [], normals: number[] = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const a = start + (end - start) * i / steps;
      for (const r of [radius - thickness, radius]) {
        positions.push(Math.sin(a) * r, height + Math.sin(i / steps * Math.PI) * .04, Math.cos(a) * r);
        normals.push(0, 1, 0);
      }
      if (i < steps) { const n = i * 2; indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2); }
    }
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    data.applyToMesh(mesh, true);
    mesh.visibility = Math.max(0, alpha);
  }
  function disposeVisual(root: TransformNode) {
    for (const mesh of root.getChildMeshes()) shadows.removeShadowCaster(mesh);
    root.dispose(false, false);
  }
  function clearDynamic() {
    for (const v of enemyVisuals.values()) disposeVisual(v.root);
    for (const v of breakableVisuals.values()) disposeVisual(v);
    for (const v of pickupVisuals.values()) disposeVisual(v);
    for (const v of projectileVisuals.values()) disposeVisual(v.root);
    for (const v of hazardVisuals.values()) disposeVisual(v.root);
    for (const v of effectVisuals.values()) disposeVisual(v.root);
    enemyVisuals.clear(); breakableVisuals.clear(); pickupVisuals.clear(); projectileVisuals.clear(); hazardVisuals.clear(); effectVisuals.clear();
  }
  let cameraTarget = new Vector3(8, 0, 5);
  function updateActors(state: GameStore, dt: number) {
    if (stateZone !== state.zone) { clearDynamic(); stateZone = state.zone; }
    const moving = Math.min(1, Math.hypot(state.player.vx, state.player.vz) / 4);
    const stride = Math.sin(clock * 16) * moving;
    heroRoot.position.set(state.player.x, 0, state.player.z);
    heroRoot.rotation.y = state.status === 'title' ? Math.PI + .30 : Math.PI / 2 - state.player.facing;
    heroBody.position.y = Math.abs(stride) * .04;
    heroBody.rotation.z = stride * .045;
    leftFoot.position.z = .05 + stride * .12;
    rightFoot.position.z = .05 - stride * .12;
    heroRoot.setEnabled(state.player.invulnerable <= 0 || Math.floor(state.player.invulnerable * 15) % 2 === 0 || state.status === 'title');
    const swing = state.effects.find(effect => effect.kind === 'swing');
    if (swing && state.player.attackTime > 0) {
      const sweep = getSwordSweep(state.player.facing, swing.age / swing.duration);
      swordRoot.position.set(sweep.localGrip.x, .64, sweep.localGrip.z);
      // The blade is authored along +Y. Positive pitch turns it forward to +Z;
      // yaw then makes its tip follow the exact same horizontal arc as the VFX.
      swordRoot.rotation.set(Math.PI / 2, sweep.localAngle, 0);
      rightHand.position.copyFrom(swordRoot.position);
      const shoulder = new Vector3(.30, .82, .025);
      const hand = rightHand.position.subtract(new Vector3(0, heroBody.position.y, 0));
      const armDirection = hand.subtract(shoulder);
      const armLength = armDirection.length();
      rightArm.position.copyFrom(shoulder.add(hand).scale(.5));
      rightArm.scaling.set(.75, armLength / .21, .75);
      armDirection.normalize();
      const axis = Vector3.Cross(Vector3.Up(), armDirection);
      rightArm.rotationQuaternion = Quaternion.RotationAxis(axis.normalize(), Math.acos(Math.max(-1, Math.min(1, armDirection.y))));
    } else {
      swordRoot.position.set(.38, .64, .17);
      swordRoot.rotation.set(.34, 0, -.13);
      rightHand.position.set(.37, .61 + heroBody.position.y, .14);
      rightArm.position.set(.32, .79, .025);
      rightArm.scaling.set(1, 1.4, 1);
      rightArm.rotationQuaternion = null;
      rightArm.rotation.setAll(0);
    }
    const enemiesNow = new Set<string>();
    for (const enemy of state.enemies) {
      enemiesNow.add(enemy.id);
      let visual = enemyVisuals.get(enemy.id);
      if (!visual) { visual = makeEnemy(enemy); enemyVisuals.set(enemy.id, visual); }
      visual.root.setEnabled(enemy.alive);
      if (!enemy.alive) continue;
      visual.root.position.set(enemy.x, 0, enemy.z);
      const speed = Math.hypot(enemy.vx, enemy.vz);
      const hop = Math.sin(clock * (enemy.boss ? 7.6 : 8.8) + random(enemy.homeX, enemy.homeZ) * 8);
      visual.body.position.y = Math.max(0, hop) * Math.min(.11, speed * .022);
      const shooting = enemy.attackMode === 'telegraph' || enemy.attackMode === 'fire';
      const charging = enemy.attackMode === 'chargeTelegraph';
      const lunging = enemy.boss && enemy.attackMode === 'charge';
      const squish = Math.sin(clock * (shooting ? 20 : 7) + random(enemy.homeX, enemy.homeZ) * 6);
      visual.body.scaling.set(1 - squish * .034, 1 + squish * .052, 1 + squish * .016);
      visual.body.rotation.z = Math.sin(clock * 5.6 + random(enemy.homeX, enemy.homeZ) * 8) * .025;
      visual.body.material = enemy.flash > 0 ? flashMat : shooting
        ? mat('warden-spell-windup', '#dd728d', .23)
        : lunging ? mat('warden-charge-immune', '#ffbe6e', .8)
        : charging ? mat('warden-charge-windup', '#e69762', .32)
        : enemy.boss && enemy.phase === 2 ? mat('warden-enraged', '#c13f78', .06) : visual.normal;
      visual.root.rotation.y = getEnemyYaw(enemy);
      if (visual.tell) {
        visual.tell.setEnabled(charging || lunging);
        const warningScale = 1 + Math.sin(clock * 19) * .055;
        visual.tell.scaling.set(warningScale, 1, warningScale);
        visual.tell.visibility = .65 + Math.sin(clock * 19) * .25;
      }
      if (visual.guard) {
        visual.guard.setEnabled(lunging);
        visual.guard.visibility = .65 + Math.sin(clock * 30) * .2;
      }
      if (visual.chargeAim && visual.corridor) {
        visual.chargeAim.setEnabled(charging);
        if (charging) {
          const dx = enemy.aimX - enemy.x, dz = enemy.aimZ - enemy.z;
          visual.chargeAim.rotation.y = Math.atan2(dx, dz) - visual.root.rotation.y;
          const progress = 1 - Math.min(1, enemy.attackTimer / BOSS_CHARGE_TELEGRAPH);
          visual.corridor.visibility = .65 + progress * .35;
          for (const arrow of visual.arrows ?? []) arrow.visibility = .65 + Math.sin(clock * 18 - arrow.position.z * 2) * .30;
        }
      }
      if (visual.aim && visual.line && visual.orb) {
        visual.aim.setEnabled(enemy.attackMode === 'telegraph');
        visual.orb.setEnabled(shooting);
        if (shooting) {
          const dx = enemy.aimX - enemy.x, dz = enemy.aimZ - enemy.z;
          const distance = Math.hypot(dx, dz);
          visual.aim.rotation.y = Math.atan2(dx, dz) - visual.root.rotation.y;
          visual.line.scaling.z = distance;
          visual.line.position.z = distance / 2;
          const charge = 1 - Math.min(1, enemy.attackTimer / BOSS_TELEGRAPH);
          visual.orb.scaling.setAll(.65 + charge * .70);
          visual.line.visibility = .18 + charge * .14;
          for (const [i, marker] of (visual.targets ?? []).entries()) {
            marker.root.setEnabled(i === 1 || enemy.phase === 2);
            marker.root.position.set((i - 1) * BOSS_BLAST_SPREAD, 0, distance);
            marker.fill.visibility = .45 + charge * .4;
            marker.ring.visibility = .7 + Math.sin(clock * 17) * .2;
          }
        }
      }
    }
    for (const [id, visual] of enemyVisuals) if (!enemiesNow.has(id)) { disposeVisual(visual.root); enemyVisuals.delete(id); }
    const projectilesNow = new Set<string>();
    for (const projectile of state.projectiles) {
      projectilesNow.add(projectile.id);
      let visual = projectileVisuals.get(projectile.id);
      if (!visual) { visual = makeProjectile(projectile); projectileVisuals.set(projectile.id, visual); }
      const targeted = projectile.flightTime !== undefined && projectile.flightTime > 0 && projectile.startX !== undefined && projectile.startZ !== undefined && projectile.targetX !== undefined && projectile.targetZ !== undefined;
      const progress = targeted ? Math.min(1, Math.max(0, projectile.age / projectile.flightTime!)) : 0;
      const x = targeted ? projectile.startX! + (projectile.targetX! - projectile.startX!) * progress : projectile.x;
      const z = targeted ? projectile.startZ! + (projectile.targetZ! - projectile.startZ!) * progress : projectile.z;
      visual.root.position.set(x, 0, z);
      visual.body.position.y = targeted ? .25 + .9 * (1 - progress) + Math.sin(progress * Math.PI) * 1.8 : .59 + Math.sin(projectile.age * 13) * .035;
      visual.body.rotation.y = Math.atan2(projectile.vx, projectile.vz);
      visual.body.scaling.setAll(1 + Math.sin(projectile.age * 18) * .035);
      if (visual.landing && projectile.targetX !== undefined && projectile.targetZ !== undefined) {
        visual.landing.root.position.set(projectile.targetX - x, 0, projectile.targetZ - z);
        visual.landing.fill.visibility = .4 + progress * .5;
        visual.landing.ring.visibility = .7 + Math.sin(clock * 19) * .2;
      }
      if (visual.shadow) visual.shadow.visibility = .6 + progress * .3;
    }
    for (const [id, visual] of projectileVisuals) if (!projectilesNow.has(id)) { disposeVisual(visual.root); projectileVisuals.delete(id); }
    const hazardsNow = new Set<string>();
    for (const hazard of state.hazards ?? []) {
      hazardsNow.add(hazard.id);
      let visual = hazardVisuals.get(hazard.id);
      if (!visual) { visual = makeHazard(hazard); hazardVisuals.set(hazard.id, visual); }
      visual.root.position.set(hazard.x, 0, hazard.z);
      visual.root.scaling.set(hazard.radius, 1, hazard.radius);
      const remaining = Math.min(1, Math.max(0, (hazard.duration - hazard.age) / .25));
      visual.fill.visibility = remaining * (.75 + Math.sin(clock * 16) * .15);
      visual.ring.visibility = remaining * (.8 + Math.sin(clock * 19) * .15);
      for (let i = 0; i < visual.embers.length; i++) {
        const ember = visual.embers[i];
        const flicker = Math.sin(clock * 14 + i * 1.8);
        ember.position.y = .24 + Math.max(0, flicker) * .06;
        ember.scaling.y = .9 + flicker * .25;
        ember.visibility = remaining;
        ember.rotation.y = clock * 2 + i;
      }
    }
    for (const [id, visual] of hazardVisuals) if (!hazardsNow.has(id)) { disposeVisual(visual.root); hazardVisuals.delete(id); }
    const breakablesNow = new Set<string>();
    for (const b of state.breakables) {
      breakablesNow.add(b.id);
      let visual = breakableVisuals.get(b.id);
      if (!visual) { visual = makeBreakable(b.kind, b.id); breakableVisuals.set(b.id, visual); }
      visual.setEnabled(b.alive);
      visual.position.set(b.x, 0, b.z);
      if (b.kind === 'grass') visual.rotation.y = Math.sin(clock * 1.3 + b.x) * .04;
    }
    for (const [id, visual] of breakableVisuals) if (!breakablesNow.has(id)) { disposeVisual(visual); breakableVisuals.delete(id); }
    const pickupsNow = new Set<string>();
    for (const pickup of state.pickups) {
      pickupsNow.add(pickup.id);
      let visual = pickupVisuals.get(pickup.id);
      if (!visual) { visual = makePickup(pickup); pickupVisuals.set(pickup.id, visual); }
      const y = pickup.kind === 'key' ? 1.31 : .55;
      visual.position.set(pickup.x, y + Math.sin(clock * 3.5 + random(pickup.x, pickup.z) * 4) * .09, pickup.z);
      visual.rotation.y = clock * (pickup.kind === 'key' ? .85 : 1.8);
    }
    for (const [id, visual] of pickupVisuals) if (!pickupsNow.has(id)) { disposeVisual(visual); pickupVisuals.delete(id); }
    const effectsNow = new Set<string>();
    for (const effect of state.effects) {
      effectsNow.add(effect.id);
      let visual = effectVisuals.get(effect.id);
      if (!visual) { visual = makeEffect(effect); effectVisuals.set(effect.id, visual); }
      const progress = Math.min(1, effect.age / Math.max(.01, effect.duration));
      visual.root.position.set(effect.x, 0, effect.z);
      if (effect.kind === 'swing') {
        const sweep = getSwordSweep(state.player.facing, progress);
        const head = sweep.angle;
        for (let i = 0; i < visual.pieces.length; i++) updateSweep(visual.pieces[i], head - .75 - i * .12, head, 1.18 + i * .07, .11 + i * .045, .64 + i * .012, Math.sin(progress * Math.PI) * (1 - i * .20));
        visual.root.position.x = state.player.x + Math.cos(state.player.facing) * sweep.advance;
        visual.root.position.z = state.player.z + Math.sin(state.player.facing) * sweep.advance;
      } else {
        if (visual.flare) {
          const radius = BOSS_BLAST_RADIUS * (.18 + progress * .82);
          visual.flare.root.scaling.set(radius, 1, radius);
          visual.flare.fill.visibility = Math.max(0, 1 - progress * 3);
          visual.flare.ring.visibility = 1 - progress;
        }
        for (let i = 0; i < visual.pieces.length; i++) {
          const piece = visual.pieces[i];
          const a = i / visual.pieces.length * 6.28 + effect.angle;
          const distance = progress * (effect.kind === 'poof' ? .7 : effect.kind === 'blast' ? .65 + random(i, 8) * .55 : .9 + random(i, 8) * .65);
          piece.position.set(Math.cos(a) * distance, (effect.kind === 'blast' ? .15 : .28) + Math.sin(progress * Math.PI) * (.4 + random(i, 7) * .6), Math.sin(a) * distance);
          piece.visibility = 1 - progress;
          const scale = effect.kind === 'poof' ? 1 + progress * .9 : 1 - progress * .35;
          const base = piece.metadata.baseScale as Vector3;
          piece.scaling.copyFrom(base).scaleInPlace(scale);
          piece.rotation.x += dt * (i % 2 ? 5 : -4);
          piece.rotation.z += dt * (i % 2 ? 3 : -5);
        }
      }
    }
    for (const [id, visual] of effectVisuals) if (!effectsNow.has(id)) { disposeVisual(visual.root); effectVisuals.delete(id); }
    if (gate) gate.position.y += ((state.quest.gate ? -3.3 : 0) - gate.position.y) * Math.min(1, dt * 5.5);
    if (chestLid) chestLid.rotation.x += ((state.quest.treasure ? 1.25 : 0) - chestLid.rotation.x) * Math.min(1, dt * 4);
  }

  function updateProjection() {
    const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
    camera.orthoTop = viewHeight / 2;
    camera.orthoBottom = -viewHeight / 2;
    camera.orthoLeft = -viewHeight * aspect / 2;
    camera.orthoRight = viewHeight * aspect / 2;
  }
  function resize() {
    engine.resize();
    updateProjection();
  }
  function render(dt: number) {
    if (scene.isDisposed) return;
    clock += dt;
    const state = useGameStore.getState();
    const zoneChanged = state.zone !== activeZone;
    if (zoneChanged || state.tileOverrides[state.zone] !== activeTileOverrides) {
      const gateHeight = gate?.position.y;
      const chestAngle = chestLid?.rotation.x;
      buildZone(state.zone, state.tileOverrides);
      if (zoneChanged) cameraTarget.set(state.player.x, 0, state.player.z);
      else {
        // A tile edit should continue the gate and chest's current animation.
        if (gate && gateHeight !== undefined) gate.position.y = gateHeight;
        if (chestLid && chestAngle !== undefined) chestLid.rotation.x = chestAngle;
      }
    }
    updateActors(state, dt);
    const isTitle = state.status === 'title';
    titleCameraBlend += ((isTitle ? 1 : 0) - titleCameraBlend) * Math.min(1, dt * 2.6);
    const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
    // Keep a useful horizontal view on phones without shrinking touch combat to tiny figures.
    const desiredHeight = aspect < .8 ? Math.min(25, 13 / Math.max(.45, aspect)) : touchDevice ? 17 : 18;
    viewHeight = desiredHeight + titleCameraBlend * (aspect > 1.3 ? 4 : 1);
    // Looking from negative Z makes positive X screen-right and positive Z screen-up.
    const titleX = aspect > 1.2 ? 1.5 : aspect > .70 ? 3.6 : 8;
    const titleZ = 7.8;
    const x = state.player.x * (1 - titleCameraBlend) + titleX * titleCameraBlend;
    const z = state.player.z * (1 - titleCameraBlend) + titleZ * titleCameraBlend;
    const follow = Math.min(1, dt * 6.4);
    cameraTarget.x += (x - cameraTarget.x) * follow;
    cameraTarget.z += (z - cameraTarget.z) * follow;
    const shake = state.status === 'playing' ? state.shake * .13 : 0;
    const sx = Math.sin(clock * 87) * shake, sz = Math.cos(clock * 73) * shake;
    camera.position.set(cameraTarget.x + sx, 25, cameraTarget.z - 20 + sz);
    camera.setTarget(new Vector3(cameraTarget.x + sx, 0, cameraTarget.z + sz));
    sun.position.set(cameraTarget.x + 17, 35, cameraTarget.z - 14);
    updateProjection();
    for (let i = 0; i < flames.length; i++) {
      const flame = flames[i];
      flame.scaling.y = .32 + Math.sin(clock * 12 + i * 2) * .033;
      flame.scaling.x = .14 + Math.sin(clock * 8 + i) * .014;
      flame.rotation.y = clock * .8 + i;
    }
    for (let i = 0; i < torchLights.length; i++) torchLights[i].intensity = 1.8 + Math.sin(clock * 10 + i * 1.6) * .13;
    for (let i = 0; i < waterRipples.length; i++) {
      waterRipples[i].position.x += Math.sin(clock * .6 + i) * dt * .028;
      waterRipples[i].visibility = .35 + (Math.sin(clock * 1.2 + i) + 1) * .22;
    }
    for (const float of decorFloat) {
      float.mesh.position.y = float.y + Math.sin(clock * float.speed + float.phase) * .13;
      float.mesh.position.x += Math.cos(clock * .7 + float.phase) * dt * .022;
    }
    scene.render();
    // Freeze after initial compilation, and thaw when the zone changes its active lights.
    for (const material of frozenMaterials) if (!material.isFrozen) material.freeze();
  }
  // A first frame prevents a blank canvas while React mounts its keyboard handlers.
  resize();
  render(1 / 60);
  const getStatistics = (): RenderStatistics | null => scene.isDisposed ? null : ({
    drawCalls: instrumentation.drawCallsCounter.current,
    activeMeshes: scene.getActiveMeshes().length,
    triangles: Math.round(scene.getActiveIndices() / 3),
  });
  return { render, resize, getStatistics, dispose: () => { clearDynamic(); instrumentation.dispose(); scene.dispose(); engine.dispose(); materials.clear(); } };
}
