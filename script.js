const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const peerIdEl = document.getElementById('peer-id');
const peerInput = document.getElementById('peer-input');
const connectBtn = document.getElementById('connect-btn');
const networkStatusEl = document.getElementById('network-status');
const modeLabel = document.getElementById('mode-label');
const speedLabel = document.getElementById('speed-label');
const islandLabel = document.getElementById('island-label');
const enemyLabel = document.getElementById('enemy-label');

function setStatusText(element, value) {
  if (element) element.textContent = value;
}

const resetBtn = document.getElementById('reset-btn');
const boostBtn = document.getElementById('boost-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');
const mobileBoostBtn = document.getElementById('mobile-boost-btn');
const joystickBase = document.getElementById('joystick-base');
const joystickKnob = document.getElementById('joystick-knob');

const view = { width: 960, height: 620, dpr: 1 };

/* Кэш неба (пересобирается только при ресайзе) */
let skyGradient = null;
let skyGradientHeight = -1;

/* Офскрин-рендер острова: рисуем один раз, дальше просто blit со сдвигом камеры */
const islandCanvas = document.createElement('canvas');
const islandCtx = islandCanvas.getContext('2d');
let islandBaked = false;

const settings = {
  glow: true,
  clouds: true,
  trails: true,
};

const NET = {
  stateHz: 60,
  cratesHz: 20,
  pingHz: 1,
  remoteInterpDelay: 100,
  boostFxDuration: 0.35,
};

/* ---------- ICE: STUN + TURN ---------- */
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 10,
};

const PLAYER_COLORS = ['#7ef0a5', '#7dd9ff', '#ffd884', '#ff8bb6', '#c792ea', '#f4a261', '#8ee4af', '#f28fad'];
const MAX_PLAYERS = PLAYER_COLORS.length;

const world = {
  width: 2000,
  height: 1600,
  camera: { x: 0, y: 0 },
  island: { x: 1000, y: 800, size: 1760 },
  clouds: [],
  cars: [],
  crates: [],
  particles: [],
  peer: null,
  myPeerId: null,
  myColor: PLAYER_COLORS[0],
  /* 'idle' — офлайн, 'host' — принимаем подключения, 'client' — подключены к хосту */
  role: 'idle',
  localCar: null,
  remoteCars: new Map(), // peerId -> car
  hostConnections: new Map(), // peerId -> DataConnection (используется хостом)
  hostConnection: null, // DataConnection до хоста (используется клиентом)
  nextColorIndex: 1,
  lastStateSentAt: 0,
  lastCratesSentAt: 0,
  lastPingSentAt: 0,
  ping: null,
};

function assignNextColor() {
  const color = PLAYER_COLORS[world.nextColorIndex % PLAYER_COLORS.length];
  world.nextColorIndex += 1;
  return color;
}

function isConnected() {
  return world.role === 'host' ? world.hostConnections.size > 0 : world.role === 'client' && !!(world.hostConnection && world.hostConnection.open);
}

function rebuildCarsList() {
  world.cars = world.localCar ? [world.localCar, ...world.remoteCars.values()] : [...world.remoteCars.values()];
}

const input = {
  left: false,
  right: false,
  up: false,
  down: false,
  boost: false,
};

