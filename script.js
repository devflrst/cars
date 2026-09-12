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
  if (element) {
    element.textContent = value;
  }
}

const resetBtn = document.getElementById('reset-btn');
const boostBtn = document.getElementById('boost-btn');
const copyLinkBtn = document.getElementById('copy-link-btn');
const mobileBoostBtn = document.getElementById('mobile-boost-btn');
const joystickBase = document.getElementById('joystick-base');
const joystickKnob = document.getElementById('joystick-knob');

/* Логический размер вьюпорта (CSS-пиксели) и DPR для чёткой картинки */
const view = { width: 960, height: 620, dpr: 1 };

const settings = {
  glow: true,
  clouds: true,
  trails: true,
};

const world = {
  width: 2000,
  height: 1600,
  camera: { x: 0, y: 0 },
  island: {
    x: 1000,
    y: 800,
    size: 1760,
  },
  clouds: [],
  cars: [],
  crates: [],
  particles: [],
  peer: null,
  connection: null,
  lastStateSentAt: 0,
};

const input = {
  left: false,
  right: false,
  up: false,
  down: false,
  boost: false,
};

const mobileInput = {
  x: 0,
  y: 0,
  active: false,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ---- Подгонка канваса под контейнер с учётом devicePixelRatio ---- */
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

/* ---------------------- Игровые сущности ---------------------- */

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

function createCar(x, y, angle, color, isPlayer = false) {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    radius: isPlayer ? 18 : 16,
    color,
    isPlayer,
    boostTimer: 0,
  };
}

function createCrate(x, y, size = 54, mass = 1.9) {
  return {
    x,
    y,
    size,
    mass,
    vx: 0,
    vy: 0,
    color: '#a86a3d',
  };
}

function createPlayer() {
  return createCar(1000, 790, -Math.PI / 2, '#7ef0a5', true);
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

function getRemoteCar() {
  return world.cars.find((car) => !car.isPlayer) || null;
}

function ensureRemoteCar() {
  if (!getRemoteCar()) {
    const remote = createCar(1090, 680, -Math.PI / 2, '#7dd9ff', false);
    world.cars.push(remote);
  }
  refreshOpponentStatus();
}

function removeRemoteCar() {
  world.cars = world.cars.filter((car) => car.isPlayer);
  refreshOpponentStatus();
}

function refreshOpponentStatus() {
  const opponents = world.cars.filter((car) => !car.isPlayer);
  const text = opponents.length
    ? `${opponents.length} соперник${opponents.length > 1 ? 'а' : ''}`
    : world.connection && world.connection.open
      ? '1 соперник'
      : '0 соперников';

  setStatusText(enemyLabel, text);
}

function resetRace() {
  world.cars = [createPlayer()];
  world.particles = [];
  if (!world.crates.length) {
    seedCrates();
  }
  setStatusText(modeLabel, 'Свободный заезд');
  setStatusText(islandLabel, 'Готов');
  refreshOpponentStatus();
}

function getIslandBounds() {
  const half = world.island.size * 0.5;
  return {
    left: world.island.x - half,
    right: world.island.x + half,
    top: world.island.y - half,
    bottom: world.island.y + half,
  };
}

/* Камера следует за игроком (важно для мобильных экранов) */
function setCamera() {
  const player = world.cars.find((car) => car.isPlayer);
  if (!player) return;

  const maxX = Math.max(0, world.width - view.width);
  const maxY = Math.max(0, world.height - view.height);

  const targetX = player.x - view.width / 2;
  const targetY = player.y - view.height / 2;

  world.camera.x = clamp(targetX, 0, maxX);
  world.camera.y = clamp(targetY, 0, maxY);
}

function keepCarsInsideWorld() {
  for (const car of world.cars) {
    car.x = clamp(car.x, car.radius, world.width - car.radius);
    car.y = clamp(car.y, car.radius, world.height - car.radius);
  }
}

function sendPeerAction(type, payload) {
  if (!world.connection || !world.connection.open) return;
  world.connection.send(JSON.stringify({ type, payload, ts: Date.now() }));
}

/* ------------------------- Джойстик ------------------------- */

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
  if (joystickKnob) {
    joystickKnob.style.transform = 'translate(0, 0)';
  }
}

