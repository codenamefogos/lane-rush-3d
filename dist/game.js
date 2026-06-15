/* =========================================================================
   LANE RUSH 3D — Endless Traffic Dodger
   Built with Three.js (the same WebGL pipeline Unity WebGL exports target).
   Architecture mirrors a Unity project:
     - GameManager   -> orchestrates state machine (Menu/Play/Pause/GameOver)
     - PlayerCar     -> lane movement, jump, duck, collision box
     - WorldManager  -> infinite road tiling, spawns traffic/coins/obstacles
     - InputManager  -> keyboard + touch swipe + on-screen buttons
     - AudioManager  -> simple WebAudio SFX (no external files needed)
   ========================================================================= */

(() => {
  'use strict';

  // ---------------------------------------------------------------------
  // CONFIG  (tune gameplay here — mirrors Unity ScriptableObject "balance")
  // ---------------------------------------------------------------------
  const CONFIG = {
    laneCount: 3,
    laneWidth: 3.2,
    baseForwardSpeed: 16,      // units/sec
    maxForwardSpeed: 44,
    speedRampPerSec: 0.085,    // how fast speed ramps with time
    laneChangeSpeed: 14,       // lateral lerp speed
    jumpForce: 13,
    gravity: -34,
    duckDuration: 0.55,
    duckScaleY: 0.42,
    spawnZDistance: 110,       // where new chunks spawn ahead
    despawnZDistance: 16,      // behind player, cleanup
    chunkLength: 22,
    coinSpawnChance: 0.55,
    obstacleSpawnChance: 0.85,
    trafficSpawnChance: 0.7,
    invulnAfterHitMs: 900,
    cameraFollowLag: 6,
  };

  const LANE_X = [];
  for (let i = 0; i < CONFIG.laneCount; i++) {
    const offset = (i - (CONFIG.laneCount - 1) / 2) * CONFIG.laneWidth;
    LANE_X.push(offset);
  }

  const CAR_SKINS = [
    { id: 'inferno',  name: 'Inferno',   price: 0,    body: 0xFF5A36, accent: 0x1B2740, glow: 0xFFD56B },
    { id: 'cyber',    name: 'Cyber',     price: 250,  body: 0x39F2C8, accent: 0x0B1020, glow: 0x39F2C8 },
    { id: 'violet',   name: 'Violet',    price: 500,  body: 0x9B5CFF, accent: 0x1B1230, glow: 0xC9A6FF },
    { id: 'gold',     name: 'Gold Rush', price: 1200, body: 0xFFD56B, accent: 0x4A3A12, glow: 0xFFEFAF },
    { id: 'mono',     name: 'Mono',      price: 750,  body: 0xEAF2FF, accent: 0x222222, glow: 0x9FB7FF },
    { id: 'crimson',  name: 'Crimson',   price: 900,  body: 0xC4123C, accent: 0x100308, glow: 0xFF6B8B },
  ];

  // ---------------------------------------------------------------------
  // SAVE DATA
  // ---------------------------------------------------------------------
  const Save = {
    KEY: 'lanerush3d_save_v1',
    data: { best: 0, coins: 0, unlocked: ['inferno'], selected: 'inferno' },
    load() {
      try {
        const raw = localStorage.getItem(this.KEY);
        if (raw) this.data = Object.assign(this.data, JSON.parse(raw));
      } catch (e) { /* private mode etc — ignore */ }
    },
    persist() {
      try { localStorage.setItem(this.KEY, JSON.stringify(this.data)); } catch (e) {}
    }
  };
  Save.load();

  // ---------------------------------------------------------------------
  // AUDIO MANAGER — tiny synthesized SFX via WebAudio (no asset files)
  // ---------------------------------------------------------------------
  const Audio3D = {
    ctx: null,
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(freq, dur, type = 'sine', vol = 0.18, slideTo = null) {
      if (!this.ctx) return;
      const t0 = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur);
    },
    coin()  { this.tone(880, 0.09, 'square', 0.14, 1500); this.tone(1320,0.12,'square',0.08,1760); },
    jump()  { this.tone(260, 0.18, 'sawtooth', 0.12, 520); },
    land()  { this.tone(140, 0.1, 'triangle', 0.12, 90); },
    crash() {
      this.tone(120, 0.35, 'sawtooth', 0.22, 40);
      this.tone(60, 0.4, 'square', 0.18, 30);
    },
    click() { this.tone(520, 0.05, 'square', 0.08, 700); },
    swoosh(){ this.tone(360, 0.12, 'sine', 0.06, 180); }
  };

  // ---------------------------------------------------------------------
  // THREE.JS SETUP
  // ---------------------------------------------------------------------
  const canvas = document.getElementById('game-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0B1020);
  scene.fog = new THREE.Fog(0x0B1020, 60, 150);

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(0, 6.4, -9.2);
  camera.lookAt(0, 1.2, 8);

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ---- Lighting ----
  const hemi = new THREE.HemisphereLight(0x8FB7FF, 0x10131F, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffffff, 1.15);
  sun.position.set(-14, 26, -18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  sun.shadow.camera.left = -30;
  sun.shadow.camera.right = 30;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  scene.add(sun);

  const rim = new THREE.PointLight(0x39F2C8, 0.6, 40);
  rim.position.set(0, 5, -6);
  scene.add(rim);

  // -------------------------------------------------------------------
  // GEOMETRY FACTORIES  (low-poly style — fast, mobile-friendly)
  // -------------------------------------------------------------------
  function buildCarMesh(skin) {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: skin.body, roughness: 0.35, metalness: 0.45 });
    const accentMat = new THREE.MeshStandardMaterial({ color: skin.accent, roughness: 0.5, metalness: 0.2 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.1, metalness: 0.8, transparent: true, opacity: 0.85 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0B0B0F, roughness: 0.8 });
    const lightMat = new THREE.MeshStandardMaterial({ color: skin.glow, emissive: skin.glow, emissiveIntensity: 1.4, roughness: 0.3 });

    // Lower body
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.55, 3.6), bodyMat);
    base.position.y = 0.55;
    base.castShadow = true; base.receiveShadow = true;
    group.add(base);

    // Cabin
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 1.9), accentMat);
    cabin.position.set(0, 1.05, -0.2);
    cabin.castShadow = true;
    group.add(cabin);

    // Windshield
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.5, 1.0), glassMat);
    windshield.position.set(0, 1.05, 0.85);
    windshield.rotation.x = -0.18;
    group.add(windshield);

    // Hood slope
    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.18, 1.1), bodyMat);
    hood.position.set(0, 0.85, 1.55);
    hood.rotation.x = 0.12;
    hood.castShadow = true;
    group.add(hood);

    // Spoiler
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.35), accentMat);
    spoiler.position.set(0, 1.15, -1.7);
    group.add(spoiler);
    const spoilerL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.35, 0.35), accentMat);
    spoilerL.position.set(-0.75, 0.95, -1.7);
    group.add(spoilerL);
    const spoilerR = spoilerL.clone();
    spoilerR.position.x = 0.75;
    group.add(spoilerR);

    // Wheels
    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.38, 16);
    const wheelPositions = [
      [-1.0, 0.42, 1.15], [1.0, 0.42, 1.15],
      [-1.0, 0.42, -1.15], [1.0, 0.42, -1.15]
    ];
    wheelPositions.forEach(([x, y, z]) => {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, y, z);
      wheel.castShadow = true;
      wheel.name = 'wheel';
      group.add(wheel);
    });

    // Headlights
    [-0.7, 0.7].forEach(x => {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.08), lightMat);
      hl.position.set(x, 0.62, 1.82);
      group.add(hl);
    });
    // Taillights
    [-0.7, 0.7].forEach(x => {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.06), new THREE.MeshStandardMaterial({ color: 0xFF3344, emissive: 0xFF3344, emissiveIntensity: 1.2 }));
      tl.position.set(x, 0.62, -1.82);
      group.add(tl);
    });

    group.userData.wheels = group.children.filter(c => c.name === 'wheel');
    return group;
  }

  // Traffic vehicle (boxier, varied colors)
  const TRAFFIC_COLORS = [0x5B7BD6, 0xE0E0E0, 0xF2B033, 0x6FBF73, 0xA56BFF, 0xFF8FA3, 0x4DB6AC];
  function buildTrafficMesh() {
    const color = TRAFFIC_COLORS[Math.floor(Math.random() * TRAFFIC_COLORS.length)];
    const isTruck = Math.random() < 0.3;
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.25 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x111722, roughness: 0.15, metalness: 0.6 });

    if (isTruck) {
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.5, 1.6), bodyMat);
      cab.position.set(0, 1.0, 1.6);
      cab.castShadow = true;
      group.add(cab);
      const cabGlass = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.6, 0.1), glassMat);
      cabGlass.position.set(0, 1.35, 2.4);
      group.add(cabGlass);
      const trailer = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.9, 3.6), new THREE.MeshStandardMaterial({ color: 0xDDE3F0, roughness: 0.6 }));
      trailer.position.set(0, 1.2, -1.1);
      trailer.castShadow = true;
      group.add(trailer);
      group.userData.length = 5.6;
      group.userData.width = 2.1;
    } else {
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.85, 3.7), bodyMat);
      body.position.y = 0.65;
      body.castShadow = true;
      group.add(body);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.62, 1.9), bodyMat.clone());
      cabin.material.color.multiplyScalar(0.85);
      cabin.position.set(0, 1.18, -0.1);
      cabin.castShadow = true;
      group.add(cabin);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.7), glassMat);
      glass.position.set(0, 1.2, -0.1);
      group.add(glass);
      group.userData.length = 3.7;
      group.userData.width = 1.95;
    }

    const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.4, 14);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0B0B0F, roughness: 0.8 });
    const len = group.userData.length;
    const wPositions = [
      [-1.05, 0.46, len/2 - 0.7], [1.05, 0.46, len/2 - 0.7],
      [-1.05, 0.46, -len/2 + 0.7], [1.05, 0.46, -len/2 + 0.7]
    ];
    wPositions.forEach(([x,y,z]) => {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.rotation.z = Math.PI/2;
      w.position.set(x,y,z);
      w.castShadow = true;
      group.add(w);
    });

    // Taillights facing player (player approaches from -z direction... but here traffic moves toward player along +z is "ahead", lights face +z)
    [-0.65, 0.65].forEach(x => {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3,0.18,0.06), new THREE.MeshStandardMaterial({ color:0xFF3344, emissive:0xFF3344, emissiveIntensity:1.0 }));
      tl.position.set(x, 0.7, len/2 - 0.05);
      group.add(tl);
    });

    return group;
  }

  // Static obstacle (barrier/cone)
  function buildObstacleMesh(type) {
    const group = new THREE.Group();
    if (type === 'cone') {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.1, 10), new THREE.MeshStandardMaterial({ color: 0xFF6A2E, roughness:0.6 }));
      cone.position.y = 0.55;
      cone.castShadow = true;
      group.add(cone);
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.34,0.34,0.16,10), new THREE.MeshStandardMaterial({ color: 0xF4F4F4 }));
      stripe.position.y = 0.7;
      group.add(stripe);
      group.userData.width = 0.9; group.userData.height = 1.1; group.userData.jumpable = true;
    } else if (type === 'barrier') {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.0, 0.5), new THREE.MeshStandardMaterial({ color: 0xE5E5E5, roughness:0.5 }));
      bar.position.y = 0.5;
      bar.castShadow = true;
      group.add(bar);
      for (let i=-1;i<=1;i+=2) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.05, 0.55), new THREE.MeshStandardMaterial({ color: 0xFF3B30 }));
        stripe.position.set(i*0.85, 0.5, 0);
        group.add(stripe);
      }
      group.userData.width = 2.6; group.userData.height = 1.0; group.userData.jumpable = false;
    } else { // ramp - duck under (low overhead sign / bar)
      const postMat = new THREE.MeshStandardMaterial({ color: 0x445166, roughness:0.6 });
      const postL = new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.12,2.6,8), postMat);
      postL.position.set(-1.3, 1.3, 0);
      const postR = postL.clone(); postR.position.x = 1.3;
      const beam = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.35, 0.35), new THREE.MeshStandardMaterial({ color: 0xFFD56B, roughness:0.4, emissive:0x553300, emissiveIntensity:0.3 }));
      beam.position.set(0, 1.85, 0);
      group.add(postL, postR, beam);
      group.children.forEach(c => c.castShadow = true);
      group.userData.width = 2.9; group.userData.height = 1.85; group.userData.duckUnder = true; group.userData.beamBottom = 1.65;
    }
    return group;
  }

  // Coin
  const coinGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.12, 16);
  const coinMat = new THREE.MeshStandardMaterial({ color: 0xFFD56B, emissive: 0xFFB347, emissiveIntensity: 0.5, roughness: 0.25, metalness: 0.7 });
  function buildCoinMesh() {
    const m = new THREE.Mesh(coinGeo, coinMat);
    m.rotation.x = Math.PI / 2;
    m.castShadow = true;
    return m;
  }

  // -------------------------------------------------------------------
  // ROAD / WORLD
  // -------------------------------------------------------------------
  const roadWidth = CONFIG.laneWidth * CONFIG.laneCount + 1.6;
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x2A3142, roughness: 0.95 });
  const sideMat = new THREE.MeshStandardMaterial({ color: 0x232A38, roughness: 1 });
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xF4D35E, emissive: 0xF4D35E, emissiveIntensity: 0.35, roughness: 0.5 });

  const roadChunks = [];
  const decorChunks = [];

  function createRoadChunk(zStart) {
    const group = new THREE.Group();
    const road = new THREE.Mesh(new THREE.BoxGeometry(roadWidth, 0.4, CONFIG.chunkLength), roadMat);
    road.position.set(0, -0.2, 0);
    road.receiveShadow = true;
    group.add(road);

    // lane dividers
    for (let i = 1; i < CONFIG.laneCount; i++) {
      const x = (i - CONFIG.laneCount/2) * CONFIG.laneWidth;
      for (let z = -CONFIG.chunkLength/2 + 1; z < CONFIG.chunkLength/2; z += 4) {
        const dash = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.02, 1.6), lineMat);
        dash.position.set(x, 0.01, z);
        group.add(dash);
      }
    }

    // sidewalks
    [-1, 1].forEach(side => {
      const walk = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.55, CONFIG.chunkLength), sideMat);
      walk.position.set(side * (roadWidth/2 + 1.2), -0.075, 0);
      walk.receiveShadow = true;
      walk.castShadow = true;
      group.add(walk);

      // street lights every chunk
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x394256, roughness:0.5, metalness:0.3 });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.08,4.2,8), poleMat);
      pole.position.set(side*(roadWidth/2 + 2.0), 1.9, side * 4);
      pole.castShadow = true;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.25,8,8), new THREE.MeshStandardMaterial({ color:0xFFF3C4, emissive:0xFFF3C4, emissiveIntensity:0.9 }));
      lamp.position.set(side*(roadWidth/2 + 2.0), 4.0, side * 4);
      group.add(pole, lamp);

      // background buildings (cheap parallax blocks)
      for (let i=0;i<2;i++) {
        const h = 6 + Math.random()*14;
        const bld = new THREE.Mesh(new THREE.BoxGeometry(4+Math.random()*3, h, 4+Math.random()*3),
          new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.62, 0.25, 0.18 + Math.random()*0.12), roughness:1 }));
        bld.position.set(side*(roadWidth/2 + 8 + Math.random()*6), h/2 - 0.3, (Math.random()-0.5)*CONFIG.chunkLength*1.4);
        decorMeshes.push(bld);
        group.add(bld);
        // window glow strips
        const win = new THREE.Mesh(new THREE.BoxGeometry(bld.geometry.parameters.width*0.96, h*0.85, 0.1),
          new THREE.MeshStandardMaterial({ color:0x4FE0FF, emissive:0x4FE0FF, emissiveIntensity:0.12, transparent:true, opacity:0.18 }));
        win.position.set(0,0, bld.geometry.parameters.depth/2 + 0.06);
        bld.add(win);
      }
    });

    group.position.z = zStart;
    scene.add(group);
    return group;
  }

  const decorMeshes = [];

  // Pre-build a pool of chunks
  const CHUNKS_AHEAD = Math.ceil(CONFIG.spawnZDistance / CONFIG.chunkLength) + 2;
  let furthestChunkZ = 0;
  for (let i = -1; i < CHUNKS_AHEAD; i++) {
    const z = i * CONFIG.chunkLength;
    roadChunks.push(createRoadChunk(z));
    furthestChunkZ = z;
  }

  // -------------------------------------------------------------------
  // ENTITY POOLS
  // -------------------------------------------------------------------
  const activeTraffic = [];   // {mesh, lane, z, speed}
  const activeObstacles = []; // {mesh, lane, z, type}
  const activeCoins = [];     // {mesh, lane, z, collected}
  let lastSpawnZ = CONFIG.chunkLength;
  let worldShift = 0; // cumulative distance the world has shifted toward the player (camera-relative space)

  function laneOccupiedRecently(lane, z, list, minGap) {
    return list.some(e => e.lane === lane && Math.abs(e.z - z) < minGap);
  }

  function spawnChunkContent(zStart) {
    // For each "slot" along this chunk, randomly decide spawns per lane
    const slots = 3;
    for (let s = 0; s < slots; s++) {
      const z = zStart + (s + 0.5) * (CONFIG.chunkLength / slots);

      for (let lane = 0; lane < CONFIG.laneCount; lane++) {
        const r = Math.random();

        if (r < CONFIG.trafficSpawnChance * 0.33 && !laneOccupiedRecently(lane, z, activeTraffic, 14) && !laneOccupiedRecently(lane, z, activeObstacles, 8)) {
          const mesh = buildTrafficMesh();
          mesh.position.set(LANE_X[lane], 0, z);
          scene.add(mesh);
          activeTraffic.push({ mesh, lane, z, length: mesh.userData.length, width: mesh.userData.width, speed: 4 + Math.random()*5 });
          continue;
        }

        if (r < CONFIG.obstacleSpawnChance * 0.22 && !laneOccupiedRecently(lane, z, activeObstacles, 10) && !laneOccupiedRecently(lane, z, activeTraffic, 8)) {
          const types = ['cone','barrier','overhead'];
          const type = types[Math.floor(Math.random()*types.length)];
          const mesh = buildObstacleMesh(type);
          mesh.position.set(LANE_X[lane], 0, z);
          scene.add(mesh);
          activeObstacles.push({ mesh, lane, z, type, ud: mesh.userData });
          continue;
        }

        if (Math.random() < CONFIG.coinSpawnChance * 0.5) {
          // coin trail (3-5 coins)
          const trailLen = 3 + Math.floor(Math.random()*3);
          for (let c=0;c<trailLen;c++) {
            const cz = z + c*1.6 - trailLen*0.8;
            if (laneOccupiedRecently(lane, cz, activeObstacles, 3) || laneOccupiedRecently(lane, cz, activeTraffic, 3)) continue;
            const mesh = buildCoinMesh();
            mesh.position.set(LANE_X[lane], 1.0, cz);
            scene.add(mesh);
            activeCoins.push({ mesh, lane, z: cz, collected:false });
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // PLAYER CAR
  // -------------------------------------------------------------------
  let playerCar = buildCarMesh(CAR_SKINS.find(s => s.id === Save.data.selected) || CAR_SKINS[0]);
  scene.add(playerCar);

  const player = {
    lane: 1,                 // index into LANE_X
    x: LANE_X[1],
    y: 0,
    z: 0,
    velY: 0,
    grounded: true,
    ducking: false,
    duckTimer: 0,
    invuln: 0,
    width: 1.7,
    length: 3.4,
    baseScaleY: 1,
  };
  playerCar.position.set(player.x, player.y, player.z);

  // -------------------------------------------------------------------
  // INPUT MANAGER
  // -------------------------------------------------------------------
  const Input = {
    left: false, right: false, jumpQueued: false, duckHeld: false,
    touchStartX: 0, touchStartY: 0, touchActive: false,
  };

  function queueLaneChange(dir) {
    if (state.mode !== 'play') return;
    const newLane = player.lane + dir;
    if (newLane < 0 || newLane >= CONFIG.laneCount) return;
    player.lane = newLane;
    Audio3D.ensure(); Audio3D.swoosh();
    flashBtn(dir < 0 ? leftBtn : rightBtn);
  }
  function queueJump() {
    if (state.mode !== 'play') return;
    if (player.grounded && !player.ducking) {
      player.velY = CONFIG.jumpForce;
      player.grounded = false;
      Audio3D.ensure(); Audio3D.jump();
      flashBtn(jumpBtn);
    }
  }
  function queueDuck(down) {
    if (state.mode !== 'play') return;
    if (down && player.grounded) {
      player.ducking = true;
      player.duckTimer = CONFIG.duckDuration;
      flashBtn(duckBtn);
    }
  }

  function flashBtn(el) {
    if (!el) return;
    el.classList.add('active');
    setTimeout(() => el.classList.remove('active'), 140);
  }

  window.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'ArrowLeft': case 'KeyA': queueLaneChange(-1); break;
      case 'ArrowRight': case 'KeyD': queueLaneChange(1); break;
      case 'ArrowUp': case 'KeyW': case 'Space': queueJump(); break;
      case 'ArrowDown': case 'KeyS': queueDuck(true); break;
      case 'Escape': togglePause(); break;
    }
  });

  // Touch swipe on canvas
  canvas.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    Input.touchStartX = t.clientX; Input.touchStartY = t.clientY; Input.touchActive = true;
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!Input.touchActive) return;
    Input.touchActive = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - Input.touchStartX;
    const dy = t.clientY - Input.touchStartY;
    const absX = Math.abs(dx), absY = Math.abs(dy);
    const THRESH = 30;
    if (absX < THRESH && absY < THRESH) return; // tap = ignore (buttons handle taps)
    if (absX > absY) {
      queueLaneChange(dx > 0 ? 1 : -1);
    } else {
      if (dy < 0) queueJump(); else queueDuck(true);
    }
  }, { passive: true });

  // On-screen buttons
  const leftBtn = document.getElementById('left-btn');
  const rightBtn = document.getElementById('right-btn');
  const jumpBtn = document.getElementById('jump-btn');
  const duckBtn = document.getElementById('duck-btn');

  function bindHold(el, onDown) {
    const handler = (e) => { e.preventDefault(); Audio3D.ensure(); onDown(); };
    el.addEventListener('touchstart', handler, { passive: false });
    el.addEventListener('mousedown', handler);
  }
  bindHold(leftBtn, () => queueLaneChange(-1));
  bindHold(rightBtn, () => queueLaneChange(1));
  bindHold(jumpBtn, () => queueJump());
  bindHold(duckBtn, () => queueDuck(true));

  // -------------------------------------------------------------------
  // STATE MACHINE / UI WIRING
  // -------------------------------------------------------------------
  const state = {
    mode: 'loading', // loading | menu | play | pause | gameover | garage
    distance: 0,
    coins: 0,
    speed: CONFIG.baseForwardSpeed,
    elapsed: 0,
    runCoins: 0,
  };

  const el = {
    hud: document.getElementById('hud'),
    loading: document.getElementById('loading-screen'),
    start: document.getElementById('start-screen'),
    garage: document.getElementById('garage-screen'),
    gameover: document.getElementById('gameover-screen'),
    pause: document.getElementById('pause-screen'),
    scoreValue: document.getElementById('score-value'),
    bestValue: document.getElementById('best-value'),
    coinValue: document.getElementById('coin-value'),
    speedFill: document.getElementById('speed-fill'),
    startBest: document.getElementById('start-best'),
    startCoins: document.getElementById('start-coins'),
    garageCoins: document.getElementById('garage-coins'),
    carGrid: document.getElementById('car-grid'),
    finalScore: document.getElementById('final-score'),
    finalCoins: document.getElementById('final-coins'),
    finalBest: document.getElementById('final-best'),
    newBestBadge: document.getElementById('new-best-badge'),
    flash: document.getElementById('flash'),
    loadingBar: document.getElementById('loading-bar-fill'),
    loadingPct: document.getElementById('loading-pct'),
  };

  function showScreen(name) {
    [el.loading, el.start, el.garage, el.gameover, el.pause].forEach(s => s.classList.add('hidden'));
    el.hud.classList.add('hidden');
    if (name === 'loading') el.loading.classList.remove('hidden');
    if (name === 'start') el.start.classList.remove('hidden');
    if (name === 'garage') el.garage.classList.remove('hidden');
    if (name === 'gameover') el.gameover.classList.remove('hidden');
    if (name === 'pause') el.pause.classList.remove('hidden');
    if (name === 'play') el.hud.classList.remove('hidden');
  }

  function refreshMenuStats() {
    el.startBest.textContent = Save.data.best;
    el.startCoins.textContent = Save.data.coins;
    el.garageCoins.textContent = Save.data.coins;
  }

  function buildGarage() {
    el.carGrid.innerHTML = '';
    CAR_SKINS.forEach(skin => {
      const owned = Save.data.unlocked.includes(skin.id);
      const selected = Save.data.selected === skin.id;
      const card = document.createElement('div');
      card.style.cssText = `
        border-radius:14px; padding:12px 10px; text-align:center;
        background:rgba(255,255,255,0.04); border:1px solid ${selected ? '#39F2C8' : 'rgba(255,255,255,0.08)'};
        display:flex; flex-direction:column; align-items:center; gap:6px; cursor:pointer;
      `;
      const swatch = document.createElement('div');
      swatch.style.cssText = `width:54px; height:32px; border-radius:8px; background:#${skin.body.toString(16).padStart(6,'0')}; border:2px solid #${skin.accent.toString(16).padStart(6,'0')};`;
      const label = document.createElement('div');
      label.style.cssText = 'font-size:13px; font-weight:700; color:#EAF2FF;';
      label.textContent = skin.name;
      const sub = document.createElement('div');
      sub.style.cssText = 'font-size:11px; color:#7E8BB3; font-weight:600;';
      sub.textContent = owned ? (selected ? 'Selected' : 'Tap to equip') : `${skin.price} coins`;
      if (!owned) sub.style.color = '#FFD56B';
      card.appendChild(swatch); card.appendChild(label); card.appendChild(sub);

      card.addEventListener('click', () => {
        Audio3D.ensure(); Audio3D.click();
        if (owned) {
          Save.data.selected = skin.id;
          Save.persist();
          playerCar.parent.remove(playerCar);
          playerCar = buildCarMesh(skin);
          playerCar.position.set(player.x, player.y, player.z);
          scene.add(playerCar);
          buildGarage();
        } else if (Save.data.coins >= skin.price) {
          Save.data.coins -= skin.price;
          Save.data.unlocked.push(skin.id);
          Save.data.selected = skin.id;
          Save.persist();
          refreshMenuStats();
          playerCar.parent.remove(playerCar);
          playerCar = buildCarMesh(skin);
          playerCar.position.set(player.x, player.y, player.z);
          scene.add(playerCar);
          buildGarage();
        }
      });
      el.carGrid.appendChild(card);
    });
  }

  // -------------------------------------------------------------------
  // GAME RESET / START / END
  // -------------------------------------------------------------------
  function resetWorld() {
    // remove all dynamic entities
    [...activeTraffic, ...activeObstacles, ...activeCoins].forEach(e => scene.remove(e.mesh));
    activeTraffic.length = 0; activeObstacles.length = 0; activeCoins.length = 0;

    // remove and recreate road chunks (also clears decor)
    roadChunks.forEach(c => scene.remove(c));
    roadChunks.length = 0; decorMeshes.length = 0;
    for (let i = -1; i < CHUNKS_AHEAD; i++) {
      const z = i * CONFIG.chunkLength;
      roadChunks.push(createRoadChunk(z));
    }
    furthestChunkZ = (CHUNKS_AHEAD - 1) * CONFIG.chunkLength;
    // pre-spawn content for every chunk we've created (0 .. furthestChunkZ inclusive of last chunk)
    for (let z = 0; z <= furthestChunkZ; z += CONFIG.chunkLength) spawnChunkContent(z);
    // next spawn happens one chunk-length beyond the last pre-spawned slot
    lastSpawnZ = furthestChunkZ + CONFIG.chunkLength;
    worldShift = 0;

    player.lane = 1; player.x = LANE_X[1]; player.y = 0; player.z = 0;
    player.velY = 0; player.grounded = true; player.ducking = false; player.duckTimer = 0; player.invuln = 0;
    playerCar.position.set(player.x, player.y, player.z);
    playerCar.scale.set(1,1,1);
    playerCar.rotation.set(0,0,0);

    state.distance = 0; state.coins = 0; state.elapsed = 0; state.speed = CONFIG.baseForwardSpeed; state.runCoins = 0;
  }

  function startGame() {
    Audio3D.ensure();
    resetWorld();
    state.mode = 'play';
    showScreen('play');
  }

  function endGame() {
    state.mode = 'gameover';
    Audio3D.crash();
    el.flash.classList.add('show');
    setTimeout(() => el.flash.classList.remove('show'), 160);

    const score = Math.floor(state.distance);
    const isNewBest = score > Save.data.best;
    if (isNewBest) Save.data.best = score;
    Save.data.coins += state.runCoins;
    Save.persist();

    el.finalScore.textContent = score;
    el.finalCoins.textContent = state.runCoins;
    el.finalBest.textContent = Save.data.best;
    el.newBestBadge.classList.toggle('hidden', !isNewBest);

    setTimeout(() => showScreen('gameover'), 260);
  }

  function togglePause() {
    if (state.mode === 'play') { state.mode = 'pause'; showScreen('pause'); }
    else if (state.mode === 'pause') { state.mode = 'play'; showScreen('play'); }
  }

  // Buttons
  document.getElementById('play-btn').addEventListener('click', () => { Audio3D.ensure(); Audio3D.click(); startGame(); });
  document.getElementById('retry-btn').addEventListener('click', () => { Audio3D.ensure(); Audio3D.click(); startGame(); });
  document.getElementById('menu-btn').addEventListener('click', () => { Audio3D.click(); state.mode='menu'; refreshMenuStats(); showScreen('start'); });
  document.getElementById('garage-btn').addEventListener('click', () => { Audio3D.ensure(); Audio3D.click(); state.mode='garage'; buildGarage(); showScreen('garage'); });
  document.getElementById('back-btn').addEventListener('click', () => { Audio3D.click(); state.mode='menu'; refreshMenuStats(); showScreen('start'); });
  document.getElementById('pause-btn').addEventListener('click', () => { Audio3D.click(); togglePause(); });
  document.getElementById('resume-btn').addEventListener('click', () => { Audio3D.click(); togglePause(); });
  document.getElementById('quit-btn').addEventListener('click', () => { Audio3D.click(); state.mode='menu'; refreshMenuStats(); showScreen('start'); });

  // Visibility -> auto pause
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.mode === 'play') togglePause();
  });

  // -------------------------------------------------------------------
  // COLLISION HELPERS (AABB on XZ plane + Y range)
  // -------------------------------------------------------------------
  function getPlayerAABB() {
    const halfW = player.width / 2 * (player.ducking ? 1.0 : 1.0);
    const halfL = player.length / 2;
    const yMin = player.y;
    const yMax = player.y + (player.ducking ? player.baseScaleY * CONFIG.duckScaleY * 1.4 : 1.4);
    return {
      minX: player.x - halfW, maxX: player.x + halfW,
      minZ: player.z - halfL, maxZ: player.z + halfL,
      minY: yMin, maxY: yMax,
    };
  }

  function overlap1D(aMin,aMax,bMin,bMax){ return aMin <= bMax && aMax >= bMin; }

  // -------------------------------------------------------------------
  // MAIN LOOP
  // -------------------------------------------------------------------
  let lastTime = performance.now();
  let loadProgress = 0;

  function loadingTick() {
    loadProgress += (1 - loadProgress) * 0.18 + 0.015;
    if (loadProgress > 1) loadProgress = 1;
    el.loadingBar.style.width = (loadProgress*100).toFixed(0) + '%';
    el.loadingPct.textContent = `Loading assets… ${(loadProgress*100).toFixed(0)}%`;
    if (loadProgress >= 1) {
      state.mode = 'menu';
      refreshMenuStats();
      showScreen('start');
    } else {
      requestAnimationFrame(loadingTick);
    }
  }
  requestAnimationFrame(loadingTick);

  function updatePlayer(dt) {
    // Lateral movement (lerp toward target lane x)
    const targetX = LANE_X[player.lane];
    player.x += (targetX - player.x) * Math.min(1, CONFIG.laneChangeSpeed * dt);

    // Vertical (jump/gravity)
    if (!player.grounded) {
      player.velY += CONFIG.gravity * dt;
      player.y += player.velY * dt;
      if (player.y <= 0) {
        player.y = 0; player.velY = 0; player.grounded = true;
        Audio3D.land();
      }
    }

    // Duck timer
    if (player.ducking) {
      player.duckTimer -= dt;
      if (player.duckTimer <= 0) player.ducking = false;
    }

    // Invulnerability countdown
    if (player.invuln > 0) player.invuln -= dt*1000;

    // Apply transform
    playerCar.position.set(player.x, player.y, player.z);
    const targetScaleY = player.ducking ? CONFIG.duckScaleY : 1;
    playerCar.scale.y += (targetScaleY - playerCar.scale.y) * Math.min(1, 16*dt);
    // slight lean into turns
    const lean = (targetX - player.x) * -0.06;
    playerCar.rotation.z += (lean - playerCar.rotation.z) * 0.2;
    // bob while invulnerable (flicker)
    playerCar.visible = player.invuln > 0 ? (Math.floor(performance.now()/80) % 2 === 0) : true;

    // wheel spin
    playerCar.userData.wheels && playerCar.userData.wheels.forEach(w => w.rotation.x -= state.speed * dt * 1.4);
  }

  function updateWorld(dt) {
    const dz = state.speed * dt;
    state.distance += dz * 0.5; // scaled for nicer numbers

    // ramp speed
    state.speed = Math.min(CONFIG.maxForwardSpeed, state.speed + CONFIG.speedRampPerSec * dt * state.speed);

    // move player forward visually by moving the WORLD backward (typical endless-runner trick):
    // Instead, shift all dynamic content -z by dz, keep player.z fixed at 0.
    roadChunks.forEach(c => { c.position.z -= dz; });
    decorMeshes.forEach(d => { /* parented to chunks, moves with them */ });

    activeTraffic.forEach(t => {
      // World (and obstacles) shift toward player at `dz`/frame.
      // Traffic also drives forward (away from player, +z in world) at t.speed,
      // so its closing speed on the player is reduced: net -= (dz - t.speed*dt)
      t.z -= (dz - t.speed * dt);
      t.mesh.position.z = t.z;
      t.mesh.userData.wheels && t.mesh.userData.wheels.forEach(w=>w.rotation.x += t.speed*dt*1.4);
    });
    activeObstacles.forEach(o => { o.z -= dz; o.mesh.position.z = o.z; });
    activeCoins.forEach(c => {
      c.z -= dz; c.mesh.position.z = c.z;
      c.mesh.rotation.y += dt*4;
      c.mesh.position.y = 1.0 + Math.sin(performance.now()*0.005 + c.z) * 0.12;
    });

    // recycle road chunks
    roadChunks.forEach(c => {
      if (c.position.z < -CONFIG.chunkLength*1.5) {
        c.position.z += CONFIG.chunkLength * roadChunks.length;
      }
    });

    // spawn new content ahead — lastSpawnZ and entity .z are both in
    // world-shifted (camera-relative) space, so compare directly.
    worldShift += dz;
    while (lastSpawnZ - worldShift < CONFIG.spawnZDistance) {
      spawnChunkContent(lastSpawnZ - worldShift);
      lastSpawnZ += CONFIG.chunkLength;
    }

    // cleanup behind
    for (let i=activeTraffic.length-1;i>=0;i--) {
      if (activeTraffic[i].z < -CONFIG.despawnZDistance) { scene.remove(activeTraffic[i].mesh); activeTraffic.splice(i,1); }
    }
    for (let i=activeObstacles.length-1;i>=0;i--) {
      if (activeObstacles[i].z < -CONFIG.despawnZDistance) { scene.remove(activeObstacles[i].mesh); activeObstacles.splice(i,1); }
    }
    for (let i=activeCoins.length-1;i>=0;i--) {
      if (activeCoins[i].z < -CONFIG.despawnZDistance || activeCoins[i].collected) { scene.remove(activeCoins[i].mesh); activeCoins.splice(i,1); }
    }
  }

  function checkCollisions() {
    if (player.invuln > 0) return;
    const pBox = getPlayerAABB();

    // Traffic collisions
    for (const t of activeTraffic) {
      if (t.lane !== player.lane) continue;
      const halfL = t.length/2, halfW = t.width/2;
      const tMinZ = t.z - halfL, tMaxZ = t.z + halfL;
      const tMinX = t.mesh.position.x - halfW, tMaxX = t.mesh.position.x + halfW;
      if (overlap1D(pBox.minZ,pBox.maxZ,tMinZ,tMaxZ) && overlap1D(pBox.minX,pBox.maxX,tMinX,tMaxX)) {
        if (pBox.minY < 1.6) { // traffic always tall enough to hit
          triggerCrash(); return;
        }
      }
    }

    // Obstacles
    for (const o of activeObstacles) {
      if (o.lane !== player.lane) continue;
      const halfW = o.ud.width/2;
      const oMinZ = o.z - 0.5, oMaxZ = o.z + 0.5;
      const oMinX = o.mesh.position.x - halfW, oMaxX = o.mesh.position.x + halfW;
      if (!overlap1D(pBox.minZ,pBox.maxZ,oMinZ,oMaxZ) || !overlap1D(pBox.minX,pBox.maxX,oMinX,oMaxX)) continue;

      if (o.ud.duckUnder) {
        // collide only if player NOT ducking and head height exceeds beam bottom
        if (!player.ducking && pBox.maxY > o.ud.beamBottom - 0.1 && player.y < 1.0) {
          triggerCrash(); return;
        }
      } else if (o.ud.jumpable) {
        if (player.y < o.ud.height - 0.25) { triggerCrash(); return; }
      } else {
        if (player.y < o.ud.height - 0.15) { triggerCrash(); return; }
      }
    }

    // Coins
    for (const c of activeCoins) {
      if (c.collected || c.lane !== player.lane) continue;
      const dz = Math.abs(c.z - player.z);
      const dy = Math.abs((c.mesh.position.y) - (player.y + 0.7));
      if (dz < 1.0 && dy < 1.3) {
        c.collected = true;
        state.runCoins++;
        Audio3D.coin();
        spawnCoinPop(c.mesh.position.clone());
      }
    }
  }

  // Quick particle pop for coin pickup
  const popPool = [];
  function spawnCoinPop(pos) {
    for (let i=0;i<5;i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.12,0.12,0.12), new THREE.MeshStandardMaterial({ color:0xFFD56B, emissive:0xFFD56B, emissiveIntensity:1 }));
      m.position.copy(pos);
      m.userData.vel = new THREE.Vector3((Math.random()-0.5)*4, Math.random()*4+2, (Math.random()-0.5)*4);
      m.userData.life = 0.5;
      scene.add(m);
      popPool.push(m);
    }
  }
  function updatePops(dt) {
    for (let i=popPool.length-1;i>=0;i--) {
      const p = popPool[i];
      p.userData.vel.y -= 12*dt;
      p.position.addScaledVector(p.userData.vel, dt);
      p.userData.life -= dt;
      p.scale.setScalar(Math.max(0,p.userData.life*2));
      if (p.userData.life <= 0) { scene.remove(p); popPool.splice(i,1); }
    }
  }

  function triggerCrash() {
    if (player.invuln > 0) return;
    state.runCoins = Math.max(0, state.runCoins - 1); // small penalty
    player.invuln = CONFIG.invulnAfterHitMs;
    // shrink speed a bit and bounce
    state.speed = Math.max(CONFIG.baseForwardSpeed*0.6, state.speed*0.55);
    player.velY = 6;
    player.grounded = false;
    el.flash.classList.add('show');
    setTimeout(()=>el.flash.classList.remove('show'), 120);
    Audio3D.crash();

    // If speed crashes too low repeatedly / or simply end after 2 hits quickly -> for simplicity, end run on hit
    endGame();
  }

  function updateCamera(dt) {
    const targetPos = new THREE.Vector3(player.x*0.5, 6.4 + player.y*0.6, -9.2);
    camera.position.lerp(targetPos, Math.min(1, CONFIG.cameraFollowLag*dt));
    const lookTarget = new THREE.Vector3(player.x*0.5, 1.2 + player.y*0.5, 8);
    camera.lookAt(lookTarget);
    // subtle FOV change with speed
    const targetFov = 62 + (state.speed/CONFIG.maxForwardSpeed)*8;
    camera.fov += (targetFov - camera.fov)*0.05;
    camera.updateProjectionMatrix();
  }

  function updateHUD() {
    el.scoreValue.textContent = Math.floor(state.distance);
    el.bestValue.textContent = `Best ${Save.data.best}`;
    el.coinValue.textContent = state.runCoins;
    const pct = Math.min(100, (state.speed - CONFIG.baseForwardSpeed) / (CONFIG.maxForwardSpeed - CONFIG.baseForwardSpeed) * 100 + 12);
    el.speedFill.style.width = pct + '%';
  }

  function animate() {
    const now = performance.now();
    let dt = (now - lastTime) / 1000;
    dt = Math.min(dt, 1/30); // clamp for tab-switch hiccups
    lastTime = now;

    if (state.mode === 'play') {
      state.elapsed += dt;
      updatePlayer(dt);
      updateWorld(dt);
      updatePops(dt);
      checkCollisions();
      updateCamera(dt);
      updateHUD();
    } else if (state.mode === 'menu' || state.mode === 'garage') {
      // idle ambient: slow rotate player car on a turntable feel
      playerCar.rotation.y += dt*0.4;
      camera.position.lerp(new THREE.Vector3(4.5, 3.2, -6), 0.02);
      camera.lookAt(playerCar.position.x, 1, playerCar.position.z);
      playerCar.userData.wheels && playerCar.userData.wheels.forEach(w=>w.rotation.x -= dt*2);
    } else if (state.mode === 'pause') {
      // freeze
    } else if (state.mode === 'gameover') {
      updatePops(dt);
    }

    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  }
  animate();

  // Expose for debugging
  window.__laneRush = { state, Save, CONFIG };
})();