const mobileInput = { x: 0, y: 0, active: false };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ---------- Размер канваса ---------- */
function resizeCanvas() {
  const parent = canvas.parentElement;
  if (!parent) return;

  const rect = parent.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(1, Math.floor(rect.width));
  const cssH = Math.max(1, Math.floor(rect.height));
  const bufW = Math.max(1, Math.floor(cssW * dpr));
  const bufH = Math.max(1, Math.floor(cssH * dpr));

  if (canvas.width !== bufW || canvas.height !== bufH) {
    canvas.width = bufW;
    canvas.height = bufH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  view.width = cssW;
  view.height = cssH;
  view.dpr = dpr;
}

/* ---------- Сущности ---------- */
function createCloud(x, y, scale, speed) {
  return { x, y, scale, speed, offset: Math.random() * Math.PI * 2 };
}

function seedClouds() {
  world.clouds = [];
  for (let i = 0; i < 12; i += 1) {
    world.clouds.push(
      createCloud(
        120 + Math.random() * 1800,
        40 + Math.random() * 420,
        0.7 + Math.random() * 1.5,
        0.18 + Math.random() * 0.7
      )
    );
  }
}

function createCar(x, y, angle, color, isPlayer = false, peerId = null) {
  return {
    x, y, vx: 0, vy: 0, angle,
    targetX: x, targetY: y, targetAngle: angle,
    buffer: [],
    boostFxTimer: 0,
    radius: isPlayer ? 18 : 16,
    color, isPlayer, peerId, boostTimer: 0,
  };
}

function createCrate(x, y, size = 54, mass = 1.9) {
  return {
    x, y, size, mass,
    vx: 0, vy: 0,
    targetX: x, targetY: y,
    color: '#a86a3d',
  };
}

/* Точки старта по номеру слота, чтобы игроки не спавнились друг на друге */
const SPAWN_SLOTS = [
  { x: 1000, y: 790, angle: -Math.PI / 2 },
  { x: 1090, y: 680, angle: -Math.PI / 2 },
  { x: 910, y: 680, angle: -Math.PI / 2 },
  { x: 1090, y: 900, angle: -Math.PI / 2 },
  { x: 910, y: 900, angle: -Math.PI / 2 },
  { x: 1180, y: 790, angle: -Math.PI / 2 },
  { x: 820, y: 790, angle: -Math.PI / 2 },
  { x: 1000, y: 620, angle: -Math.PI / 2 },
];

function spawnSlotFor(index) {
  return SPAWN_SLOTS[index % SPAWN_SLOTS.length];
}

function createPlayer() {
  const slot = spawnSlotFor(0);
  return createCar(slot.x, slot.y, slot.angle, world.myColor, true, world.myPeerId);
}

function seedCrates() {
  world.crates = [
    createCrate(880, 760, 54, 2.1),
    createCrate(1160, 900, 64, 2.4),
    createCrate(950, 1040, 52, 1.9),
    createCrate(1280, 760, 60, 2.2),
    createCrate(1100, 620, 56, 2.1),
    createCrate(740, 980, 58, 2.3),
  ];
}

function getCarByPeerId(peerId) {
  return world.remoteCars.get(peerId) || null;
}

function addRemoteCar(peerId, color, x, y, angle) {
  let car = world.remoteCars.get(peerId);
  if (!car) {
    const slot = spawnSlotFor(world.remoteCars.size + 1);
    car = createCar(
      typeof x === 'number' ? x : slot.x,
      typeof y === 'number' ? y : slot.y,
      typeof angle === 'number' ? angle : slot.angle,
      color,
      false,
      peerId
    );
    world.remoteCars.set(peerId, car);
    rebuildCarsList();
  }
  refreshOpponentStatus();
  return car;
}

function removeCarByPeerId(peerId) {
  if (world.remoteCars.delete(peerId)) {
    rebuildCarsList();
    refreshOpponentStatus();
  }
}

function refreshOpponentStatus() {
  const count = world.remoteCars.size;
  if (world.role === 'host') {
    setStatusText(enemyLabel, count ? `в игре: ${count + 1}` : 'ждём игроков…');
  } else if (world.role === 'client' && isConnected()) {
    const pingTxt = world.ping != null ? ` · ${world.ping} ms` : '';
    setStatusText(enemyLabel, `в игре: ${count + 1}${pingTxt}`);
  } else {
    setStatusText(enemyLabel, 'нет соперников');
  }
}

function resetRace() {
  const slot = spawnSlotFor(0);
  world.localCar = createCar(slot.x, slot.y, slot.angle, world.myColor, true, world.myPeerId);
  rebuildCarsList();
  world.particles = [];
  if (!world.crates.length) seedCrates();
  setStatusText(modeLabel, 'Свободный заезд');
  setStatusText(islandLabel, 'Готов');
  refreshOpponentStatus();
}

const islandBoundsCache = { left: 0, right: 0, top: 0, bottom: 0 };
function getIslandBounds() {
  const half = world.island.size * 0.5;
  islandBoundsCache.left = world.island.x - half;
  islandBoundsCache.right = world.island.x + half;
  islandBoundsCache.top = world.island.y - half;
  islandBoundsCache.bottom = world.island.y + half;
  return islandBoundsCache;
}

/* ---------- Камера ---------- */
function setCamera() {
  const player = world.localCar;
  if (!player) return;

  const maxX = Math.max(0, world.width - view.width);
  const maxY = Math.max(0, world.height - view.height);

  world.camera.x = clamp(player.x - view.width / 2, 0, maxX);
  world.camera.y = clamp(player.y - view.height / 2, 0, maxY);
}

function keepCarsInsideWorld() {
  for (const car of world.cars) {
    car.x = clamp(car.x, car.radius, world.width - car.radius);
    car.y = clamp(car.y, car.radius, world.height - car.radius);
  }
}

function sendToConn(conn, type, payload) {
  if (!conn || !conn.open) return;
  try {
    conn.send(JSON.stringify({ type, payload, ts: Date.now() }));
  } catch (error) {
    console.warn('Send error', error);
  }
}

/* Хост -> все клиенты (опционально кроме одного — для релея) */
function broadcastFromHost(type, payload, exceptPeerId = null) {
  for (const [peerId, conn] of world.hostConnections) {
    if (peerId === exceptPeerId) continue;
    sendToConn(conn, type, payload);
  }
}

/* Клиент -> хост */
function sendToHost(type, payload) {
  sendToConn(world.hostConnection, type, payload);
}

/* Универсальная отправка «своего» события всем остальным участникам комнаты */
function sendPeerAction(type, payload) {
  if (world.role === 'host') {
    broadcastFromHost(type, payload);
  } else if (world.role === 'client') {
    sendToHost(type, payload);
  }
}

/* ---------- Вектор движения ---------- */
function getMoveVector() {
  let x = 0;
  let y = 0;

  if (input.left) x -= 1;
  if (input.right) x += 1;
  if (input.up) y -= 1;
  if (input.down) y += 1;

  if (mobileInput.active) {
    x += mobileInput.x;
    y += mobileInput.y;
  }

  const mag = Math.hypot(x, y);
  if (mag > 1) {
    x /= mag;
    y /= mag;
  }
  return { x, y, mag: Math.min(mag, 1) };
}

/* ---------- Джойстик ---------- */
function updateJoystickState() {
  if (!joystickBase || !joystickKnob) return;
  const radius = joystickBase.clientWidth * 0.3;
  const knobX = clamp(mobileInput.x * radius, -radius, radius);
  const knobY = clamp(mobileInput.y * radius, -radius, radius);
  joystickKnob.style.transform = `translate(${knobX}px, ${knobY}px)`;
}

function handleJoystickPointer(event) {
  if (!joystickBase) return;

  const rect = joystickBase.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = event.clientX - cx;
  const dy = event.clientY - cy;
  const maxDistance = rect.width * 0.32;
  const distance = Math.min(Math.hypot(dx, dy), maxDistance);
  const angle = Math.atan2(dy, dx);

  mobileInput.x = Math.cos(angle) * (distance / maxDistance);
  mobileInput.y = Math.sin(angle) * (distance / maxDistance);
  mobileInput.active = true;

  updateJoystickState();
}

function resetJoystick() {
  mobileInput.x = 0;
  mobileInput.y = 0;
  mobileInput.active = false;
  if (joystickKnob) joystickKnob.style.transform = 'translate(0, 0)';
}

/* ---------- Физика игрока ---------- */
function handleCarInput(car, dt) {
  if (!car) return;

  const accel = 560;
  const maxSpeed = 300;
  const turnRate = 14;
  const dampingDrive = 2.0;
  const dampingIdle = 7.0;

  const move = getMoveVector();
  const hasInput = move.mag > 0.12;

  if (hasInput) {
    const targetAngle = Math.atan2(move.y, move.x);
    let diff = targetAngle - car.angle;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));

    const maxTurn = turnRate * dt;
    if (Math.abs(diff) <= maxTurn) {
      car.angle = targetAngle;
    } else {
      car.angle += Math.sign(diff) * maxTurn;
    }

    car.vx += move.x * accel * move.mag * dt;
    car.vy += move.y * accel * move.mag * dt;
  }

  if (input.boost && car.isPlayer) {
    const boostForce = 480;
    car.vx += Math.cos(car.angle) * boostForce * dt;
    car.vy += Math.sin(car.angle) * boostForce * dt;
    car.boostTimer = 0.2;
  }

  const damping = hasInput ? dampingDrive : dampingIdle;
  const factor = Math.exp(-damping * dt);
  car.vx *= factor;
  car.vy *= factor;

  const speed = Math.hypot(car.vx, car.vy);
  if (speed > maxSpeed) {
    const scale = maxSpeed / speed;
    car.vx *= scale;
    car.vy *= scale;
  }

  if (Math.abs(car.vx) < 0.05) car.vx = 0;
  if (Math.abs(car.vy) < 0.05) car.vy = 0;

  car.x += car.vx * dt;
  car.y += car.vy * dt;

  const bounds = getIslandBounds();
  const margin = car.radius + 10;

  if (car.x < bounds.left + margin) { car.x = bounds.left + margin; car.vx *= -0.25; }
  if (car.x > bounds.right - margin) { car.x = bounds.right - margin; car.vx *= -0.25; }
  if (car.y < bounds.top + margin) { car.y = bounds.top + margin; car.vy *= -0.25; }
  if (car.y > bounds.bottom - margin) { car.y = bounds.bottom - margin; car.vy *= -0.25; }

  if (settings.trails && speed > 30) {
    world.particles.push({
      x: car.x - Math.cos(car.angle) * 17,
      y: car.y - Math.sin(car.angle) * 17,
      life: 18, maxLife: 18,
      color: car.color,
      r: car.radius * 0.45,
    });
  }

  if (world.particles.length > 220) world.particles.shift();
}