/* ------------------------- Физика ------------------------- */

function handleCarInput(car, dt) {
  if (!car) return;

  const turnStrength = 2.2;
  const accel = 240;
  const reverseAccel = 180;
  const friction = 0.985;
  const maxSpeed = 260;

  let steer = 0;
  if (input.left) steer -= 1;
  if (input.right) steer += 1;
  if (mobileInput.x < -0.2) steer -= 1;
  if (mobileInput.x > 0.2) steer += 1;
  steer = clamp(steer, -1, 1);

  let throttle = 0;
  if (input.up) throttle += 1;
  if (input.down) throttle -= 0.7;
  if (mobileInput.y < -0.2) throttle += 1;
  if (mobileInput.y > 0.2) throttle -= 0.7;
  throttle = clamp(throttle, -0.7, 1);

  if (steer !== 0) {
    car.angle += steer * turnStrength * dt;
  }

  if (throttle !== 0) {
    const forwardX = Math.cos(car.angle);
    const forwardY = Math.sin(car.angle);
    const desiredAccel = throttle > 0 ? accel : reverseAccel;
    car.vx += forwardX * desiredAccel * throttle * dt;
    car.vy += forwardY * desiredAccel * throttle * dt;
  }

  if (input.boost && car.isPlayer) {
    const boostForce = 360;
    car.vx += Math.cos(car.angle) * boostForce * dt;
    car.vy += Math.sin(car.angle) * boostForce * dt;
    car.boostTimer = 0.2;
  }

  const speed = Math.hypot(car.vx, car.vy);
  if (speed > maxSpeed) {
    const scale = maxSpeed / speed;
    car.vx *= scale;
    car.vy *= scale;
  }

  if (!input.boost && Math.abs(throttle) < 0.05) {
    car.vx *= friction;
    car.vy *= friction;
  }

  if (Math.abs(car.vx) < 0.02) car.vx = 0;
  if (Math.abs(car.vy) < 0.02) car.vy = 0;

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
      life: 18,
      maxLife: 18,
      color: car.color,
      r: car.radius * 0.45,
    });
  }

  if (world.particles.length > 220) {
    world.particles.shift();
  }
}

function updateCrates(dt) {
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
        crate.vx += nx * boxAccel * 0.02 / crate.mass;
        crate.vy += ny * boxAccel * 0.02 / crate.mass;
      }
    }
  }
}

function applyRemoteState(packet) {
  if (!packet || !packet.payload) return;

  const remoteCar = getRemoteCar() || ensureRemoteCar();
  const { x, y, angle, vx, vy } = packet.payload;

  if (typeof x === 'number') remoteCar.x = x;
  if (typeof y === 'number') remoteCar.y = y;
  if (typeof angle === 'number') remoteCar.angle = angle;
  if (typeof vx === 'number') remoteCar.vx = vx;
  if (typeof vy === 'number') remoteCar.vy = vy;
}

function updateRemoteCars(dt) {
  if (world.connection && world.connection.open) return;

  const remoteCar = getRemoteCar();
  if (!remoteCar) return;

  const target = world.cars[0];
  const dx = target.x - remoteCar.x;
  const dy = target.y - remoteCar.y;
  const angleToTarget = Math.atan2(dy, dx);
  const diff = ((angleToTarget - remoteCar.angle + Math.PI) % (Math.PI * 2)) - Math.PI;

  if (Math.abs(diff) > 0.12) {
    remoteCar.angle += diff * 0.9 * dt * 2.4;
  }

  const drift = Math.sin((performance.now() * 0.001) + 2) * 0.3;
  remoteCar.vx += Math.cos(remoteCar.angle + drift) * 65 * dt;
  remoteCar.vy += Math.sin(remoteCar.angle + drift) * 65 * dt;

  const currentSpeed = Math.hypot(remoteCar.vx, remoteCar.vy);
  if (currentSpeed > 170) {
    const scale = 170 / currentSpeed;
    remoteCar.vx *= scale;
    remoteCar.vy *= scale;
  }

  remoteCar.x += remoteCar.vx * dt;
  remoteCar.y += remoteCar.vy * dt;

  const dxToIsland = remoteCar.x - world.island.x;
  const dyToIsland = remoteCar.y - world.island.y;
  const absX = Math.abs(dxToIsland);
  const absY = Math.abs(dyToIsland);
  const half = world.island.size * 0.5 - remoteCar.radius * 1.9;

  if (absX > half || absY > half) {
    const overlapX = Math.max(0, absX - half);
    const overlapY = Math.max(0, absY - half);
    const pushX = absX > half ? (dxToIsland >= 0 ? 1 : -1) : 0;
    const pushY = absY > half ? (dyToIsland >= 0 ? 1 : -1) : 0;

    remoteCar.x -= pushX * overlapX * 1.7;
    remoteCar.y -= pushY * overlapY * 1.7;
    remoteCar.vx *= 0.8;
    remoteCar.vy *= 0.8;
  }

  remoteCar.x = clamp(remoteCar.x, 120, world.width - 120);
  remoteCar.y = clamp(remoteCar.y, 120, world.height - 120);
}