/* ---------- Физика коробок ---------- */
function shouldSimulateCrates() {
  return world.role !== 'client';
}

function simulateCrates(dt) {
  for (const crate of world.crates) {
    crate.vx *= 0.94;
    crate.vy *= 0.94;

    if (Math.abs(crate.vx) < 0.02) crate.vx = 0;
    if (Math.abs(crate.vy) < 0.02) crate.vy = 0;

    crate.x += crate.vx * dt;
    crate.y += crate.vy * dt;

    const bounds = getIslandBounds();
    const half = crate.size * 0.5;

    if (crate.x < bounds.left + half) { crate.x = bounds.left + half; crate.vx *= -0.45; }
    if (crate.x > bounds.right - half) { crate.x = bounds.right - half; crate.vx *= -0.45; }
    if (crate.y < bounds.top + half) { crate.y = bounds.top + half; crate.vy *= -0.45; }
    if (crate.y > bounds.bottom - half) { crate.y = bounds.bottom - half; crate.vy *= -0.45; }

    for (const car of world.cars) {
      const dx = car.x - crate.x;
      const dy = car.y - crate.y;
      const minDistance = car.radius + crate.size * 0.5;
      const distance = Math.hypot(dx, dy) || 0.0001;

      if (distance < minDistance) {
        const nx = dx / distance;
        const ny = dy / distance;
        const overlap = minDistance - distance;
        const push = overlap * 0.55;

        car.x += nx * push;
        car.y += ny * push;

        const velAlongNormal = car.vx * nx + car.vy * ny;
        if (velAlongNormal < 0) {
          const pushForce = Math.min(1.2, Math.abs(velAlongNormal) / 150);
          crate.vx += (car.vx * 0.18) / crate.mass;
          crate.vy += (car.vy * 0.18) / crate.mass;
          car.vx *= 0.67 - pushForce * 0.12;
          car.vy *= 0.67 - pushForce * 0.12;
        }

        const boxAccel = Math.min(160, Math.hypot(car.vx, car.vy) * 0.5);
        crate.vx += (nx * boxAccel * 0.02) / crate.mass;
        crate.vy += (ny * boxAccel * 0.02) / crate.mass;
      }
    }

    crate.targetX = crate.x;
    crate.targetY = crate.y;
  }
}

function interpolateCrates(dt) {
  const t = 1 - Math.exp(-16 * dt);
  for (const crate of world.crates) {
    crate.x += (crate.targetX - crate.x) * t;
    crate.y += (crate.targetY - crate.y) * t;
  }
}

function updateCrates(dt) {
  if (shouldSimulateCrates()) {
    simulateCrates(dt);

    if (world.role === 'host' && world.hostConnections.size > 0) {
      const interval = 1000 / NET.cratesHz;
      if (performance.now() - world.lastCratesSentAt > interval) {
        sendCratesState();
        world.lastCratesSentAt = performance.now();
      }
    }
  } else {
    interpolateCrates(dt);
  }
}

function sendCratesState() {
  sendPeerAction('crates', {
    list: world.crates.map((c) => ({ x: c.x, y: c.y, vx: c.vx, vy: c.vy })),
  });
}

function applyCratesState(payload, snap) {
  if (!payload || !Array.isArray(payload.list)) return;
  const count = Math.min(world.crates.length, payload.list.length);
  for (let i = 0; i < count; i += 1) {
    const src = payload.list[i];
    const dst = world.crates[i];
    if (typeof src.x !== 'number' || typeof src.y !== 'number') continue;

    if (snap) {
      dst.x = src.x;
      dst.y = src.y;
    }
    dst.targetX = src.x;
    dst.targetY = src.y;
    if (typeof src.vx === 'number') dst.vx = src.vx;
    if (typeof src.vy === 'number') dst.vy = src.vy;
  }
}

/* ---------- Сетевые соперники (N игроков) ---------- */
function applyRemoteState(peerId, x, y, angle) {
  if (typeof x !== 'number' || typeof y !== 'number' || typeof angle !== 'number') return;
  const remoteCar = getCarByPeerId(peerId) || addRemoteCar(peerId, assignNextColor(), x, y, angle);

  const now = performance.now();
  remoteCar.buffer.push({ x, y, angle, t: now });

  while (remoteCar.buffer.length > 60) remoteCar.buffer.shift();
}

function updateOneRemoteCar(remoteCar, dt) {
  if (remoteCar.boostFxTimer > 0) {
    remoteCar.boostFxTimer = Math.max(0, remoteCar.boostFxTimer - dt);
  }

  const buf = remoteCar.buffer;
  if (buf.length === 0) return;

  const renderAt = performance.now() - NET.remoteInterpDelay;

  while (buf.length > 2 && buf[1].t < renderAt) buf.shift();

  if (buf.length === 1) {
    const s = buf[0];
    remoteCar.x = s.x;
    remoteCar.y = s.y;
    remoteCar.angle = s.angle;
    return;
  }

  const a = buf[0];
  const b = buf[1];

  if (renderAt <= a.t) {
    remoteCar.x = a.x;
    remoteCar.y = a.y;
    remoteCar.angle = a.angle;
    return;
  }

  const span = b.t - a.t;
  const t = span > 0 ? clamp((renderAt - a.t) / span, 0, 1) : 0;

  remoteCar.x = a.x + (b.x - a.x) * t;
  remoteCar.y = a.y + (b.y - a.y) * t;

  let diff = b.angle - a.angle;
  diff = Math.atan2(Math.sin(diff), Math.cos(diff));
  remoteCar.angle = a.angle + diff * t;

  if (span > 0) {
    remoteCar.vx = ((b.x - a.x) / span) * 1000;
    remoteCar.vy = ((b.y - a.y) / span) * 1000;
  }
}