function updateParticles(dt) {
  world.particles = world.particles.filter((particle) => particle.life > 0);
  for (const particle of world.particles) {
    particle.life -= dt * 60;
    particle.x += (Math.random() - 0.5) * 0.5;
    particle.y += (Math.random() - 0.5) * 0.5;
  }
}

function update(dt) {
  if (!world.cars.length) {
    resetRace();
  }

  const player = world.cars[0];
  if (input.boost && player) {
    player.boostTimer = Math.max(player.boostTimer, 0.15);
  }

  handleCarInput(player, dt);
  updateCrates(dt);
  updateRemoteCars(dt);

  if (world.connection && world.connection.open && performance.now() - world.lastStateSentAt > 80) {
    sendPeerAction('state', {
      x: player.x,
      y: player.y,
      angle: player.angle,
      vx: player.vx,
      vy: player.vy,
    });
    world.lastStateSentAt = performance.now();
  }

  if (player && player.boostTimer > 0) {
    player.boostTimer -= dt;
  }

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

/* ------------------------ Отрисовка ------------------------ */

function drawSky() {
  const gradient = ctx.createLinearGradient(0, 0, 0, view.height);
  gradient.addColorStop(0, '#7fbdf8');
  gradient.addColorStop(0.38, '#cfeeff');
  gradient.addColorStop(1, '#edf8ff');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, view.width, view.height);

  if (settings.clouds) {
    for (const cloud of world.clouds) {
      const x = ((cloud.x - world.camera.x * cloud.speed * 0.2) % (view.width + 220)) - 110;
      const y = cloud.y + Math.sin((performance.now() * 0.00027) + cloud.offset) * 12;
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

function drawIsland() {
  ctx.save();

  const islandX = world.island.x - world.camera.x;
  const islandY = world.island.y - world.camera.y;
  const size = world.island.size;

  ctx.beginPath();
  ctx.roundRect(islandX - size / 2, islandY - size / 2, size, size, 42);
  ctx.fillStyle = '#5fc76f';
  ctx.shadowColor = 'rgba(67, 184, 92, 0.7)';
  ctx.shadowBlur = settings.glow ? 28 : 0;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = 'rgba(18, 78, 26, 0.7)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(islandX - size / 2, islandY - size / 2, size, size, 42);
  ctx.stroke();

  ctx.fillStyle = 'rgba(26, 108, 58, 0.22)';
  ctx.fillRect(islandX - size * 0.46, islandY - size * 0.38, size * 0.92, size * 0.76);

  for (let i = 0; i < 20; i += 1) {
    const x = islandX - size * 0.4 + (i / 19) * size * 0.8;
    const y = islandY + Math.sin(i * 0.8) * size * 0.12;
    ctx.fillStyle = 'rgba(34, 104, 57, 0.18)';
    ctx.fillRect(x, y, 18, 18);
  }

  ctx.restore();
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
  for (const particle of world.particles) {
    const alpha = clamp(particle.life / particle.maxLife, 0, 1);
    const x = particle.x - world.camera.x;
    const y = particle.y - world.camera.y;
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, particle.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCar(car) {
  const x = car.x - world.camera.x;
  const y = car.y - world.camera.y;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(car.angle);

  ctx.fillStyle = car.color;
  ctx.shadowColor = settings.glow ? car.color : 'transparent';
  ctx.shadowBlur = settings.glow ? 16 : 0;

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

  for (const car of world.cars) {
    drawCar(car);
  }

  drawParticles();
}

function loop(ts) {
  const dt = Math.min(0.033, (ts - (loop.lastTime || ts)) / 1000 || 0.016);
  loop.lastTime = ts;

  update(dt);
  drawWorld();

  requestAnimationFrame(loop);
}

/* --------------------------- PeerJS --------------------------- */

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
  if (world.peer) {
    world.peer.destroy();
  }

  world.peer = new Peer(undefined, {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    path: '/',
  });

  world.peer.on('open', (id) => {
    peerIdEl.textContent = id;
    if (!peerInput.value.trim()) {
      peerInput.value = id;
    }
    networkStatusEl.textContent = 'готов';

    const connectTarget = getLinkConnectTarget();
    if (connectTarget && connectTarget !== id) {
      peerInput.value = connectTarget;
      connectToPeer();
    }
  });

  world.peer.on('connection', (conn) => {
    attachConnection(conn);
    networkStatusEl.textContent = 'подключение';
  });

  world.peer.on('error', () => {
    networkStatusEl.textContent = 'ошибка сети';
  });
}

function attachConnection(conn) {
  world.connection = conn;
  ensureRemoteCar();
  refreshOpponentStatus();

  conn.on('open', () => {
    networkStatusEl.textContent = 'подключено';
    ensureRemoteCar();
    sendPeerAction('hello', { ok: true });
  });

  conn.on('data', (payload) => {
    try {
      const packet = typeof payload === 'string' ? JSON.parse(payload) : payload;
      if (!packet) return;

      if (packet.type === 'hello') {
        ensureRemoteCar();
        return;
      }

      if (packet.type === 'state') {
        applyRemoteState(packet);
        return;
      }
    } catch (error) {
      console.warn('Peer message error', error);
    }
  });

  conn.on('close', () => {
    world.connection = null;
    networkStatusEl.textContent = 'ожидание';
    removeRemoteCar();
  });
}

function connectToPeer() {
  const remoteId = peerInput.value.trim();
  if (!remoteId || !world.peer) return;

  if (world.connection && world.connection.open) {
    world.connection.close();
    return;
  }

  const conn = world.peer.connect(remoteId, { reliable: true });
  attachConnection(conn);
}

/* ------------------------ Джойстик (события) ------------------------ */

if (joystickBase) {
  joystickBase.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    try {
      joystickBase.setPointerCapture(event.pointerId);
    } catch (e) {
      /* игнорируем */
    }
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

/* ------------------------ Клавиатура ------------------------ */

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();

  if (key === 'w' || key === 'arrowup') input.up = true;
  if (key === 's' || key === 'arrowdown') input.down = true;
  if (key === 'a' || key === 'arrowleft') input.left = true;
  if (key === 'd' || key === 'arrowright') input.right = true;
  if (key === ' ') {
    input.boost = true;
    event.preventDefault();
  }
});

window.addEventListener('keyup', (event) => {
  const key = event.key.toLowerCase();

  if (key === 'w' || key === 'arrowup') input.up = false;
  if (key === 's' || key === 'arrowdown') input.down = false;
  if (key === 'a' || key === 'arrowleft') input.left = false;
  if (key === 'd' || key === 'arrowright') input.right = false;
  if (key === ' ') input.boost = false;
});

/* ------------------------ Кнопки ------------------------ */

function triggerBoost() {
  const player = world.cars[0];
  if (!player) return;
  player.vx += Math.cos(player.angle) * 160;
  player.vy += Math.sin(player.angle) * 160;
  player.boostTimer = 0.4;
}

resetBtn.addEventListener('click', () => {
  resetRace();
  setCamera();
});

connectBtn.addEventListener('click', () => {
  connectToPeer();
});

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

boostBtn.addEventListener('click', triggerBoost);

if (mobileBoostBtn) {
  mobileBoostBtn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    triggerBoost();
  });
}

/* -------------------- Изменение размера -------------------- */

function handleResize() {
  resizeCanvas();
}

window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', () => setTimeout(handleResize, 150));

if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() =>