function updateRemoteCars(dt) {
  if (!isConnected()) return;
  for (const remoteCar of world.remoteCars.values()) {
    updateOneRemoteCar(remoteCar, dt);
  }
}

/* ---------- Коллизия машин ---------- */
function resolveCarCollisions() {
  const cars = world.cars;
  for (let i = 0; i < cars.length; i += 1) {
    for (let j = i + 1; j < cars.length; j += 1) {
      const a = cars[i];
      const b = cars[j];

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minDist = a.radius + b.radius;
      const distSq = dx * dx + dy * dy;

      if (distSq >= minDist * minDist) continue;

      const dist = Math.sqrt(distSq) || 0.0001;
      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = minDist - dist;

      const push = overlap * 0.5;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;

      const rvx = b.vx - a.vx;
      const rvy = b.vy - a.vy;
      const velAlongNormal = rvx * nx + rvy * ny;

      if (velAlongNormal > 0) continue;

      const restitution = 0.55;
      const impulse = (-(1 + restitution) * velAlongNormal) / 2;

      a.vx -= impulse * nx;
      a.vy -= impulse * ny;
      b.vx += impulse * nx;
      b.vy += impulse * ny;

      if (a.isPlayer) a.boostTimer = 0;
      if (b.isPlayer) b.boostTimer = 0;
    }
  }
}

function updateParticles(dt) {
  const particles = world.particles;
  let write = 0;
  for (let read = 0; read < particles.length; read += 1) {
    const p = particles[read];
    p.life -= dt * 60;
    if (p.life <= 0) continue;
    p.x += (Math.random() - 0.5) * 0.5;
    p.y += (Math.random() - 0.5) * 0.5;
    particles[write] = p;
    write += 1;
  }
  particles.length = write;
}

/* ---------- Сетевые служебные события ---------- */
function emitBoostFx(car) {
  if (!car) return;
  car.boostFxTimer = NET.boostFxDuration;
  const forward = car.angle;
  for (let i = 0; i < 10; i += 1) {
    world.particles.push({
      x: car.x - Math.cos(forward) * (12 + Math.random() * 14),
      y: car.y - Math.sin(forward) * (12 + Math.random() * 14),
      life: 22, maxLife: 22,
      color: '#ffe28a',
      r: car.radius * 0.55,
    });
  }
  if (world.particles.length > 260) world.particles.shift();
}

function broadcastBoost() {
  sendPeerAction('boost', { peerId: world.myPeerId });
}

function broadcastReset() {
  sendPeerAction('reset', {});
}

/* ---------- Главный апдейт ---------- */
function update(dt) {
  if (!world.localCar) resetRace();

  const player = world.localCar;
  if (input.boost && player) {
    player.boostTimer = Math.max(player.boostTimer, 0.15);
  }

  handleCarInput(player, dt);
  updateCrates(dt);
  updateRemoteCars(dt);
  resolveCarCollisions();

  if (isConnected()) {
    const now = performance.now();

    if (now - world.lastStateSentAt > 1000 / NET.stateHz) {
      sendPeerAction('state', {
        peerId: world.myPeerId, x: player.x, y: player.y, angle: player.angle,
      });
      world.lastStateSentAt = now;
    }

    if (world.role === 'client' && now - world.lastPingSentAt > 1000 / NET.pingHz) {
      sendToHost('ping', { t: now });
      world.lastPingSentAt = now;
    }
  }

  if (player && player.boostTimer > 0) player.boostTimer -= dt;

  updateParticles(dt);
  keepCarsInsideWorld();
  setCamera();

  if (speedLabel && player) {
    speedLabel.textContent = `${Math.round(Math.hypot(player.vx, player.vy) * 0.6)} km/h`;
  }
  if (modeLabel && player) {
    modeLabel.textContent = player.boostTimer > 0 ? 'Буст активен' : 'Свободный заезд';
  }
}

/* ---------- Рисование ---------- */
function drawSky() {
  if (!skyGradient || skyGradientHeight !== view.height) {
    skyGradient = ctx.createLinearGradient(0, 0, 0, view.height);
    skyGradient.addColorStop(0, '#7fbdf8');
    skyGradient.addColorStop(0.38, '#cfeeff');
    skyGradient.addColorStop(1, '#edf8ff');
    skyGradientHeight = view.height;
  }
  ctx.fillStyle = skyGradient;
  ctx.fillRect(0, 0, view.width, view.height);

  if (settings.clouds) {
    for (const cloud of world.clouds) {
      const x = ((cloud.x - world.camera.x * cloud.speed * 0.2) % (view.width + 220)) - 110;
      const y = cloud.y + Math.sin(performance.now() * 0.00027 + cloud.offset) * 12;
      const w = 70 * cloud.scale;
      const h = 28 * cloud.scale;

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
      ctx.ellipse(x + w * 0.7, y - h * 0.2, w * 0.75, h * 0.8, 0, 0, Math.PI * 2);
      ctx.ellipse(x - w * 0.7, y - h * 0.15, w * 0.68, h * 0.7, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

const ISLAND_PAD = 32; // запас под shadowBlur, чтобы тень не обрезалась

function bakeIsland() {
  const size = world.island.size;
  const canvasSize = size + ISLAND_PAD * 2;
  islandCanvas.width = canvasSize;
  islandCanvas.height = canvasSize;

  const cx = ISLAND_PAD;
  const cy = ISLAND_PAD;

  islandCtx.clearRect(0, 0, canvasSize, canvasSize);
  islandCtx.save();

  islandCtx.beginPath();
  islandCtx.roundRect(cx, cy, size, size, 42);
  islandCtx.fillStyle = '#5fc76f';
  islandCtx.shadowColor = 'rgba(67, 184, 92, 0.7)';
  islandCtx.shadowBlur = settings.glow ? 28 : 0;
  islandCtx.fill();
  islandCtx.shadowBlur = 0;

  islandCtx.strokeStyle = 'rgba(18, 78, 26, 0.7)';
  islandCtx.lineWidth = 5;
  islandCtx.beginPath();
  islandCtx.roundRect(cx, cy, size, size, 42);
  islandCtx.stroke();

  islandCtx.fillStyle = 'rgba(26, 108, 58, 0.22)';
  islandCtx.fillRect(cx + size * 0.04, cy + size * 0.12, size * 0.92, size * 0.76);

  for (let i = 0; i < 20; i += 1) {
    const x = cx + size * 0.1 + (i / 19) * size * 0.8;
    const y = cy + size * 0.5 + Math.sin(i * 0.8) * size * 0.12;
    islandCtx.fillStyle = 'rgba(34, 104, 57, 0.18)';
    islandCtx.fillRect(x, y, 18, 18);
  }

  islandCtx.restore();
  islandBaked = true;
}

function drawIsland() {
  if (!islandBaked) bakeIsland();

  const size = world.island.size;
  const islandX = world.island.x - world.camera.x - size / 2 - ISLAND_PAD;
  const islandY = world.island.y - world.camera.y - size / 2 - ISLAND_PAD;

  ctx.drawImage(islandCanvas, islandX, islandY);
}

function drawCrates() {
  for (const crate of world.crates) {
    const x = crate.x - crate.size * 0.5 - world.camera.x;
    const y = crate.y - crate.size * 0.5 - world.camera.y;
    const s = crate.size;

    ctx.save();
    ctx.fillStyle = '#a3703d';
    ctx.fillRect(x, y, s, s);
    ctx.strokeStyle = '#5d3418';
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 2, y + 2, s - 4, s - 4);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x + 6, y + 6, s - 12, s - 12);
    ctx.restore();
  }
}

function drawParticles() {
  for (const p of world.particles) {
    const alpha = clamp(p.life / p.maxLife, 0, 1);
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.beginPath();
    ctx.arc(p.x - world.camera.x, p.y - world.camera.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCar(car) {
  const x = car.x - world.camera.x;
  const y = car.y - world.camera.y;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(car.angle);

  if (car.boostFxTimer > 0) {
    ctx.shadowColor = '#ffe28a';
    ctx.shadowBlur = 30;
  } else {
    ctx.shadowColor = settings.glow ? car.color : 'transparent';
    ctx.shadowBlur = settings.glow ? 16 : 0;
  }

  ctx.fillStyle = car.color;
  ctx.fillRect(-18, -10, 36, 20);
  ctx.fillStyle = 'rgba(18, 26, 32, 0.75)';
  ctx.fillRect(-10, -8, 20, 16);
  ctx.fillStyle = '#f4f8ff';
  ctx.fillRect(14, -4, 8, 8);
  ctx.fillRect(-18, -9, 7, 5);
  ctx.fillRect(-18, 4, 7, 5);

  ctx.restore();
}

function drawWorld() {
  drawSky();
  drawIsland();
  drawCrates();
  for (const car of world.cars) drawCar(car);
  drawParticles();
}

function loop(ts) {
  const dt = Math.min(0.033, (ts - (loop.lastTime || ts)) / 1000 || 0.016);
  loop.lastTime = ts;
  update(dt);
  drawWorld();
  requestAnimationFrame(loop);
}

/* ---------- PeerJS ---------- */
function getConnectLink(peerId) {
  const url = new URL(window.location.href);
  url.searchParams.set('connect', peerId);
  url.hash = '';
  return url.toString();
}

function getLinkConnectTarget() {
  const params = new URLSearchParams(window.location.search);
  return params.get('connect') || params.get('peer') || params.get('join') || '';
}

function initPeer() {
  if (world.peer) world.peer.destroy();

  world.peer = new Peer(undefined, {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    path: '/',
    config: ICE_SERVERS,
    debug: 1,
  });

  world.peer.on('open', (id) => {
    world.myPeerId = id;
    world.localCar.peerId = id;
    peerIdEl.textContent = id;
    if (!peerInput.value.trim()) peerInput.value = id;
    networkStatusEl.textContent = 'готов';

    const connectTarget = getLinkConnectTarget();
    if (connectTarget && connectTarget !== id) {
      peerInput.value = connectTarget;
      connectToPeer();
    }
  });

  // Кто-то подключается к нам: если мы ещё никого не хостим и сами
  // ни к кому не подключены — становимся хостом комнаты. Если мы уже
  // хост — просто принимаем ещё одного игрока.
  world.peer.on('connection', (conn) => {
    if (world.role === 'client') {
      // Мы сами клиент чужой комнаты — этот ID не для подключения других.
      conn.on('open', () => sendToConn(conn, 'error', { reason: 'not-a-host' }));
      return;
    }
    world.role = 'host';
    attachHostConnection(conn);
    networkStatusEl.textContent = 'подключение…';
  });

  world.peer.on('error', (err) => {
    console.warn('Peer error:', err);
    const t = err && err.type ? err.type : 'unknown';
    if (t === 'peer-unavailable') {
      networkStatusEl.textContent = 'ID не найден';
    } else if (t === 'network' || t === 'server-error' || t === 'socket-error') {
      networkStatusEl.textContent = 'сервер сигнализации недоступен';
    } else if (t === 'unavailable-id') {
      networkStatusEl.textContent = 'ID уже занят';
    } else {
      networkStatusEl.textContent = `ошибка: ${t}`;
    }
  });
}

/* ---------- Хост: обслуживание одного подключившегося игрока ---------- */
function attachHostConnection(conn) {
  conn.on('open', () => {
    const color = assignNextColor();
    world.hostConnections.set(conn.peer, conn);
    const newCar = addRemoteCar(conn.peer, color, undefined, undefined, undefined);

    // Полный ростер (включая себя-хоста) — новому игроку, чтобы отрисовать всех сразу
    const roster = [
      { peerId: world.myPeerId, color: world.myColor, x: world.localCar.x, y: world.localCar.y, angle: world.localCar.angle },
      ...[...world.remoteCars.values()]
        .filter((car) => car.peerId !== conn.peer)
        .map((car) => ({ peerId: car.peerId, color: car.color, x: car.x, y: car.y, angle: car.angle })),
    ];

    sendToConn(conn, 'welcome', { yourColor: color, players: roster, crates: cratesSnapshotPayload() });

    // Остальным — что подключился новый игрок
    broadcastFromHost('join', { peerId: conn.peer, color, x: newCar.x, y: newCar.y, angle: newCar.angle }, conn.peer);

    networkStatusEl.textContent = 'подключено (хост)';
    refreshOpponentStatus();
  });

  conn.on('error', (err) => {
    console.warn('Connection error:', err);
  });

  conn.on('data', (payload) => handleIncomingData(payload, conn));

  conn.on('close', () => {
    world.hostConnections.delete(conn.peer);
    removeCarByPeerId(conn.peer);
    broadcastFromHost('leave', { peerId: conn.peer });
    if (world.hostConnections.size === 0) {
      networkStatusEl.textContent = 'ждём игроков';
    }
    refreshOpponentStatus();
  });
}

/* ---------- Клиент: единственное подключение к хосту ---------- */
function connectToPeer() {
  const remoteId = peerInput.value.trim();
  if (!remoteId || !world.peer) return;

  if (isConnected()) {
    disconnectFromRoom();
    return;
  }

  world.role = 'client';
  const conn = world.peer.connect(remoteId, {
    reliable: true,
    config: ICE_SERVERS,
  });
  world.hostConnection = conn;
  networkStatusEl.textContent = 'подключение…';

  conn.on('open', () => {
    networkStatusEl.textContent = 'подключено';
    refreshOpponentStatus();

    const pc = conn.peerConnection;
    if (pc) {
      pc.oniceconnectionstatechange = () => console.log('[ICE]', pc.iceConnectionState);
      pc.onconnectionstatechange = () => console.log('[PC]', pc.connectionState);
    }
  });

  conn.on('error', (err) => {
    console.warn('Connection error:', err);
    networkStatusEl.textContent = 'соединение оборвалось';
  });

  conn.on('data', (payload) => handleIncomingData(payload, conn));

  conn.on('close', () => {
    disconnectFromRoom();
  });
}

function disconnectFromRoom() {
  if (world.hostConnection) {
    try { world.hostConnection.close(); } catch (e) { /* ignore */ }
  }
  world.hostConnection = null;
  world.role = 'idle';
  world.ping = null;
  world.remoteCars.clear();
  rebuildCarsList();
  networkStatusEl.textContent = 'ожидание';
  for (const crate of world.crates) {
    crate.targetX = crate.x;
    crate.targetY = crate.y;
  }
  refreshOpponentStatus();
}

function cratesSnapshotPayload() {
  return { list: world.crates.map((c) => ({ x: c.x, y: c.y, vx: c.vx, vy: c.vy })) };
}

/* ---------- Общий разбор входящих сообщений (и хост, и клиент) ---------- */
function handleIncomingData(payload, fromConn) {
  try {
    const packet = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!packet || !packet.type) return;
    const { type, payload: data } = packet;

    if (type === 'welcome') {
      // Только клиент получает welcome — от хоста, сразу после подключения
      world.myColor = data.yourColor;
      world.localCar.color = data.yourColor;
      for (const p of data.players || []) {
        addRemoteCar(p.peerId, p.color, p.x, p.y, p.angle);
      }
      if (data.crates) applyCratesState(data.crates, true);
      refreshOpponentStatus();
      return;
    }

    if (type === 'join') {
      addRemoteCar(data.peerId, data.color, data.x, data.y, data.angle);
      return;
    }

    if (type === 'leave') {
      removeCarByPeerId(data.peerId);
      return;
    }

    if (type === 'state') {
      applyRemoteState(data.peerId, data.x, data.y, data.angle);
      if (world.role === 'host') {
        // Ретранслируем позицию этого игрока всем остальным клиентам
        broadcastFromHost('state', data, data.peerId);
      }
      return;
    }

    if (type === 'crates') {
      if (world.role !== 'host') applyCratesState(data, false);
      return;
    }

    if (type === 'boost') {
      emitBoostFx(getCarByPeerId(data.peerId));
      if (world.role === 'host') {
        broadcastFromHost('boost', data, data.peerId);
      }
      return;
    }

    if (type === 'reset') {
      resetRace();
      if (world.role === 'host') {
        broadcastFromHost('reset', {}, fromConn ? fromConn.peer : null);
      }
      return;
    }

    if (type === 'ping') {
      sendToConn(fromConn, 'pong', { t: data && data.t });
      return;
    }

    if (type === 'pong') {
      const sentAt = data && data.t;
      if (typeof sentAt === 'number') {
        world.ping = Math.max(1, Math.round(performance.now() - sentAt));
        refreshOpponentStatus();
      }
      return;
    }
  } catch (error) {
    console.warn('Peer message error', error);
  }
}

/* ---------- Джойстик ---------- */
if (joystickBase) {
  joystickBase.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    try { joystickBase.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
    handleJoystickPointer(event);
  });

  joystickBase.addEventListener('pointermove', (event) => {
    if (mobileInput.active) {
      event.preventDefault();
      handleJoystickPointer(event);
    }
  });

  const stop = (event) => {
    if (event) event.preventDefault();
    resetJoystick();
  };

  joystickBase.addEventListener('pointerup', stop);
  joystickBase.addEventListener('pointercancel', stop);
  joystickBase.addEventListener('lostpointercapture', stop);
}

/* ---------- Клавиатура ---------- */
window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'w' || key === 'arrowup') input.up = true;
  if (key === 's' || key === 'arrowdown') input.down = true;
  if (key === 'a' || key === 'arrowleft') input.left = true;
  if (key === 'd' || key === 'arrowright') input.right = true;
  if (key === ' ') { input.boost = true; event.preventDefault(); }
});

window.addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'w' || key === 'arrowup') input.up = false;
  if (key === 's' || key === 'arrowdown') input.down = false;
  if (key === 'a' || key === 'arrowleft') input.left = false;
  if (key === 'd' || key === 'arrowright') input.right = false;
  if (key === ' ') input.boost = false;
});

/* ---------- Кнопки ---------- */
function triggerBoost() {
  const player = world.localCar;
  if (!player) return;
  player.vx += Math.cos(player.angle) * 160;
  player.vy += Math.sin(player.angle) * 160;
  player.boostTimer = 0.4;

  emitBoostFx(player);
  broadcastBoost();
}

if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    resetRace();
    setCamera();
    broadcastReset();
  });
}

if (connectBtn) {
  connectBtn.addEventListener('click', () => connectToPeer());
}

if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', async () => {
    const id = peerIdEl.textContent && peerIdEl.textContent !== 'offline' ? peerIdEl.textContent : '';
    if (!id) {
      networkStatusEl.textContent = 'сначала дождитесь ID';
      return;
    }
    const shareLink = getConnectLink(id);
    try {
      await navigator.clipboard.writeText(shareLink);
      networkStatusEl.textContent = 'ссылка скопирована';
    } catch (error) {
      const tempInput = document.createElement('input');
      tempInput.value = shareLink;
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand('copy');
      tempInput.remove();
      networkStatusEl.textContent = 'ссылка скопирована';
    }
  });
}

if (boostBtn) {
  boostBtn.addEventListener('click', triggerBoost);
}

if (mobileBoostBtn) {
  mobileBoostBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    triggerBoost();
  });
}

/* ---------- Resize ---------- */
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 150));

if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => resizeCanvas());
  ro.observe(canvas.parentElement);
}

/* ---------- Старт ---------- */
resizeCanvas();
seedClouds();
seedCrates();
resetRace();
initPeer();
update(0.016);
drawWorld();
requestAnimationFrame(loop);
