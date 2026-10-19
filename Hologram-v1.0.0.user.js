// ==UserScript==
// @name         Hologram — Narrow One HUD
// @namespace    hologram.narrow-one
// @homepageURL  https://github.com/CCIdeaS/Narrow-One-Hologram-Mod
// @supportURL   https://github.com/CCIdeaS/Narrow-One-Hologram-Mod/issues
// @version      1.0.0
// @description  Cosmetic Narrow One HUD with local range estimates, feedback, and texture themes
// @match        *://narrow.one/*
// @match        *://*.narrow.one/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (window.__hologramV071 || window.__hologramV06 || window.__hologramV05 ||
      window.__hologramV04 || window.__hologramV03) return;

  const VERSION = '1.0.0';
  const LIMIT = 80;
  const TARGET_MAX_AGE_MS = 500;
  const TARGET_HYSTERESIS_PX = 14;
  const TARGET_ACQUIRE_PX = 120;
  const reticleImage = (kind, color, outline = '#242028', detail = '#a65b70') => {
    const core = `
      <path d="M110 10V64 M20 80H94 M126 80H200"/>
      <path d="M42 76V84 M62 76V84 M158 76V84 M178 76V84"/>
      <path d="M20 74V86 M200 74V86"/>
      <path d="M103 37H117"/>
      <path d="M110 73L117 80 110 87 103 80Z"/>
    `;
    const ladder = [36, 42, 48, 54, 60].map((width, index) => {
      const y = 102 + index * 22, left = 110 - width / 2, right = 110 + width / 2;
      return `<path d="M${left} ${y}H${right} M${left} ${y - 4}V${y + 4} M${right} ${y - 4}V${y + 4}"/>`;
    }).join('');
    const paths = kind === 'core' ? core : ladder;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="300" viewBox="0 0 220 300">
      <g fill="none" stroke="${outline}" stroke-width="5" stroke-linejoin="miter">${paths}</g>
      <g fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="miter">${paths}</g>
      ${kind === 'core' ? `<path d="M110 77L113 80 110 83 107 80Z" fill="${color}"/>
        <path d="M21 74V86 M199 74V86 M103 37H117" fill="none" stroke="${detail}" stroke-width="1.5"/>` : ''}
    </svg>`;
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return image;
  };
  const reticleArt = {
    hologram: {core:reticleImage('core','#f2eadb'),ladder:reticleImage('ladder','#d0c5be')},
    pulsar: {core:reticleImage('core','#f6fbff','#18222e','#7898b7'),ladder:reticleImage('ladder','#a8c5df','#18222e','#7898b7')},
    geo: {core:reticleImage('core','#e8ece7','#202522','#557461'),ladder:reticleImage('ladder','#bec9c0','#202522','#557461')},
    coreFlash: reticleImage('core', '#b78cff'),
    ladderFlash: reticleImage('ladder', '#b78cff')
  };
  const DEBUG_ID_LIMIT = 16;
  const MATRIX_MAX_AGE_MS = 250;
  const finite = Number.isFinite;
  const now = () => new Date().toISOString();
  const keep = (array, item, limit = LIMIT) => {
    array.push(item);
    if (array.length > limit) array.shift();
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const u16 = (view, offset) => view.getUint16(offset, true);
  const u32 = (view, offset) => view.getUint32(offset, true);

  const state = {
    version: VERSION,
    startedAt: now(),
    bounds: null,
    sockets: [],
    arrows: [],
    players: {},
    events: [],
    packetShapes: {},
    teamDiagnostics: { creations: 0, changes: 0, repeats: 0, ownership: 0, invalidIds: 0, malformed: 0, conflicts: 0, lastIssue: null },
    camera: {
      view: null,
      projection: null,
      viewProjection: null,
      candidates: {},
      lastSeenAt: null
    },
    game: {
      started: false,
      ended: false,
      ownedPlayerId: null,
      reason: 'waiting for match'
    },
    counters: {
      inboundFrames: 0,
      outboundFrames: 0,
      arrow3: 0,
      arrow5: 0,
      bounds19: 0,
      movement4: 0,
      decodeErrors: 0,
      matrixUpdates: 0
    },
    movement: {
      inboundIds: [],
      outboundIds: [],
      inboundLastById: {},
      outboundLastById: {},
      inboundPackets: 0,
      outboundPackets: 0,
      outboundCandidates: {},
      lastDecodeError: null
    },
    settings: {
      opacity: 0.92,
      crosshair: true,
      ladder: true,
      bowProfile: 'largeBow',
      diagnostics: true,
      calibration: false,
      performance: false,
      projectionVerified: false,
      manual: 'auto',
      nearHitTolerance: 1.2,
      clearFog: false,
      customSky: true,
      hidePassiveAds: true,
      acm: true,
      killSfx: true
    },
    rangefinder: {
      targetId: null,
      distance: null,
      screenOffsetPx: null,
      status: 'waiting for match',
      teamStatus: 'unknown',
      lifeStatus: 'unknown',
      projectionStatus: 'unverified',
      occlusion: 'unknown',
      trajectory: null,
      nominalHit: false,
      aimTier: 'none',
      nearMiss: null,
      correction: null
    },
    ballistics: {
      status: 'NOMINAL FULL DRAW',
      weaponCategory: 'largeBow',
      arrowFlySpeed: '0–5; affects flight time',
      chargeProfile: 'full draw assumed',
      projectileModel: 'derived from bundle; random spread and collisions unknown'
    },
    performance: {
      hudFps: 0,
      telemetryPerSecond: 0,
      matricesPerSecond: 0,
      hudRenderMs: 0,
      lastSampleMs: 0
    },
    ui: { panelOpen: false },
    feedback: { combo: 0, lastHitMs: 0, flashAt: -10000, targetId: null,
      lastHitKind: null,
      lastDamage: null, healthById: {}, lastKillId: null, lastKillMs: -10000 },
    health: { value: null, source: 'waiting', lastChangeMs: 0 },
    cameraInvalidReason: 'not yet checked'
  };

  try {
    const saved = JSON.parse(localStorage.getItem('hologram-settings-v1') || '{}');
    for (const [key, value] of Object.entries(saved)) {
      if (key in state.settings && typeof value === typeof state.settings[key])
        state.settings[key] = value;
    }
  } catch { /* Use defaults when local storage is unavailable or malformed. */ }
  if (!Object.prototype.hasOwnProperty.call({smallBow:1,mediumBow:1,largeBow:1,smallCrossbow:1,largeCrossbow:1,repeatingCrossbow:1}, state.settings.bowProfile))
    state.settings.bowProfile = 'largeBow';
  state.ballistics.weaponCategory = state.settings.bowProfile;

  function persistSettings() {
    try { localStorage.setItem('hologram-settings-v1', JSON.stringify(state.settings)); }
    catch { /* Settings still work for this page session. */ }
  }

  const log = (kind, data = {}) =>
    keep(state.events, { at: now(), kind, ...data });

  let killAudio = null;
  function unlockKillAudio() {
    if (!state.settings.killSfx) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    try {
      killAudio ||= new Audio();
      if (killAudio.state === 'suspended') killAudio.resume().catch(() => {});
    } catch (_) { /* Audio is optional if the browser blocks it. */ }
  }
  window.addEventListener('pointerdown', unlockKillAudio, { passive: true });
  window.addEventListener('keydown', unlockKillAudio, { passive: true });

  function playShatterSfx() {
    if (!state.settings.killSfx) return;
    unlockKillAudio();
    const audio = killAudio;
    if (!audio || audio.state !== 'running') return;
    const start = audio.currentTime;
    const length = Math.floor(audio.sampleRate * 0.38);
    const noise = audio.createBuffer(1, length, audio.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < length; i++) samples[i] = Math.random() * 2 - 1;
    const burst = audio.createBufferSource();
    burst.buffer = noise;
    const filter = audio.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1800;
    const burstGain = audio.createGain();
    burstGain.gain.setValueAtTime(0.18, start);
    burstGain.gain.exponentialRampToValueAtTime(0.001, start + 0.34);
    burst.connect(filter).connect(burstGain).connect(audio.destination);
    burst.start(start);
    burst.stop(start + 0.35);
    for (const [index, frequency] of [1320, 1860, 2470, 3190].entries()) {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      const at = start + index * 0.018;
      tone.type = 'sine';
      tone.frequency.setValueAtTime(frequency, at);
      tone.frequency.exponentialRampToValueAtTime(frequency * 0.65, at + 0.19);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.055, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.23);
      tone.connect(gain).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.24);
    }
  }

  function playConfirmedHitSfx(kind) {
    if (!state.settings.killSfx) return;
    unlockKillAudio();
    const audio = killAudio;
    if (!audio || audio.state !== 'running') return;
    const start = audio.currentTime;
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.type = kind === 'melee' ? 'triangle' : 'sine';
    tone.frequency.setValueAtTime(kind === 'melee' ? 210 : 360, start);
    tone.frequency.exponentialRampToValueAtTime(kind === 'melee' ? 90 : 170, start + 0.11);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.09, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.13);
    tone.connect(gain).connect(audio.destination);
    tone.start(start);
    tone.stop(start + 0.14);
  }

  const names = new WeakMap();
  const canvasIds = new WeakMap();
  const rectCache = new WeakMap();

  let nextCanvasId = 1;
  let forceRectRefresh = true;

  const RECT_REFRESH_MS = 250;
  const matrixNamePattern = /(?:view|camera|proj|projection)/i;

  // Keep original game uniform values so fog and sky colors can be restored.
  const fogUniformNames = new WeakMap();
  const fogKeys = new Set([
    'fogAmount', 'fogHeightAmount',
    'fogHeightAmountMin', 'fogHeightAmountMax'
  ]);
  const skyColors = Object.freeze({
    skyHighCol: [0.36, 0.12, 0.23], // Burgundy upper sky
    skyMidCol: [0.67, 0.42, 0.49],  // muted transition
    skyLowCol: [0.95, 0.92, 0.86]   // Ivory horizon
  });
  const skyKeys = new Set(Object.keys(skyColors));
  const fogContexts = new WeakMap();
  for (const Context of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Context?.prototype) continue;
    const proto = Context.prototype;
    const nativeLocation = proto.getUniformLocation;
    const nativeUniform1f = proto.uniform1f;
    const nativeUniform3f = proto.uniform3f;
    const nativeUniform3fv = proto.uniform3fv;
    const nativeUseProgram = proto.useProgram;
    const nativeMatrix4fv = proto.uniformMatrix4fv;
    if (typeof nativeLocation !== 'function' ||
        typeof nativeUniform1f !== 'function' ||
        typeof nativeUseProgram !== 'function') continue;
    const dataFor = context => {
      let data = fogContexts.get(context);
      if (!data) {
        data = { program: null, byProgram: new WeakMap(), programModes: new WeakMap() };
        fogContexts.set(context, data);
      }
      return data;
    };
    proto.getUniformLocation = function(program, name) {
      const location = nativeLocation.call(this, program, name);
      if (location && typeof name === 'string' && matrixNamePattern.test(name))
        names.set(location, name);
      if (location && (fogKeys.has(name) || skyKeys.has(name))) {
        fogUniformNames.set(location, name);
        const data = dataFor(this);
        let entries = data.byProgram.get(program);
        if (!entries) {
          entries = new Map();
          data.byProgram.set(program, entries);
        }
        entries.set(name, { location, value: null, appliedMode: null });
      }
      return location;
    };
    proto.useProgram = function(program) {
      dataFor(this).program = program;
      return nativeUseProgram.call(this, program);
    };
    proto.uniform1f = function(location, value) {
      const name = location && fogUniformNames.get(location);
      if (name) {
        const data = dataFor(this);
        const entry = data.program && data.byProgram.get(data.program)?.get(name);
        const clear = state.settings.clearFog && state.game.started && !state.game.ended;
        if (entry?.location === location) {
          entry.value = value;
          entry.appliedMode = clear;
        }
        if (clear) value = 0;
      }
      return nativeUniform1f.call(this, location, value);
    };
    if (typeof nativeUniform3f === 'function') {
      proto.uniform3f = function(location, x, y, z) {
        const name = location && fogUniformNames.get(location);
        if (skyKeys.has(name)) {
          const data = dataFor(this);
          const entry = data.program && data.byProgram.get(data.program)?.get(name);
          const active = state.settings.customSky && state.game.started && !state.game.ended;
          if (entry?.location === location) {
            entry.value = [x, y, z];
            entry.appliedMode = active;
          }
          if (active) [x, y, z] = skyColors[name];
        }
        return nativeUniform3f.call(this, location, x, y, z);
      };
    }
    if (typeof nativeUniform3fv === 'function' && typeof nativeUniform3f === 'function') {
      proto.uniform3fv = function(location, values, ...rest) {
        const name = location && fogUniformNames.get(location);
        if (skyKeys.has(name)) {
          const data = dataFor(this);
          const entry = data.program && data.byProgram.get(data.program)?.get(name);
          const active = state.settings.customSky && state.game.started && !state.game.ended;
          const start = Number.isInteger(rest[0]) ? rest[0] : 0;
          if (entry?.location === location) {
            entry.value = [values[start], values[start + 1], values[start + 2]];
            entry.appliedMode = active;
          }
          if (active) return nativeUniform3f.call(this, location, ...skyColors[name]);
        }
        return nativeUniform3fv.call(this, location, values, ...rest);
      };
    }
    if (typeof nativeMatrix4fv === 'function') proto.uniformMatrix4fv = function(location, transpose, value) {
      const name = location && names.get(location);
      if (name === 'viewMatrix' || name === 'projectionMatrix') {
        const t = performance.now();
        const old = state.camera.candidates[name];
        if (value && value.length >= 16 &&
            (!old || t - old.t >= 33)) {
          const matrix = Array.from(value).slice(0, 16);
          if (matrix.every(finite)) {
            const glCanvas = this.canvas;
            if (glCanvas && !canvasIds.has(glCanvas))
              canvasIds.set(glCanvas, nextCanvasId++);
            let cachedRect = glCanvas && rectCache.get(glCanvas);
            if (glCanvas && (forceRectRefresh || !cachedRect ||
                t - cachedRect.t >= RECT_REFRESH_MS)) {
              const rect = glCanvas.getBoundingClientRect?.();
              cachedRect = rect ? {
                t,
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height
              } : null;
              if (cachedRect) rectCache.set(glCanvas, cachedRect);
              if (cachedRect) forceRectRefresh = false;
            }
            const record = {
              name, matrix, t, at: now(),
              canvasId: glCanvas ? canvasIds.get(glCanvas) : null,
              canvasWidth: glCanvas?.width || null,
              canvasHeight: glCanvas?.height || null,
              rect: cachedRect ? {
                left: cachedRect.left, top: cachedRect.top,
                width: cachedRect.width, height: cachedRect.height
              } : null
            };
            state.camera.candidates[name] = record;
            state.camera[
              name === 'viewMatrix' ? 'view' : 'projection'
            ] = record;
            state.camera.lastSeenAt = now();
            state.counters.matrixUpdates++;
          }
        }
      }
      return nativeMatrix4fv.apply(this, arguments);
    };
    const applyFog = context => {
      const data = dataFor(context);
      const entries = data.program && data.byProgram.get(data.program);
      if (!entries) return;
      const clear = state.settings.clearFog && state.game.started && !state.game.ended;
      const sky = state.settings.customSky && state.game.started && !state.game.ended;
      const mode = (clear ? 1 : 0) | (sky ? 2 : 0);
      if (data.programModes.get(data.program) === mode) return;
      data.programModes.set(data.program, mode);
      for (const [name, entry] of entries) {
        const active = skyKeys.has(name) ? sky : clear;
        if (entry.value != null && entry.appliedMode !== active) {
          if (skyKeys.has(name) && typeof nativeUniform3f === 'function')
            nativeUniform3f.call(context, entry.location, ...(active ? skyColors[name] : entry.value));
          else if (fogKeys.has(name))
            nativeUniform1f.call(context, entry.location, active ? 0 : entry.value);
          entry.appliedMode = active;
        }
      }
    };
    for (const method of ['drawArrays', 'drawElements',
      'drawArraysInstanced', 'drawElementsInstanced']) {
      const nativeDraw = proto[method];
      if (typeof nativeDraw !== 'function') continue;
      proto[method] = function(...args) {
        applyFog(this);
        return nativeDraw.apply(this, args);
      };
    }
  }

  function decodePosition(codes) {
    const b = state.bounds;
    if (!b) return null;
    return [
      lerp(b.minX, b.maxX, codes[0] / 65535),
      lerp(b.minY, b.maxY, codes[1] / 65535),
      lerp(b.minZ, b.maxZ, codes[2] / 65535)
    ];
  }

  function decodeWorldBoundsPacket(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== 28)
      return null;
    const view = new DataView(buffer);
    if (u32(view, 0) !== 19) return null;
    const a = Array.from(
      { length: 6 },
      (_, i) => view.getFloat32(4 + 4 * i, true)
    );
    if (!a.every(finite) ||
        a[0] > a[3] || a[1] > a[4] || a[2] > a[5]) return null;
    return {
      minX: a[0], minY: a[1], minZ: a[2],
      maxX: a[3], maxY: a[4], maxZ: a[5]
    };
  }

  function decodeArrowPacket(buffer, bounds = state.bounds) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== 22)
      return null;
    const view = new DataView(buffer);
    const type = u32(view, 0);
    if (type !== 3 && type !== 5) return null;
    const positionCode = [u16(view, 8), u16(view, 10), u16(view, 12)];
    const arrow = {
      type: type === 3 ? 'client-shot' : 'server-arrow',
      messageId: type,
      playerId: u16(view, 4),
      arrowId: u16(view, 6),
      positionCode,
      direction: [u16(view, 14), u16(view, 16), u16(view, 18)]
        .map(x => x / 65535 * 2 - 1),
      fireAmount01: u16(view, 20) / 65535
    };
    if (bounds) {
      const pairs = [
        ['minX', 'maxX'],
        ['minY', 'maxY'],
        ['minZ', 'maxZ']
      ];
      arrow.startPos = positionCode.map((x, i) =>
        lerp(bounds[pairs[i][0]], bounds[pairs[i][1]], x / 65535)
      );
    }
    return arrow;
  }

  // Retained from v0.5 for diagnostics. No ladder marks are derived from it
  // until the longbow category, speed, charge and model are verified.
  const travelDistance = Object.freeze({
    smallBow: 0.4,
    mediumBow: 1,
    largeBow: 3,
    smallCrossbow: 1,
    largeCrossbow: 1,
    repeatingCrossbow: 1
  });
  const bowProfileNames = Object.freeze({
    smallBow:'Small bow', mediumBow:'Medium bow', largeBow:'Large bow',
    smallCrossbow:'Small crossbow', largeCrossbow:'Large crossbow',
    repeatingCrossbow:'Repeating crossbow'
  });
  const sCurve = r => 2 / (1 + Math.exp(-r)) - 1;

  function parabolaPoint2d(h, v, t) {
    const s = sCurve(v / h);
    let y;
    if (s === 0) y = -t * t / h;
    else if (h === 0)
      y = (1 - Math.pow(2 * (t / s - 0.5), 2)) * v * 0.5;
    else
      y = (1 - Math.pow((t / s - h) / h, 2)) * v * 0.5 * s;
    return { x: t, y };
  }

  function arrowModel({
    startPos, direction, fireAmount01, weaponId, arrowFlySpeed
  }) {
    if (!Object.prototype.hasOwnProperty.call(
      travelDistance, weaponId
    )) throw new RangeError('Unknown weaponId');
    if (![...startPos, ...direction, fireAmount01, arrowFlySpeed]
      .every(finite) ||
        fireAmount01 < 0 || fireAmount01 > 1 ||
        arrowFlySpeed < 0 || arrowFlySpeed > 5)
      throw new RangeError('Invalid model inputs');
    const length = Math.hypot(...direction);
    if (!length) throw new RangeError('Zero direction');
    const strength = lerp(
      10, 500 * travelDistance[weaponId], fireAmount01
    );
    const dir = direction.map(x => x * strength / length);
    const h = Math.hypot(dir[0], dir[2]);
    const v = dir[1];
    const extremeT = h === 0
      ? 0.5
      : Math.cos(Math.atan(v / h)) * sCurve(v / h) * strength;
    const extreme = parabolaPoint2d(h, v, extremeT);
    const span = 2 * extreme.x;
    const g = span + 2 * extreme.y;
    let xSpeed = g === 0 ? 1 : Math.abs(span / g);
    xSpeed *= lerp(0.05, 0.15, (strength - 100) / 400);
    xSpeed *= lerp(0.82, 1.05, arrowFlySpeed);
    return {
      strength,
            xSpeed,
      positionAt(ms) {
        const p = parabolaPoint2d(h, v, ms * xSpeed);
        return h === 0
          ? [startPos[0], startPos[1] + p.y, startPos[2]]
          : [
              startPos[0] + p.x * dir[0] / h,
              startPos[1] + p.y,
              startPos[2] + p.x * dir[2] / h
            ];
      }
    };
  }

  // Recover camera origin and forward direction from the
  // inverse of the rigid, column-major view matrix.
  function cameraRay() {
    if (cameraValidity()) return null;

    const m = state.camera.view.matrix;
    const forward = [-m[2], -m[6], -m[10]];
    const length = Math.hypot(...forward);

    if (!finite(length) || length < 0.99 || length > 1.01)
      return null;

    const origin = [
      -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]),
      -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]),
      -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14])
    ];

    return origin.every(finite)
      ? { origin, forward }
      : null;
  }

  // Nominal full-draw strength varies with the selected weapon profile.
  // q is horizontal curve distance, not elapsed time.
  function nominalPoint(ray, q) {
    const d = ray.forward;
    const horizontal = Math.hypot(d[0], d[2]);

    if (horizontal < 1e-5) return null;

    const strength = 500 * (travelDistance[state.settings.bowProfile] || travelDistance.largeBow);
    const h = strength * horizontal;
    const v = strength * d[1];
    const y = parabolaPoint2d(h, v, q).y;

    return [
      ray.origin[0] + q * d[0] / horizontal,
      ray.origin[1] + y,
      ray.origin[2] + q * d[2] / horizontal
    ];
  }

  // Estimated capsule, not a verified Narrow One hitbox. Search the
  // projectile path around the target, rather than testing the crosshair.
  function trajectoryClearance(ray, target) {
    const horizontal = Math.hypot(ray.forward[0], ray.forward[2]);
    if (horizontal < 1e-5) return null;
    const dx = target[0] - ray.origin[0];
    const dz = target[2] - ray.origin[2];
    const qCenter = (dx * ray.forward[0] + dz * ray.forward[2]) / horizontal;
    if (qCenter <= 0 || qCenter > 250) return null;
    const tolerance = Math.max(1.2, state.settings.nearHitTolerance);
    const span = tolerance + 1.2;
    let best = null;
    for (let i = 0; i <= 96; i++) {
      const q = qCenter - span + 2 * span * i / 96;
      if (q <= 0 || q > 250) continue;
      const point = nominalPoint(ray, q);
      if (!point) continue;
      const capsuleY = Math.max(target[1] + 0.35,
        Math.min(target[1] + 1.65, point[1]));
      const clearance = Math.hypot(point[0] - target[0],
        point[1] - capsuleY, point[2] - target[2]);
      if (!best || clearance < best.clearance) best = {point, q, clearance};
    }
    return best;
  }

  function nominalCapsuleHit(ray, target) {
    const best = trajectoryClearance(ray, target);
    return best && best.clearance <= 0.45 ? best : null;
  }

  function player(id) {
    return state.players[id] || (
      state.players[id] = {
        id,
        position: null,
        positionCode: null,
        teamId: null,
        teamSource: null,
        teamConflict: false,
        alive: null,
        lastSeenMs: null,
        lastSeenAt: null,
        acm: { samples: [], lastSnapMs: -10000, lastSuspectShotMs: -10000,
          lastSuspectTargetId: null, aimEvents: [],
          flightEvents: 0, lastFlightEventMs: 0, lastRiseMs: -10000,
          flightUntil: 0, aimUntil: 0 }
      }
    );
  }

  function observeAcmMovement(p, position, yaw, t) {
    if (!state.settings.acm || !position || p.id === state.game.ownedPlayerId) return;
    const a = p.acm;
    if (finite(p.yaw) && finite(p.lastSeenMs)) {
      const dt = t - p.lastSeenMs;
      const turn = Math.abs(Math.atan2(Math.sin(yaw - p.yaw), Math.cos(yaw - p.yaw)));
      if (dt >= 15 && dt <= 250 && turn > 0.95) a.lastSnapMs = t;
    }
    a.samples.push({ t, x: position[0], y: position[1], z: position[2] });
    while (a.samples.length > 30 || (a.samples[0] && t - a.samples[0].t > 3000)) a.samples.shift();
    if (a.samples.some(s => t - s.t <= 1000 && position[1] - s.y > 7))
      a.lastRiseMs = t;
    const first = a.samples[0];
    const floor = state.bounds?.minY;
    if (!first || !finite(floor) || t - first.t < 2200) return;
    const drift = Math.hypot(position[0] - first.x, position[2] - first.z);
    const level = a.samples.every(s => Math.abs(s.y - first.y) < 0.35);
    // Require a rapid climb before repeated high, level travel. This avoids
    // treating ordinary movement along elevated platforms as flight.
    if (t - a.lastRiseMs < 9000 && position[1] > floor + 10 && drift > 6 && level) {
      if (t - a.lastFlightEventMs > 10000) a.flightEvents = 0;
      a.flightEvents++;
      a.lastFlightEventMs = t;
      a.samples.length = 0;
      if (a.flightEvents >= 2) a.flightUntil = t + 30000;
    }
  }

  function observeAcmShot(arrow, t) {
    if (!state.settings.acm) return;
    const shooter = state.players[arrow.playerId];
    if (!shooter || !arrow.startPos || shooter.id === state.game.ownedPlayerId ||
        t - shooter.acm.lastSnapMs > 220) return;
    const d = arrow.direction;
    const length = Math.hypot(...d);
    if (length < 0.5) return;
    const aligned = Object.values(state.players).find(target => {
      if (target.id === shooter.id || !target.position ||
          target.teamId == null || shooter.teamId == null ||
          target.teamId === shooter.teamId ||
          !finite(target.lastSeenMs) || t - target.lastSeenMs > 500) return false;
      const v = [target.position[0] - arrow.startPos[0],
        target.position[1] + 1 - arrow.startPos[1],
        target.position[2] - arrow.startPos[2]];
      const range = Math.hypot(...v);
      return range > 10 && (d[0] * v[0] + d[1] * v[1] + d[2] * v[2]) / (length * range) > 0.998;
    });
    if (!aligned) return;
    shooter.acm.lastSuspectShotMs = t;
    shooter.acm.lastSuspectTargetId = aligned.id;
    shooter.acm.lastSnapMs = -10000;
  }

  function observeAcmHit(attackerId, victimId, t) {
    const a = state.players[attackerId]?.acm;
    if (!a || a.lastSuspectTargetId !== victimId || t - a.lastSuspectShotMs > 1500) return;
    a.lastSuspectShotMs = -10000;
    a.aimEvents.push(t);
    while (a.aimEvents[0] && t - a.aimEvents[0] > 30000) a.aimEvents.shift();
    if (a.aimEvents.length >= 3) a.aimUntil = t + 30000;
  }

  function rememberMovement(
    direction, id, t, codes
  ) {
    const ids = direction === 'inbound'
      ? state.movement.inboundIds
      : state.movement.outboundIds;

    const byId = direction === 'inbound'
      ? state.movement.inboundLastById
      : state.movement.outboundLastById;

    if (!ids.includes(id)) {
      ids.push(id);

      if (ids.length > DEBUG_ID_LIMIT)
        ids.shift();
    }

    byId[id] = {
      t,
      at: now(),
      codes
    };

    const keys = Object.keys(byId);

    if (keys.length > 64)
      delete byId[keys[0]];
  }

  function updatePlayer(
    id, codes, yawCode, pitchCode,
    flags, t, direction
  ) {
    rememberMovement(direction, id, t, codes);

    if (direction === 'outbound') {
      state.movement.outboundCandidates[id] = {
        codes,
        position: decodePosition(codes),
        t,
        at: now(),
        source:
          'outbound type-4 candidate; not yet validated'
      };

      const candidateIds = Object.keys(
        state.movement.outboundCandidates
      );

      if (candidateIds.length > 64) {
        delete state.movement.outboundCandidates[
          candidateIds[0]
        ];
      }

      return;
    }

    const p = player(id);

    const position = decodePosition(codes);
    const yaw = yawCode / 255 * 2 * Math.PI;
    observeAcmMovement(p, position, yaw, t);
    p.positionCode = codes;
    p.position = position;

    p.yaw = yaw;

    p.pitch =
      (pitchCode / 255 * 2 - 1) *
      Math.PI / 2;

    p.flags = flags;
    p.lastSeenMs = t;
    p.lastSeenAt = now();
    p.positionSource = 'inbound type-4';
  }

  function decodeMovement(
    buffer, t, direction
  ) {
    if (
      buffer.byteLength < 6 ||
      (buffer.byteLength - 6) % 12 !== 0
    ) {
      return false;
    }

    const view = new DataView(buffer);
    const flags = u16(view, 4);

    state.movement[
      direction === 'inbound'
        ? 'inboundPackets'
        : 'outboundPackets'
    ]++;

    for (
      let offset = 6;
      offset < buffer.byteLength;
      offset += 12
    ) {
      updatePlayer(
        u16(view, offset),
        [
          u16(view, offset + 2),
          u16(view, offset + 4),
          u16(view, offset + 6)
        ],
        u16(view, offset + 8),
        u16(view, offset + 10),
        flags,
        t,
        direction
      );
    }

    state.counters.movement4++;
    return true;
  }

  function observeBuffer(
    buffer, direction, socketId
  ) {
    state.counters[
      direction === 'inbound'
        ? 'inboundFrames'
        : 'outboundFrames'
    ]++;

    if (buffer.byteLength < 4) return;

    try {
      const view = new DataView(buffer);
      const type = u32(view, 0);

      const shape =
        `${direction}:${type}:${buffer.byteLength}`;

      state.packetShapes[shape] =
        (state.packetShapes[shape] || 0) + 1;

      if (
        Object.keys(state.packetShapes).length > 120
      ) {
        delete state.packetShapes[
          Object.keys(state.packetShapes)[0]
        ];
      }

      const bounds =
        direction === 'outbound'
          ? decodeWorldBoundsPacket(buffer)
          : null;

      if (bounds) {
        state.bounds = bounds;
        state.counters.bounds19++;
        log('bounds', { socketId });
        return;
      }

      const arrow = decodeArrowPacket(buffer);

      if (
        arrow &&
        (
          (direction === 'outbound' && type === 3) ||
          (direction === 'inbound' && type === 5)
        )
      ) {
        Object.assign(arrow, {
          at: now(),
          directionOfTravel: direction,
          socketId
        });

        keep(state.arrows, arrow);
        state.counters[`arrow${type}`]++;
        if (direction === 'inbound' && type === 5) observeAcmShot(arrow, performance.now());
        return;
      }

      if (type === 4) {
        decodeMovement(
          buffer,
          performance.now(),
          direction
        );
        return;
      }

      if (direction !== 'inbound')
        return;

      if (type === 1 && buffer.byteLength === 12) {
        // Current client: type 1 calls createPlayer(id, {teamId}).
        const id = u32(view, 4);
        const team = u32(view, 8);
        state.teamDiagnostics.creations++;
        if (id > 0xffff) {
          state.teamDiagnostics.invalidIds++;
          state.teamDiagnostics.lastIssue = `creation ID ${id} exceeds movement ID width`;
          log('team-id-width-mismatch', { id, team, socketId });
        } else {
          const p = player(id);
          p.teamId = team;
          p.teamSource = 'inbound type-1 creation';
          p.teamPacketLength = buffer.byteLength;
          p.teamConflict = false;
          log('player-created', { id, teamId: team, socketId });
        }

      } else if (type === 25) {
        // Current client: type 25 calls setPlayerTeamId(id, team).
        // A team change is legitimate and replaces the previous team.
        if (buffer.byteLength !== 12) {
          state.teamDiagnostics.malformed++;
          state.teamDiagnostics.lastIssue = `type-25 length ${buffer.byteLength}; expected 12`;
          log('team-update-malformed', { length: buffer.byteLength, socketId });
        } else {
          const id = u32(view, 4);
          const team = u32(view, 8);
          if (id > 0xffff) {
            state.teamDiagnostics.invalidIds++;
            state.teamDiagnostics.lastIssue = `team-update ID ${id} exceeds movement ID width`;
            log('team-id-width-mismatch', { id, team, socketId });
          } else {
            const p = player(id);
            if (p.teamId === team) state.teamDiagnostics.repeats++;
            else state.teamDiagnostics.changes++;
            log('player-team-updated', {
              id, previousTeamId: p.teamId, teamId: team, socketId
            });
            p.teamId = team;
            p.teamSource = 'inbound type-25 update';
            p.teamPacketLength = buffer.byteLength;
            p.teamConflict = false;
          }
        }
      } else if (
        type === 2 &&
        buffer.byteLength >= 8 &&
        buffer.byteLength % 4 === 0
      ) {
        for (
          let offset = 4;
          offset < buffer.byteLength;
          offset += 4
        ) {
          const id = u32(view, offset);
          delete state.players[id];
          delete state.feedback.healthById[id];
          if (state.game.ownedPlayerId === id) state.game.ownedPlayerId = null;

          log('player-destroyed', { id });
        }

      } else if (
        type === 3 &&
        buffer.byteLength >= 12 &&
        (u32(view, 8) === 0 || u32(view, 8) === 1)
      ) {
        const id = u32(view, 4);
        const owned = u32(view, 8) === 1;
        state.teamDiagnostics.ownership++;
        if (!owned) {
          if (state.game.ownedPlayerId === id) state.game.ownedPlayerId = null;
        } else if (id > 0xffff) {
          state.game.ownedPlayerId = null;
          state.teamDiagnostics.invalidIds++;
          state.teamDiagnostics.lastIssue = `owned ID ${id} exceeds movement ID width`;
        } else {
          state.game.ownedPlayerId = id;
          player(id); // Creation and ownership packets may arrive in either order.
        }
        log('ownership', { id, owned, socketId });

      } else if (type === 19) {
        resetHitFeedback();
        state.health.value = null;
        state.health.source = 'waiting';
        state.game.started = true;
        state.game.ended = false;
        state.ui.panelOpen = false;
        for (const p of Object.values(state.players)) {
          p.acm.samples.length = 0;
          p.acm.aimEvents.length = 0;
          p.acm.lastSuspectShotMs = -10000;
          p.acm.lastSuspectTargetId = null;
          p.acm.flightEvents = 0;
          p.acm.lastRiseMs = -10000;
          p.acm.flightUntil = 0;
          p.acm.aimUntil = 0;
        }

        state.settings.projectionVerified = false;

        log('game-start');
        updateOverlayUI();

      } else if (type === 11) {
        resetHitFeedback();
        state.settings.clearFog = false;
        state.game.ended = true;
        state.ui.panelOpen = false;

        state.settings.projectionVerified = false;

        log('game-end');
        updateOverlayUI();

      } else if (
        type === 35 &&
        buffer.byteLength >= 16
      ) {
        const id = u32(view, 4);
        player(id).alive = true;
        if (id === state.game.ownedPlayerId) setLocalHealth(1, 'spawn');

        log('player-spawn', { id });

      } else if ((type === 39 || type === 41) && buffer.byteLength === 12) {
        // Server hit: [type, victimId, attackerId]; 39 melee, 41 arrow.
        const victimId = u32(view, 4);
        const attackerId = u32(view, 8);
        if (victimId !== attackerId) {
          if (type === 41) observeAcmHit(attackerId, victimId, performance.now());
          if (attackerId === state.game.ownedPlayerId)
            registerConfirmedHit(victimId, type === 39 ? 'melee' : 'arrow');
        }
      } else if (type === 33 && buffer.byteLength === 12) {
        // Server health correction: [33, playerId, normalized health u32].
        const id = u32(view, 4);
        const health = u32(view, 8) / 0xffffffff;
        const f = state.feedback;
        const previous = f.healthById[id];
        f.healthById[id] = health;
        if (id === state.game.ownedPlayerId) setLocalHealth(health, 'server');
        if (id === f.targetId && finite(previous) && health < previous &&
            performance.now() - f.lastHitMs < 1200) {
          f.lastDamage = Math.round((previous - health) * 100);
          if (hitLabel) hitLabel.textContent = `${(f.lastHitKind || 'SERVER').toUpperCase()} HIT · ${f.lastDamage}% HP`;
        }
      } else if (type === 42 && buffer.byteLength === 12) {
        const victimId = u32(view, 4);
        const attackerId = u32(view, 8);
        if (attackerId === state.game.ownedPlayerId && victimId !== attackerId) {
          const t = performance.now();
          const feedback = state.feedback;
          if (feedback.lastKillId !== victimId || t - feedback.lastKillMs > 700) {
            feedback.lastKillId = victimId;
            feedback.lastKillMs = t;
            feedback.flashAt = t;
            playShatterSfx();
            if (hitLabel) hitLabel.textContent = 'KILL CONFIRMED';
            if (comboMeter) {
              comboMeter.classList.remove('hg-pop');
              void comboMeter.offsetWidth;
              comboMeter.classList.add('hg-pop');
            }
            log('server-kill-sfx', { victimId });
          }
        }
        if (attackerId === state.game.ownedPlayerId &&
            victimId === state.feedback.targetId &&
            performance.now() - state.feedback.lastHitMs < 2000 && hitLabel)
          hitLabel.textContent = 'SERVER VERIFIED KILL';
      } else if (
        type === 15 &&
        buffer.byteLength >= 12
      ) {
        const id = u32(view, 4);
        const action = u32(view, 8);

        if (action === 4)
          player(id).alive = false;

        log('player-action', {
          id,
          action
        });
      }

    } catch (error) {
      state.counters.decodeErrors++;

      log('decode-error', {
        error: String(error)
      });
    }
  }

  function observeData(
    data, direction, socketId
  ) {
    if (data instanceof ArrayBuffer) {
      observeBuffer(
        data,
        direction,
        socketId
      );

    } else if (ArrayBuffer.isView(data)) {
      observeBuffer(
        data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength
        ),
        direction,
        socketId
      );

    } else if (data instanceof Blob) {
      data.arrayBuffer()
        .then(buffer =>
          observeBuffer(
            buffer,
            direction,
            socketId
          )
        )
        .catch(error => {
          state.counters.decodeErrors++;

          log('blob-error', {
            error: String(error)
          });
        });
    }
  }

  const NativeWS = window.WebSocket;

  if (typeof NativeWS === 'function') {
    const ids = new WeakMap();
    let nextId = 1;

    function ObservedWebSocket(...args) {
      const ws = new NativeWS(...args);
      const id = nextId++;

      ids.set(ws, id);

      keep(state.sockets, {
        id,
        url: String(args[0] ?? ''),
        at: now()
      }, 20);

      ws.addEventListener(
        'message',
        event => observeData(
          event.data,
          'inbound',
          id
        )
      );

      ws.addEventListener('close', () => {
        state.game.started = false;
        state.settings.clearFog = false;
        state.game.reason = 'socket closed';
        state.settings.projectionVerified = false;
      });

      return ws;
    }

    Object.setPrototypeOf(
      ObservedWebSocket,
      NativeWS
    );

    ObservedWebSocket.prototype =
      NativeWS.prototype;

    const nativeSend =
      NativeWS.prototype.send;

    NativeWS.prototype.send = function(data) {
      observeData(
        data,
        'outbound',
        ids.get(this) || 0
      );

      return nativeSend.apply(
        this,
        arguments
      );
    };

    window.WebSocket = ObservedWebSocket;
  }

  // Column-major matrices: projectionMatrix * viewMatrix * worldPosition.
  function project(point, view, projection, width, height) {
    if (!Array.isArray(point) || point.length !== 3 ||
        !view || !projection ||
        view.length !== 16 || projection.length !== 16 ||
        ![...point, ...view, ...projection, width, height]
          .every(finite) ||
        width <= 0 || height <= 0) return null;

    const mul = (matrix, vector) =>
      [0, 1, 2, 3].map(row =>
        matrix[row] * vector[0] +
        matrix[4 + row] * vector[1] +
        matrix[8 + row] * vector[2] +
        matrix[12 + row] * vector[3]
      );
    const clip = mul(
      projection, mul(view, [...point, 1])
    );
    if (!clip.every(finite) || clip[3] <= 0) return null;

    const x = clip[0] / clip[3];
    const y = clip[1] / clip[3];
    const z = clip[2] / clip[3];
    return {
      x: (x + 1) * width / 2,
      y: (1 - y) * height / 2,
      depth: z,
      visible: Math.abs(x) <= 1 &&
               Math.abs(y) <= 1 &&
               Math.abs(z) <= 1
    };
  }

  function worldToScreen(point) {
    const invalid = cameraValidity();
    if (invalid) return null;
    const view = state.camera.view;
    const projection = state.camera.projection;
    if (!view || !projection || !view.rect ||
        !projection.rect ||
        view.rect.width <= 0 || view.rect.height <= 0)
      return null;

    const sameCanvas =
      view.canvasId != null &&
      view.canvasId === projection.canvasId &&
      view.canvasWidth === projection.canvasWidth &&
      view.canvasHeight === projection.canvasHeight &&
      Math.abs(view.t - projection.t) < 120;
    const age = performance.now() -
      Math.min(view.t, projection.t);
    if (!sameCanvas || age > MATRIX_MAX_AGE_MS) return null;

    const r = view.rect;
    const projected = project(
      point, view.matrix, projection.matrix, r.width, r.height
    );
    if (!projected) return null;
    return {
      x: r.left + projected.x,
      y: r.top + projected.y,
      depth: projected.depth,
      visible: projected.visible,
      confidence: state.settings.projectionVerified
        ? 'user-checked' : 'candidate'
    };
  }

  function cameraValidity(t = performance.now()) {
    const view = state.camera.view;
    const projection = state.camera.projection;
    if (!view || !projection) return 'view/projection matrix missing';
    if (!view.rect || !projection.rect) return 'canvas rectangle unavailable';
    if (view.canvasId == null || view.canvasId !== projection.canvasId)
      return 'camera canvas changed';
    if (view.canvasWidth !== projection.canvasWidth ||
        view.canvasHeight !== projection.canvasHeight)
      return 'camera canvas dimensions disagree';
    if (Math.abs(view.t - projection.t) >= 120)
      return 'view/projection captures are not synchronized';
    if (t - Math.min(view.t, projection.t) > MATRIX_MAX_AGE_MS)
      return 'camera matrices stale';
    if (view.rect.width <= 0 || view.rect.height <= 0 ||
        projection.rect.width <= 0 || projection.rect.height <= 0)
      return 'camera rectangle has no area';
    if (view.matrix.length !== 16 || projection.matrix.length !== 16 ||
        ![...view.matrix, ...projection.matrix].every(finite))
      return 'camera matrix invalid';
    return null;
  }

  function chooseTargetWithHysteresis(candidates, previousId, thresholdPx) {
    let best = null;
    for (const candidate of candidates.values())
      if (!best || candidate.offset < best.offset) best = candidate;
    const previous = previousId == null ? null : candidates.get(previousId);
    if (previous && best && previous.p.id !== best.p.id &&
        best.offset + thresholdPx >= previous.offset)
      return previous;
    return best;
  }

  function revokeProjection(reason) {
    if (state.settings.projectionVerified) {
      state.settings.projectionVerified = false;
      log('projection-revoked', { reason });
    }
    state.cameraInvalidReason = reason;
    const checkbox = panel?.querySelector?.(
      'input[data-setting="projectionVerified"]'
    );
    if (checkbox) checkbox.checked = false;
  }
  function selectRangeTarget(t) {
    const result = state.rangefinder;
    const previousTargetId = result.targetId;
    result.targetId = null;
    result.distance = null;
    result.screenOffsetPx = null;
    result.teamStatus = 'unknown';
    result.lifeStatus = 'unknown';
    result.projectionStatus = state.settings.projectionVerified
      ? 'user-checked' : 'unverified';
    result.occlusion = 'unknown';
    result.trajectory = null;
    result.nominalHit = false;
    result.aimTier = 'none';
    result.nearMiss = null;
    result.correction = null;
    result.hitScreen = null;

    const ownedId = state.game.ownedPlayerId;
    const own = state.players[ownedId];
    const inbound = state.movement.inboundLastById[ownedId];
    const outbound = state.movement.outboundLastById[ownedId];
    const localAge = own && finite(own.lastSeenMs)
      ? Math.max(0, t - own.lastSeenMs) : null;
    result.localDebug = {
      ownedId,
      recordExists: !!own,
      positionAvailable: !!own?.position,
      positionAgeMs: localAge,
      lastMovementUpdate: own?.lastSeenAt || null,
      inboundMovementIds: state.movement.inboundIds.slice(),
      outboundMovementIds: state.movement.outboundIds.slice(),
      inboundOwnedUpdate: inbound?.at || null,
      outboundOwnedUpdate: outbound?.at || null,
      inboundOwnedAgeMs: inbound ? Math.max(0, t - inbound.t) : null,
      outboundOwnedAgeMs: outbound ? Math.max(0, t - outbound.t) : null,
      positionSource: own?.positionSource || 'unavailable',
      outboundPositionCandidate: !!outbound,
      outboundCandidateValidated: false
    };

    if (!own || !own.position ||
        !finite(own.lastSeenMs) ||
        localAge > TARGET_MAX_AGE_MS) {
      const outboundFresh = outbound && t - outbound.t <= TARGET_MAX_AGE_MS;
      result.status = outboundFresh
        ? 'local inbound position missing; outbound type-4 candidate needs validation'
        : !own
          ? 'local player record missing; inspect movement IDs below'
          : !own?.position
            ? 'local position missing; bounds or movement decode unavailable'
            : 'local position stale; no fresh inbound type-4 sample';
      return;
    }

    state.cameraInvalidReason = cameraValidity(t) || '';

    if (!state.settings.projectionVerified) {
      result.status = 'check K markers, then confirm projection';
      return;
    }

    if (own.teamId == null) {
      result.teamStatus = 'local team unknown: no creation or team update observed';
      result.status = 'local team unknown; enemy aim withheld (inspect type-1/type-25 diagnostics)';
      return;
    }

    const eligible = new Map();
    let unknownTeamCount = 0;
    let unknownLifeCount = 0;
    let projectionFailures = 0;

    for (const p of Object.values(state.players)) {
      if (p.id === own.id || !p.position ||
          !finite(p.lastSeenMs) ||
          t - p.lastSeenMs > TARGET_MAX_AGE_MS ||
          p.alive === false) continue;

      if (p.teamId == null) {
        unknownTeamCount++;
        continue;
      }

      if (p.teamId === own.teamId) continue;

      // Unknown death state is allowed, but reported.
      if (p.alive == null) unknownLifeCount++;

      const q = worldToScreen(p.position);

      if (!q) {
        projectionFailures++;
        continue;
      }

      if (!q.visible) continue;

      const offset = Math.hypot(
        q.x - innerWidth / 2,
        q.y - innerHeight / 2
      );

      eligible.set(p.id, { p, q, offset });
    }

    const previousEligible = eligible.get(previousTargetId);
    const best = chooseTargetWithHysteresis(
      eligible,
      previousEligible?.offset <= TARGET_ACQUIRE_PX ? previousTargetId : null,
      TARGET_HYSTERESIS_PX
    );

    if (best && best.offset > TARGET_ACQUIRE_PX) {
      result.status = 'no confirmed opponent within 120 px of screen center';
      return;
    }

    if (!best) {
      result.status = projectionFailures
        ? 'camera projection unavailable'
        : unknownTeamCount
          ? 'no confirmed opponent; team unknown for some players'
          : 'no fresh projected opponent';

      if (unknownLifeCount)
        result.lifeStatus = 'some players unconfirmed';

      return;
    }

    result.targetId = best.p.id;
    result.distance = Math.hypot(
      best.p.position[0] - own.position[0],
      best.p.position[1] - own.position[1],
      best.p.position[2] - own.position[2]
    );
    result.screenOffsetPx = best.offset;
    result.teamStatus = `observed ${own.teamId} → ${best.p.teamId}`;
    result.lifeStatus = best.p.alive === true
      ? 'spawn observed' : 'unconfirmed';

    const ray = cameraRay();

    if (!ray) {
      result.status = 'camera ray unavailable';
      return;
    }

    const q = Math.hypot(
      best.p.position[0] - ray.origin[0],
      best.p.position[2] - ray.origin[2]
    );

    const nominal = q > 0 && q <= 250
      ? nominalPoint(ray, q)
      : null;

    const projected = nominal && worldToScreen(nominal);

    if (!projected || !projected.visible) {
      result.status = 'nominal trajectory projection unavailable';
      return;
    }

    result.trajectory = {
      x: projected.x,
      y: projected.y,
      q
    };

    const clearance = trajectoryClearance(ray, best.p.position);
    const intersection = clearance && clearance.clearance <= 0.45
      ? clearance : null;

    const hitProjection = intersection &&
      worldToScreen(intersection.point);

    result.nominalHit = !!(
      intersection &&
      hitProjection &&
      hitProjection.visible
    );

    result.hitScreen = result.nominalHit
      ? { x: hitProjection.x, y: hitProjection.y }
      : null;

    result.nearMiss = clearance?.clearance ?? null;
    result.aimTier = result.nominalHit ? 'solid' :
      clearance && clearance.clearance <= state.settings.nearHitTolerance
        ? 'hollow' : 'ivory';
    const targetScreen = worldToScreen([
      best.p.position[0], best.p.position[1] + 1, best.p.position[2]
    ]);
    const pathScreen = clearance && worldToScreen(clearance.point);
    if (targetScreen?.visible && pathScreen?.visible) {
      // Screen direction is a local guide only; bow origin and camera differ.
      const x = targetScreen.x - pathScreen.x;
      const y = targetScreen.y - pathScreen.y;
      result.correction = {x, y, label: `${x < -3 ? 'LEFT' : x > 3 ? 'RIGHT' : ''} ${y < -3 ? 'UP' : y > 3 ? 'DOWN' : ''}`.trim() || 'HOLD'};
    }
    result.status = result.aimTier === 'solid'
      ? 'estimated capsule intersection; spread/occlusion unknown'
      : result.aimTier === 'hollow'
        ? 'modeled near miss; adjust aim (estimate only)'
        : 'tracked opponent; modeled path misses substantially';
  }

  let root, canvas, ctx, status, summaryStatus, panel, launcher, closePanel;
  let calibrationToast, calibrationToastTimer, comboMeter, comboCount, comboFill, hitLabel;
  let healthBar, healthFill, healthNumber;
  let calibrationChangedAt = -10000;
  let projectionChangedAt = -10000;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  let texturePackStatus, texturePackInput, texturePackObserver, texturePackSelect, texturePackPreview, texturePackCustomControls;
  let activeTexturePack = null;
  let selectedTexturePack = 'vanilla';
  let textureDbPromise = null;
  const textureNodes = new Map();
  const textureUrls = [];
  const BUILTIN_TEXTURE_PACKS = {
    hologram: { name: 'Hologram', preview: '#743447' },
    pulsar: { name: 'Pulsar', preview: '#7898b7' },
    geo: { name: 'Geo', preview: '#244a35' }
  };
  const BUILTIN_TEXTURE_ART = {"menuUI/login.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Log in\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><circle cx=\"32\" cy=\"26\" r=\"7\" fill=\"#F2EADB\" stroke=\"#242028\" stroke-width=\"2.5\"/><path d=\"M18 48c2-8 7-12 14-12s12 4 14 12v3H18z\" fill=\"#F2EADB\" stroke=\"#242028\" stroke-width=\"2.5\"/><path d=\"M39 43h11m-5-5 5 5-5 5\" fill=\"none\" stroke=\"#A65B70\" stroke-width=\"3\"/></g></svg>","menuUI/settings.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Settings\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><path d=\"M32 17l5 3 6-1 3 6 5 4-2 7 1 6-6 4-3 6-7-1-6 1-4-6-6-3 1-7-1-6 6-4 3-6z\" fill=\"#F2EADB\" stroke=\"#242028\" stroke-width=\"2.5\"/><circle cx=\"32\" cy=\"33\" r=\"8\" fill=\"#743447\" stroke=\"#242028\" stroke-width=\"3\"/><circle cx=\"32\" cy=\"33\" r=\"2.5\" fill=\"#F2EADB\"/></g></svg>","menuUI/shopChest.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Shop\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><path d=\"M18 27l4-8h20l4 8v23H18z\" fill=\"#F2EADB\" stroke=\"#242028\" stroke-width=\"3\"/><path d=\"M18 28h28v9H18z\" fill=\"#743447\" stroke=\"#242028\" stroke-width=\"2.5\"/><path d=\"M29 35h6v9h-6z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2\"/><path d=\"M23 19l4 8m14-8-4 8\" stroke=\"#A65B70\" stroke-width=\"2\"/></g></svg>","menuUI/squad.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Squad\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><circle cx=\"32\" cy=\"25\" r=\"6\" fill=\"#F2EADB\" stroke=\"#242028\" stroke-width=\"2.5\"/><circle cx=\"19\" cy=\"30\" r=\"4.5\" fill=\"#D6C9C1\" stroke=\"#242028\" stroke-width=\"2\"/><circle cx=\"45\" cy=\"30\" r=\"4.5\" fill=\"#D6C9C1\" stroke=\"#242028\" stroke-width=\"2\"/><path d=\"M19 49v-5c0-7 5-11 13-11s13 4 13 11v5z\" fill=\"#F2EADB\" stroke=\"#242028\" stroke-width=\"2.5\"/><path d=\"M12 48v-4c0-5 3-8 8-8m32 12v-4c0-5-3-8-8-8\" fill=\"none\" stroke=\"#A65B70\" stroke-width=\"3\"/></g></svg>","menuUI/maps.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Maps\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><path d=\"M15 21l12-4 11 4 11-4v27l-11 4-11-4-12 4z\" fill=\"#F2EADB\" stroke=\"#242028\" stroke-width=\"2.5\"/><path d=\"M27 17v27m11-23v27\" stroke=\"#743447\" stroke-width=\"3\"/><path d=\"M18 39l7-8 6 3 8-9 8 4\" fill=\"none\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M39 25l3 1-2 3\" fill=\"none\" stroke=\"#242028\" stroke-width=\"2\"/></g></svg>","menuUI/fullScreen.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Full screen\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><path d=\"M19 28V19h9m8 0h9v9m0 8v9h-9m-8 0h-9v-9\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"4\"/><path d=\"M19 28l9-9m17 9-9-9m9 17-9 9m-17-9 9 9\" stroke=\"#A65B70\" stroke-width=\"2\"/></g></svg>","menuUI/exitFullScreen.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Exit full screen\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><path d=\"M19 27v-8h8m10 0h8v8m0 10v8h-8m-10 0h-8v-8\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"3.5\"/><path d=\"M21 21l10 10m12-10L33 31m10 12L33 33M21 43l10-10\" stroke=\"#A65B70\" stroke-width=\"3\"/></g></svg>","menuUI/download.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Download\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><path d=\"M32 17v23m-10-9 10 10 10-10M18 44v7h28v-7\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"4\"/><path d=\"M20 51h24\" stroke=\"#A65B70\" stroke-width=\"2.5\"/></g></svg>","menuUI/exit.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Exit\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><path d=\"M19 17h20v32H19z\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"3\"/><path d=\"M28 33h21m-8-8 8 8-8 8\" fill=\"none\" stroke=\"#A65B70\" stroke-width=\"4\"/><circle cx=\"24\" cy=\"33\" r=\"1.5\" fill=\"#F2EADB\"/></g></svg>","menuUI/hamburger.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Menu\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><path d=\"M19 22h26M19 32h26M19 42h26\" stroke=\"#F2EADB\" stroke-width=\"4\"/><path d=\"M19 22h7m-7 20h7\" stroke=\"#A65B70\" stroke-width=\"3\"/></g></svg>","rewardedAdIcon.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Reward\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><path d=\"M32 14l5.5 12.5L51 32l-13.5 5.5L32 51l-5.5-13.5L13 32l13.5-5.5z\" fill=\"#F2EADB\" stroke=\"#242028\" stroke-width=\"3\"/><path d=\"M32 22l3 7 7 3-7 3-3 7-3-7-7-3 7-3z\" fill=\"#A65B70\"/><path d=\"M47 15v8m-4-4h8\" stroke=\"#F2EADB\" stroke-width=\"2.5\"/></g></svg>","hudIcons/playerIcon.svg":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Player\"><g stroke-linecap=\"square\" stroke-linejoin=\"miter\"><path d=\"M16 7h30l11 11v28L46 57H16L7 48V16z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"2.5\"/><path d=\"M13 17h5M46 51h5\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\" opacity=\".75\"/><path d=\"M32 16l15 6v11c0 10-6 16-15 20-9-4-15-10-15-20V22z\" fill=\"#743447\" stroke=\"#F2EADB\" stroke-width=\"2.5\"/><circle cx=\"32\" cy=\"29\" r=\"5\" fill=\"#F2EADB\"/><path d=\"M22 43c1-6 4-9 10-9s9 3 10 9\" fill=\"#F2EADB\" stroke=\"#242028\" stroke-width=\"2.5\"/><path d=\"M28 24h8\" stroke=\"#A65B70\" stroke-width=\"2\"/></g></svg>"};
  const BUILTIN_TEXTURE_DATA = {"hologram":{"name":"Hologram \u00b7 Ivory / Graphite / Burgundy","logo":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 560 140\" role=\"img\" aria-label=\"Narrow One\"><path d=\"M14 16h520l22 22v64l-22 22H14L4 114V26z\" fill=\"#242028\" stroke=\"#A65B70\" stroke-width=\"4\"/><path d=\"M28 38h74l18 18v28l-18 18H28l-12-12V50z\" fill=\"#743447\" stroke=\"#F2EADB\" stroke-width=\"2\"/><path d=\"M43 88V49l42 41V50\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"7\"/><path d=\"M64 69h31\" stroke=\"#A65B70\" stroke-width=\"4\"/><text x=\"145\" y=\"79\" fill=\"#F2EADB\" font-family=\"ui-monospace,Menlo,Consolas,monospace\" font-size=\"52\" font-weight=\"800\" letter-spacing=\"5\">NARROW</text><text x=\"150\" y=\"111\" fill=\"#D6C9C1\" font-family=\"ui-monospace,Menlo,Consolas,monospace\" font-size=\"23\" font-weight=\"700\" letter-spacing=\"14\">ONE</text><path d=\"M315 108h176m-15-9 15 9-15 9\" fill=\"none\" stroke=\"#A65B70\" stroke-width=\"3\"/></svg>","coin":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Shattered glass coin\"><circle cx=\"32\" cy=\"32\" r=\"26\" fill=\"#743447\" stroke=\"#242028\" stroke-width=\"5\"/><circle cx=\"32\" cy=\"32\" r=\"19\" fill=\"none\" stroke=\"#F2EADB\" stroke-width=\"2\"/><path d=\"M31 10 35 27 47 22 38 31 48 38 36 36 32 53 28 38 17 44 25 33 16 27 28 28Z\" fill=\"#F2EADB\" stroke=\"#242028\" stroke-width=\"2\" stroke-linejoin=\"miter\"/><path d=\"m31 10 4 17-10 6m10-6 12-5M35 27l3 4 10 7m-13-2-7 2-4 11m4-11-11-11\" fill=\"none\" stroke=\"#242028\" stroke-width=\"2\"/><path d=\"m13 49 7-4m29-29 3-4\" stroke=\"#D6C9C1\" stroke-width=\"2\"/></svg>"},"pulsar":{"name":"Pulsar \u00b7 Electric White / Slate Blue","logo":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 560 140\" role=\"img\" aria-label=\"Narrow One\"><path d=\"M18 18h507l25 25v51l-25 25H18l16-23c18-27 18-44 0-55z\" fill=\"#18222E\" stroke=\"#7898B7\" stroke-width=\"4\"/><path d=\"M20 31c70 4 116 23 154 49 30 20 54 28 93 28h247\" fill=\"none\" stroke=\"#DCEcff\" stroke-width=\"4\" opacity=\".9\"/><path d=\"M26 43c49 9 86 27 118 49\" fill=\"none\" stroke=\"#7898B7\" stroke-width=\"8\"/><path d=\"M38 44h73l19 19v25l-19 19H38l-12-12V56z\" fill=\"#7898B7\" stroke=\"#F6FBFF\" stroke-width=\"2\"/><path d=\"M53 92V54l42 42V55\" fill=\"none\" stroke=\"#F6FBFF\" stroke-width=\"7\"/><text x=\"151\" y=\"83\" fill=\"#F6FBFF\" font-family=\"Arial,sans-serif\" font-size=\"54\" font-weight=\"900\" letter-spacing=\"1\">NARROW</text><text x=\"157\" y=\"112\" fill=\"#DCECFF\" font-family=\"Arial,sans-serif\" font-size=\"22\" font-weight=\"700\" letter-spacing=\"15\">ONE</text><path d=\"M456 27h55l20 20\" fill=\"none\" stroke=\"#DCECFF\" stroke-width=\"4\"/></svg>","coin":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Pulsar coin\"><circle cx=\"32\" cy=\"32\" r=\"26\" fill=\"#18222E\" stroke=\"#7898B7\" stroke-width=\"5\"/><circle cx=\"32\" cy=\"32\" r=\"20\" fill=\"none\" stroke=\"#DCECFF\" stroke-width=\"1.7\" opacity=\".8\"/><path d=\"M32 11 35 26 51 19 38 30 53 36 37 35 43 51 33 38 23 52 28 36 12 40 26 31 14 20 29 27Z\" fill=\"#F6FBFF\" stroke=\"#7898B7\" stroke-width=\"1.8\"/><circle cx=\"32\" cy=\"32\" r=\"5\" fill=\"#7898B7\" stroke=\"#F6FBFF\" stroke-width=\"2\"/><path d=\"M9 29c2-12 12-20 23-21m23 27c-2 12-12 20-23 21\" fill=\"none\" stroke=\"#DCECFF\" stroke-width=\"1.6\"/></svg>"},"geo":{"name":"Geo \u00b7 Greyscale / Deep Green","logo":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 560 140\" role=\"img\" aria-label=\"Narrow One\"><path d=\"M34 26c44-16 107-7 152-9 67-3 119 10 179 7 55-2 107-3 154 17 28 12 34 46 14 68-27 29-93 20-142 22-72 3-125-5-191-2-65 3-112 7-169-7-30-7-42-29-33-55 5-16 18-34 36-41z\" fill=\"#202522\" stroke=\"#557461\" stroke-width=\"4\"/><path d=\"M31 40c54-16 119 1 177-5 71-7 127 12 197 4 58-6 98-2 131 19M27 101c69-17 128 2 193-1 63-3 120 5 181 1 45-3 91 1 123 12\" fill=\"none\" stroke=\"#557461\" stroke-width=\"2\" opacity=\".72\"/><path d=\"M40 43c22-14 51-18 79-14 21 3 36 11 48 26 11 14 11 29-1 43-13 15-36 20-62 17-27-3-49-15-62-34-8-12-9-27-2-38z\" fill=\"#244A35\" stroke=\"#E8ECE7\" stroke-width=\"2\"/><path d=\"M59 89V53l43 38V54\" fill=\"none\" stroke=\"#E8ECE7\" stroke-width=\"6\"/><text x=\"185\" y=\"81\" fill=\"#E8ECE7\" font-family=\"Georgia,serif\" font-size=\"51\" font-weight=\"700\" letter-spacing=\"1\">NARROW</text><text x=\"190\" y=\"111\" fill=\"#BEC9C0\" font-family=\"Georgia,serif\" font-size=\"22\" font-weight=\"700\" letter-spacing=\"13\">ONE</text><path d=\"M423 104c30-13 57-14 90-3\" fill=\"none\" stroke=\"#557461\" stroke-width=\"3\"/></svg>","coin":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" role=\"img\" aria-label=\"Mountain coin\"><circle cx=\"32\" cy=\"32\" r=\"26\" fill=\"#244A35\" stroke=\"#202522\" stroke-width=\"5\"/><circle cx=\"32\" cy=\"32\" r=\"20\" fill=\"none\" stroke=\"#9DB7A3\" stroke-width=\"1.7\"/><path d=\"M10 43 23 25l7 9 7-13 17 22z\" fill=\"#E8ECE7\" stroke=\"#202522\" stroke-width=\"2\" stroke-linejoin=\"round\"/><path d=\"m23 25 4 6-5-1m15-9 4 7-5-2\" fill=\"none\" stroke=\"#557461\" stroke-width=\"2\"/><path d=\"M13 47c11-4 26-4 39 0m-34 4c9-3 20-3 30 0\" fill=\"none\" stroke=\"#9DB7A3\" stroke-width=\"1.5\" opacity=\".85\"/></svg>"},"vanilla":{"name":"Default Vanilla","logo":"","coin":"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><circle cx=\"32\" cy=\"32\" r=\"24\" fill=\"#f1c84b\" stroke=\"#8b6823\" stroke-width=\"4\"/><circle cx=\"32\" cy=\"32\" r=\"18\" fill=\"none\" stroke=\"#fff1a5\" stroke-width=\"2\"/><text x=\"32\" y=\"41\" text-anchor=\"middle\" fill=\"#8b6823\" font-family=\"Arial,sans-serif\" font-size=\"27\" font-weight=\"700\">N</text></svg>"}};
  const textureSelector = '#gameWrapper img, #gameWrapper #mainMenuLogo, ' +
    '#gameWrapper .coin-icon, #gameWrapper .buttonImage, ' +
    '#gameWrapper .dialog-button-icon, #gameWrapper .main-menu-promo-banner';

  function openTextureDb() {
    if (textureDbPromise) return textureDbPromise;
    textureDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('Local pack storage is unavailable'));
      const request = indexedDB.open('hologram-texture-packs', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('packs');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local pack storage'));
      request.onblocked = () => reject(new Error('Close another Narrow One tab, then retry'));
    });
    return textureDbPromise;
  }

  async function textureDbAction(action, value) {
    const db = await openTextureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('packs', action === 'get' ? 'readonly' : 'readwrite');
      const store = tx.objectStore('packs');
      const request = action === 'put' ? store.put(value, 'active') :
        action === 'delete' ? store.delete('active') : store.get('active');
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error || new Error('Texture pack storage failed'));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Texture pack storage failed'));
      tx.onabort = () => reject(tx.error || new Error('Texture pack storage was interrupted'));
    });
  }

  function normalizeTextureTarget(target) {
    const value = String(target).trim().replace(/^\/+/, '')
      .replace(/^static\/img\//i, '').toLowerCase();
    const allowed = /^(?:logo\.svg|coin\.svg|rewardedadicon\.svg|menuui\/[\w.-]+\.(?:svg|png|webp|jpg|jpeg|avif)|hudicons\/[\w.-]+\.(?:svg|png|webp|jpg|jpeg|avif)|loadscreen\/[\w.-]+\.(?:svg|png|webp|jpg|jpeg|avif)|(?:config\/)?promos\/[\w.-]+\.(?:svg|png|webp|jpg|jpeg|avif))$/i;
    if (!allowed.test(value)) throw new Error(`Unsupported texture target: ${target}`);
    return value;
  }

  const SETTING_LABELS = {
    opacity: 'HUD opacity', crosshair: 'Custom reticle', ladder: 'Reticle ladder',
    diagnostics: 'Diagnostics panel', performance: 'Performance stats',
    calibration: 'Calibration markers · K', projectionVerified: 'Projection verified · L',
    acm: 'ACM suspect markers', killSfx: 'Hit and kill sounds',
    clearFog: 'Clear fog · O', customSky: 'Burgundy sky',
    hidePassiveAds: 'Hide passive ads'
  };

  function textureForUrl(value) {
    let path;
    try { path = new URL(value, location.href).pathname.toLowerCase(); }
    catch { return null; }
    path = path.replace(/^\/static\/img\//, '').replace(/^\//, '');
    const directMatch = activeTexturePack?.textures.find(texture =>
      path === texture.target || path.endsWith(`/${texture.target}`) ||
      path.endsWith(texture.target)
    );
    if (directMatch) return directMatch;
    // The game renders its three menu title marks from variants such as
    // logo2.svg. Route only those logo assets through the pack's logo art.
    if (/^(?:[^/]+\/)*(?:logo|logo\d+)\.(?:svg|png|webp|jpe?g|avif)$/.test(path)) {
      return activeTexturePack?.textures.find(texture => texture.target === 'logo.svg') || null;
    }
    return null;
  }

  function restoreTextureNodes() {
    for (const [element, saved] of textureNodes) {
      if (saved.patchedSrc && element.getAttribute('src') === saved.patchedSrc) {
        if (saved.src == null) element.removeAttribute('src');
        else element.setAttribute('src', saved.src);
      }
      if (saved.patchedBackground && element.style.backgroundImage === saved.patchedBackground)
        element.style.backgroundImage = saved.background;
      if (saved.patchedFilter && element.style.filter === saved.patchedFilter)
        element.style.filter = saved.filter;
    }
    textureNodes.clear();
  }

  function applyTextureNode(element) {
    if (!(element instanceof Element)) return;
    const saved = textureNodes.get(element);
    const source = saved?.src ?? element.getAttribute('src');
    const isLogoSource = source && /(?:^|\/)logo\d*\.(?:svg|png|webp|jpe?g|avif)(?:$|[?#])/i.test(source);
    if (isLogoSource && element.id !== 'mainMenuLogo') {
      const primaryLogo = [...document.querySelectorAll('#gameWrapper img, #gameWrapper #mainMenuLogo')]
        .find(node => (node.id === 'mainMenuLogo') || /(?:^|\/)logo\d*\.(?:svg|png|webp|jpe?g|avif)(?:$|[?#])/i.test(node.getAttribute('src') || ''));
      if (primaryLogo && primaryLogo !== element) return;
    }
    if (activeTexturePack?.builtin && !activeTexturePack.textures.some(texture => texture.target === 'logo.svg') &&
        source && /(?:^|\/)logo\d*\.(?:svg|png|webp|jpe?g|avif)(?:$|[?#])/i.test(source)) {
      const paletteFilter = activeTexturePack.builtin === 'pulsar'
        ? 'brightness(0) saturate(100%) invert(86%) sepia(18%) saturate(372%) hue-rotate(171deg) brightness(101%) contrast(94%)'
        : activeTexturePack.builtin === 'geo'
          ? 'brightness(0) saturate(100%) invert(25%) sepia(16%) saturate(1162%) hue-rotate(89deg) brightness(93%) contrast(91%)'
          : 'brightness(0) saturate(100%) invert(24%) sepia(17%) saturate(1190%) hue-rotate(285deg) brightness(91%) contrast(90%)';
      const record = saved || { src: element.getAttribute('src'), background: element.style.backgroundImage,
        computedBackground: getComputedStyle(element).backgroundImage, filter: element.style.filter };
      element.style.filter = paletteFilter;
      record.patchedFilter = paletteFilter;
      textureNodes.set(element, record);
      return;
    }
    const sourceTexture = source ? textureForUrl(source) : null;
    const computedBackground = saved?.computedBackground ?? getComputedStyle(element).backgroundImage;
    let nextBackground = computedBackground.replace(/url\((?:"([^"]+)"|'([^']+)'|([^)]*))\)/g,
      (match, doubleQuoted, singleQuoted, bare) => {
        const texture = textureForUrl(doubleQuoted || singleQuoted || bare || '');
        return texture ? `url("${texture.url}")` : match;
      });
    if (!sourceTexture && nextBackground === computedBackground) return;
    const record = saved || {
      src: element.getAttribute('src'),
      background: element.style.backgroundImage,
      computedBackground
    };
    if (sourceTexture) {
      element.setAttribute('src', sourceTexture.url);
      record.patchedSrc = sourceTexture.url;
    }
    if (nextBackground !== computedBackground) {
      element.style.backgroundImage = nextBackground;
      record.patchedBackground = nextBackground;
    }
    textureNodes.set(element, record);
  }

  function applyTexturePack() {
    if (!activeTexturePack || !document.querySelector('#gameWrapper')) return;
    document.querySelectorAll(textureSelector).forEach(applyTextureNode);
  }

  function watchTextureNodes() {
    if (texturePackObserver || !activeTexturePack) return;
    const wrapper = document.querySelector('#gameWrapper');
    if (!wrapper) return;
    texturePackObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(textureSelector)) applyTextureNode(node);
        node.querySelectorAll?.(textureSelector).forEach(applyTextureNode);
      }
    });
    texturePackObserver.observe(wrapper, { childList: true, subtree: true });
  }

  function activateTexturePack(pack) {
    texturePackObserver?.disconnect();
    texturePackObserver = null;
    restoreTextureNodes();
    for (const url of textureUrls.splice(0)) URL.revokeObjectURL(url);
    activeTexturePack = pack || null;
    if (activeTexturePack) {
      for (const texture of activeTexturePack.textures) {
        texture.url = URL.createObjectURL(texture.blob);
        textureUrls.push(texture.url);
      }
      applyTexturePack();
      watchTextureNodes();
    }
    if (texturePackStatus) {
      const count = activeTexturePack?.textures.length || 0;
      texturePackStatus.textContent = activeTexturePack
        ? `${activeTexturePack.name} · ${count} texture${count === 1 ? '' : 's'} active`
        : 'Default Vanilla · original game textures';
    }
  }

  async function importTexturePack(fileList) {
    const files = [...fileList];
    if (files.length > 25) throw new Error('Select one manifest and at most 24 images');
    const manifests = files.filter(file => file.name.toLowerCase().endsWith('.json'));
    if (manifests.length !== 1) throw new Error('Select one pack.json and its image files together');
    if (manifests[0].size > 128 * 1024) throw new Error('The pack manifest must be under 128 KB');
    const manifest = JSON.parse(await manifests[0].text());
    const entries = Object.entries(manifest?.textures || {});
    if (!entries.length || entries.length > 24) throw new Error('The manifest needs 1–24 texture mappings');
    const fileByName = new Map(files.filter(file => file !== manifests[0]).map(file => [
      (file.webkitRelativePath || file.name).toLowerCase(), file
    ]));
    const packTextures = [];
    let totalBytes = 0;
    for (const [target, filenameValue] of entries) {
      const safeTarget = normalizeTextureTarget(target);
      const filename = String(filenameValue).replace(/^\/+/, '').toLowerCase();
      const file = fileByName.get(filename) || fileByName.get(filename.split('/').pop());
      if (!file) throw new Error(`Missing image file: ${filenameValue}`);
      const mime = file.type || ({svg:'image/svg+xml',png:'image/png',webp:'image/webp',jpg:'image/jpeg',jpeg:'image/jpeg',avif:'image/avif'}[file.name.split('.').pop().toLowerCase()] || '');
      if (!/^image\/(?:svg\+xml|png|jpeg|webp|avif)$/.test(mime))
        throw new Error(`${file.name} must be an SVG, PNG, JPEG, WebP, or AVIF image`);
      if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} exceeds the 8 MB per-image limit`);
      totalBytes += file.size;
      if (totalBytes > 32 * 1024 * 1024) throw new Error('The texture pack exceeds the 32 MB total limit');
      const blob = file.type === mime ? file : new Blob([file], { type: mime });
      packTextures.push({ target: safeTarget, filename: file.name, mime, blob });
    }
    return {
      name: String(manifest.name || 'Local texture pack').slice(0, 48),
      textures: packTextures
    };
  }

  async function restoreTexturePack() {
    try {
      const pack = await textureDbAction('get');
      if (pack?.textures?.length) {
        selectedTexturePack = pack.builtin || 'custom';
        activateTexturePack(pack);
      }
      updateTexturePackSelector();
    } catch (error) {
      if (texturePackStatus) texturePackStatus.textContent = error.message;
    }
  }

  function updateTexturePackSelector() {
    if (texturePackSelect) texturePackSelect.value = selectedTexturePack;
    if (texturePackCustomControls) texturePackCustomControls.hidden = false;
    if (root) root.dataset.theme = selectedTexturePack === 'custom' ? 'hologram' : selectedTexturePack;
    if (texturePackPreview) {
      const color = selectedTexturePack === 'vanilla' ? '#d7b443' :
        BUILTIN_TEXTURE_PACKS[selectedTexturePack]?.preview || '#743447';
      texturePackPreview.style.setProperty('--hg-coin-color', color);
      const coin = BUILTIN_TEXTURE_DATA[selectedTexturePack]?.coin;
      texturePackPreview.style.backgroundImage = coin ? `url(\"data:image/svg+xml,${encodeURIComponent(coin)}\")` : activeTexturePack?.textures.find(texture => texture.target === 'coin.svg')?.url ? `url(\"${activeTexturePack.textures.find(texture => texture.target === 'coin.svg').url}\")` : '';
      texturePackPreview.style.backgroundSize = 'cover';
      texturePackPreview.dataset.pack = selectedTexturePack;
      texturePackPreview.setAttribute('aria-label', `${activeTexturePack?.name || BUILTIN_TEXTURE_DATA[selectedTexturePack]?.name || 'Texture pack'} coin preview`);
    }
  }

  async function loadBuiltinTexturePack(id) {
    if (id === 'vanilla') {
      await textureDbAction('delete');
      selectedTexturePack = 'vanilla';
      activateTexturePack(null);
      updateTexturePackSelector();
      return;
    }
    const definition = BUILTIN_TEXTURE_PACKS[id];
    const source = BUILTIN_TEXTURE_DATA[id];
    if (!definition || !source) throw new Error('Unknown texture pack');
    const textures = Object.entries({ ...BUILTIN_TEXTURE_ART, 'logo.svg': source.logo, 'coin.svg': source.coin })
      .map(([target, artwork]) => {
        let svg = artwork;
        if (id === 'pulsar' && target !== 'logo.svg' && target !== 'coin.svg') {
          svg = svg.replace(/#242028/gi, '#18222e').replace(/#743447/gi, '#7898b7')
            .replace(/#f2eadb/gi, '#f6fbff').replace(/#d6c9c1/gi, '#dcecff').replace(/#a65b70/gi, '#7898b7')
            .replace('M16 7h30l11 11v28L46 57H16L7 48V16z', 'M17 8h27c8 0 14 6 15 14v20c-1 9-7 15-16 15H19C10 57 6 51 7 43V23c0-8 3-13 10-15z')
            .replace('</svg>', '<path d="M13 22c9-8 17-10 28-8m-2 39c7-3 12-8 16-15" fill="none" stroke="#dcecff" stroke-width="1.6" opacity=".7"/></svg>');
        } else if (id === 'geo' && target !== 'logo.svg' && target !== 'coin.svg') {
          svg = svg.replace(/#242028/gi, '#202522').replace(/#743447/gi, '#244a35')
            .replace(/#f2eadb/gi, '#e8ece7').replace(/#d6c9c1/gi, '#bec9c0').replace(/#a65b70/gi, '#557461')
            .replace('M16 7h30l11 11v28L46 57H16L7 48V16z', 'M18 8c12-3 26 2 38 8 5 12 4 27 0 40-12 5-26 3-41 1C7 49 5 28 18 8z')
            .replace('</svg>', '<path d="M14 18c9-7 19-8 30-5m-31 37c12 5 24 6 38 2" fill="none" stroke="#bec9c0" stroke-width="1.5" opacity=".72"/></svg>');
        }
        const safeTarget = normalizeTextureTarget(target);
        const blob = new Blob([svg], { type: 'image/svg+xml' });
        return { target: safeTarget, filename: target, mime: blob.type, blob };
      });
    const pack = { name: source.name, builtin: id, textures };
    await textureDbAction('put', pack);
    selectedTexturePack = id;
    activateTexturePack(pack);
    updateTexturePackSelector();
  }

  function setLocalHealth(value, source) {
    if (!finite(value)) return;
    value = Math.max(0, Math.min(1, value));
    const previous = state.health.value;
    if (previous != null && Math.abs(value - previous) < 0.002) return;
    state.health.value = value;
    state.health.source = source;
    state.health.lastChangeMs = performance.now();
    if (previous == null) updateOverlayUI();
    if (!healthBar) return;
    healthBar.classList.toggle('hg-low', value <= 0.25);
    if (previous != null && value < previous - 0.01) {
      healthBar.classList.remove('hg-damage');
      void healthBar.offsetWidth;
      healthBar.classList.add('hg-damage');
    }
    healthFill.style.width = `${value * 100}%`;
    healthNumber.textContent = `${Math.round(value * 100)}%`;
    healthBar.setAttribute('aria-label', `CCIdeas health ${Math.round(value * 100)} percent`);
  }

  let nativeHealthFill = null;
  function syncNativeHealth() {
    if (!nativeHealthFill?.isConnected) nativeHealthFill = document.querySelector(
      '#gameWrapper .health-ui-container .health-ui-bar.clip:has(> .health-ui-bar.main)'
    );
    const nativeFill = nativeHealthFill;
    if (!nativeFill) return;
    const width = nativeFill.style.width;
    if (!width || !width.endsWith('%')) return;
    const value = Number.parseFloat(width) / 100;
    if (finite(value)) setLocalHealth(value, 'game HUD');
  }

  function resetHitFeedback() {
    Object.assign(state.feedback, {
      combo: 0, lastHitMs: 0, flashAt: -10000, targetId: null,
      lastHitKind: null, lastDamage: null, healthById: {},
      lastKillId: null, lastKillMs: -10000
    });
    comboMeter?.classList.remove('hg-active', 'hg-pop');
  }

  function registerConfirmedHit(victimId, kind) {
    const t = performance.now();
    const f = state.feedback;
    if (victimId === f.targetId && t - f.lastHitMs < 100) return;
    f.combo = t - f.lastHitMs < 4500 ? Math.min(f.combo + 1, 99) : 1;
    f.lastHitMs = t;
    f.flashAt = t;
    f.targetId = victimId;
    f.lastHitKind = kind;
    f.lastDamage = null;
    playConfirmedHitSfx(kind);
    log(`server-${kind}-hit`, { targetId: victimId, combo: f.combo });
    if (comboCount) comboCount.textContent = `${f.combo}×`;
    if (hitLabel) hitLabel.textContent = `${kind.toUpperCase()} HIT`;
    if (comboMeter) {
      comboMeter.classList.remove('hg-pop');
      void comboMeter.offsetWidth;
      comboMeter.classList.add('hg-pop');
    }
  }

  function showFeedback(message) {
    if (!calibrationToast) return;
    calibrationToast.textContent = message;
    calibrationToast.classList.remove('visible');
    void calibrationToast.offsetWidth;
    calibrationToast.classList.add('visible');
    clearTimeout(calibrationToastTimer);
    calibrationToastTimer = setTimeout(() => calibrationToast.classList.remove('visible'), 1400);
  }

  function fogFeedback() {
    showFeedback(state.settings.clearFog
      ? 'O  /  FOG CLEAR' : 'O  /  FOG RESTORED');
    updateOverlayUI();
  }

  function projectionFeedback() {
    projectionChangedAt = performance.now();
    showFeedback(state.settings.projectionVerified
      ? 'L  /  PROJECTION VERIFIED' : 'L  /  PROJECTION UNVERIFIED');
    updateOverlayUI();
  }

  function calibrationFeedback() {
    calibrationChangedAt = performance.now();
    showFeedback(state.settings.calibration
      ? 'K  /  CALIBRATION ON' : 'K  /  CALIBRATION OFF');
    updateOverlayUI();
  }

  function mount() {
    if (root || !document.body) return;

    root = document.createElement('div');
    root.id = 'hologram-v071';
    const style = document.createElement('style');
    style.textContent = `
      #hologram-v071, #hologram-v071 button, #hologram-v071 input { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      #hologram-v071 .hg-panel { box-shadow:0 18px 40px rgba(0,0,0,.42);backdrop-filter:blur(14px);clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,12px 100%,0 calc(100% - 12px));opacity:0;visibility:hidden;transform:translateY(7px);pointer-events:none;transition:opacity .2s ease,transform .22s ease,visibility 0s linear .22s; }
      #hologram-v071 .hg-panel summary { cursor:pointer;padding:9px 0;color:#e4c7c0;font-weight:700;letter-spacing:.14em;list-style:none;border-top:1px solid rgba(242,234,219,.18); }
      #hologram-v071 .hg-panel summary::-webkit-details-marker { display:none; }
      #hologram-v071 .hg-panel summary::before { content:'›'; display:inline-block; width:16px; color:#df9aaf; transition:transform .18s ease; }
      #hologram-v071 .hg-panel details[open] > summary::before { transform:rotate(90deg); }
      #hologram-v071 .hg-panel label { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:5px 0; cursor:pointer; }
      #hologram-v071 .hg-panel label input { accent-color:#d78ca3; }
      #hologram-v071 .hg-panel input[type=range] { width:108px; }
      #hologram-v071 .hg-panel input[type=checkbox] { border-radius:0; }
      #hologram-v071 .hg-panel::after { content:'';position:absolute;right:0;top:26px;width:3px;height:38px;background:#b9768c;pointer-events:none; }
      #hologram-v071 .hg-panel details[open] > summary { color:#f2eadb; }
      #hologram-v071 .hg-panel button, #hologram-v071 .hg-launcher { transition:background .18s ease, transform .18s ease, box-shadow .18s ease; }
      #hologram-v071 .hg-panel button:hover, #hologram-v071 .hg-launcher:hover { transform:translateY(-1px); box-shadow:0 4px 14px rgba(0,0,0,.2); }
      #hologram-v071 .hg-health { position:absolute;left:calc(env(safe-area-inset-left) + 60px);top:30px;width:270px;padding:9px 11px 11px;border:1px solid #98566a;border-radius:0;clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,0 100%);background:linear-gradient(145deg,rgba(31,33,39,.96),rgba(49,34,43,.95));box-shadow:0 10px 26px rgba(0,0,0,.34);color:#f2eadb;font:700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;letter-spacing:.14em;pointer-events:none;opacity:0;visibility:hidden;transition:opacity .18s ease,visibility 0s linear .18s; }
      #hologram-v071 .hg-health-head { display:flex;justify-content:space-between;align-items:center;margin-bottom:7px; }
      #hologram-v071 .hg-health-rail { position:relative;height:25px;overflow:hidden;border:1px solid rgba(242,234,219,.54);border-radius:0;background:#17191e; }
      #hologram-v071 .hg-health-fill { height:100%;width:0;background:linear-gradient(90deg,#71354b 0%,#a65b70 65%,#d994a5 100%);clip-path:polygon(0 0,100% 0,calc(100% - 7px) 100%,0 100%);box-shadow:inset 0 1px rgba(255,255,255,.22);transition:width .22s ease-out; }
      #hologram-v071 .hg-health-head::before { content:'▰';color:#bd7c91;margin-right:6px; }
      #hologram-v071 .hg-health-mark { position:absolute;inset:0;display:grid;place-items:center;color:#fff8ed;text-shadow:0 1px 3px #17191e,0 0 8px #17191e;font:900 15px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;letter-spacing:.04em; }
      #hologram-v071 .hg-health.hg-low .hg-health-rail { border-color:#e0a0b0;box-shadow:0 0 12px rgba(166,91,112,.45); }
      #hologram-v071 .hg-health.hg-damage { animation:hg-health-hit .32s ease-out; }
      @keyframes hg-health-hit { 40% { filter:brightness(1.55);transform:translateX(2px); } }
      body.hg-health-replaced #gameWrapper .health-ui-container { visibility:hidden !important; }
      body.hg-crosshair-replaced .crosshair-container,
      body.hg-crosshair-replaced .crosshair-line { visibility:hidden !important; }
      body.hg-hide-passive-ads #gameWrapper .game-ad-wrapper.desktop,
      body.hg-hide-passive-ads #gameWrapper .game-ad-wrapper.mobile { display:none !important; }
      @media (max-width:700px), (max-height:450px) { #hologram-v071 .hg-health { left:calc(env(safe-area-inset-left) + 60px);top:calc(env(safe-area-inset-top) + 15px);transform:scale(.5);transform-origin:top left; } }
      @media (max-width:400px) { #hologram-v071 .hg-health { width:240px; } }
      #hologram-v071 .hg-combo { position:absolute;top:18px;left:50%;transform:translate(-50%,-5px);width:172px;padding:8px 12px;border:1px solid rgba(185,125,148,.5);border-radius:0;clip-path:polygon(0 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%);background:linear-gradient(135deg,rgba(26,28,34,.92),rgba(67,36,49,.9));box-shadow:0 8px 26px rgba(0,0,0,.28);color:#f2eadb;text-align:center;font:700 10px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;letter-spacing:.15em;pointer-events:none;opacity:0;transition:opacity .2s ease,transform .22s ease; }
      #hologram-v071 .hg-combo.hg-active { opacity:1;transform:translate(-50%,0); }
      #hologram-v071 .hg-combo strong { display:block;font:800 24px/1.1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;letter-spacing:0;margin:2px 0; }
      #hologram-v071 .hg-combo .hg-track { height:3px;margin-top:7px;background:rgba(242,234,219,.15);border-radius:0;overflow:hidden; }
      #hologram-v071 .hg-combo .hg-fill { display:block;height:100%;width:0;background:#e0a0b0; }
      #hologram-v071 .hg-combo.hg-pop { animation:hg-pop .22s ease-out; }
      #hologram-v071 .hg-toast { position:absolute;left:50%;top:102px;transform:translate(-50%,6px);opacity:0;pointer-events:none;padding:7px 12px;border:1px solid rgba(242,234,219,.35);border-radius:0;clip-path:polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,0 100%);background:rgba(20,22,28,.88);color:#f2eadb;font:700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;letter-spacing:.15em;transition:opacity .22s ease,transform .22s ease; }
      #hologram-v071 .hg-toast.visible { opacity:1;transform:translate(-50%,0); }
      #hologram-v071 .hg-panel.hg-open { opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto;transition:opacity .2s ease,transform .22s ease,visibility 0s; }
      #hologram-v071 .hg-launcher.hg-open { border-color:#e0a0b0;background:rgba(71,40,53,.95); }
      #hologram-v071 .hg-health.hg-visible { opacity:1;visibility:visible;transition:opacity .18s ease,visibility 0s; }
      @keyframes hg-pop { 50% { transform:translate(-50%,0) scale(1.025); } }
      @media (max-width:920px) { #hologram-v071 .hg-combo { top:76px; } #hologram-v071 .hg-toast { top:158px; } }
      #hologram-v071[data-theme="hologram"] .hg-panel { border-radius:0!important;clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,12px 100%,0 calc(100% - 12px))!important; }
      #hologram-v071[data-theme="hologram"] .hg-panel::after { width:3px;height:38px;top:26px;right:0;background:#b9768c; }
      #hologram-v071[data-theme="hologram"] .hg-combo { border-radius:0;clip-path:polygon(0 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%); }
      #hologram-v071[data-theme="pulsar"] { --hg-accent:#a8dcff;--hg-line:#7898b7;--hg-surface:rgba(20,31,45,.97);--hg-fill:#a8dcff; }
      #hologram-v071[data-theme="pulsar"] .hg-panel { border-radius:24px 5px 24px 5px!important;clip-path:none!important;border-color:#7898b7!important;background:linear-gradient(135deg,rgba(17,29,44,.98),rgba(31,48,67,.97))!important;color:#f6fbff!important;font-family:Inter,ui-sans-serif,system-ui,sans-serif!important; }
      #hologram-v071[data-theme="pulsar"] .hg-panel::after { width:52px;height:5px;top:0;right:24px;transform:skewX(-34deg);background:linear-gradient(90deg,#7898b7,#dcecff); }
      #hologram-v071[data-theme="pulsar"] .hg-panel summary { color:#c6e6ff;border-color:rgba(168,220,255,.28); }
      #hologram-v071[data-theme="pulsar"] .hg-panel summary::before { color:#a8dcff; }
      #hologram-v071[data-theme="pulsar"] .hg-health { border-radius:16px 4px 16px 4px;border-color:#7898b7;background:linear-gradient(125deg,rgba(16,28,43,.97),rgba(43,66,88,.96)); }
      #hologram-v071[data-theme="pulsar"] .hg-health-rail { border-radius:8px 2px 8px 2px;border-color:rgba(220,236,255,.72); }
      #hologram-v071[data-theme="pulsar"] .hg-health-fill { clip-path:polygon(0 0,100% 0,calc(100% - 12px) 100%,0 100%);background:linear-gradient(105deg,#526f8c,#a8dcff 72%,#fff); }
      #hologram-v071[data-theme="pulsar"] .hg-combo { border-radius:20px 4px 20px 4px;clip-path:none;border-color:#7898b7;background:linear-gradient(115deg,rgba(13,26,42,.96),rgba(49,75,101,.96));color:#f6fbff; }
      #hologram-v071[data-theme="pulsar"] .hg-combo strong { font-size:28px;text-shadow:0 0 14px rgba(168,220,255,.45); }
      #hologram-v071[data-theme="pulsar"] .hg-combo .hg-fill { background:linear-gradient(90deg,#7898b7,#dcecff); }
      #hologram-v071[data-theme="pulsar"] .hg-toast { border-radius:16px 4px 16px 4px;border-color:#a8dcff;background:rgba(17,29,44,.95);color:#f6fbff; }
      #hologram-v071[data-theme="pulsar"] .hg-launcher { border-radius:16px 4px 16px 4px!important;clip-path:none!important;border-color:#7898b7!important;background:linear-gradient(110deg,rgba(19,32,48,.96),rgba(54,79,103,.96))!important;color:#f6fbff!important;font-family:Inter,ui-sans-serif,system-ui,sans-serif!important;font-weight:850!important; }
      #hologram-v071[data-theme="pulsar"] .hg-panel button,#hologram-v071[data-theme="pulsar"] .hg-panel select { border-radius:10px 3px!important;border-color:#7898b7!important;background:#1b2b3d!important;color:#f6fbff!important; }
      #hologram-v071[data-theme="geo"] { --hg-accent:#9db7a3;--hg-line:#557461;--hg-surface:rgba(30,39,33,.97);--hg-fill:#9db7a3; }
      #hologram-v071[data-theme="geo"] .hg-panel { border-radius:27px 10px 24px 9px!important;clip-path:none!important;border-color:#557461!important;background:linear-gradient(145deg,rgba(31,41,34,.98),rgba(24,32,27,.97))!important;color:#e8ece7!important;font-family:Georgia,ui-serif,serif!important; }
      #hologram-v071[data-theme="geo"] .hg-panel::after { width:4px;height:52px;top:28px;right:0;border-radius:50%;background:#557461; }
      #hologram-v071[data-theme="geo"] .hg-panel summary { color:#bec9c0;border-color:rgba(157,183,163,.25); }
      #hologram-v071[data-theme="geo"] .hg-panel summary::before { color:#9db7a3; }
      #hologram-v071[data-theme="geo"] .hg-health { border-radius:19px 6px 22px 8px;border-color:#557461;background:linear-gradient(145deg,rgba(31,41,34,.97),rgba(36,58,43,.95)); }
      #hologram-v071[data-theme="geo"] .hg-health-rail { border-radius:12px 4px 15px 5px;border-color:rgba(232,236,231,.55); }
      #hologram-v071[data-theme="geo"] .hg-health-fill { clip-path:none;border-radius:10px 4px 13px 4px;background:linear-gradient(90deg,#244a35,#557461 68%,#9db7a3); }
      #hologram-v071[data-theme="geo"] .hg-combo { border-radius:18px 5px 20px 7px;clip-path:none;border-color:#557461;background:linear-gradient(140deg,rgba(29,40,32,.96),rgba(39,62,44,.95));color:#e8ece7;font-family:Georgia,ui-serif,serif; }
      #hologram-v071[data-theme="geo"] .hg-combo .hg-fill { background:linear-gradient(90deg,#557461,#9db7a3); }
      #hologram-v071[data-theme="geo"] .hg-toast { border-radius:16px 5px 19px 6px;border-color:#557461;background:rgba(29,40,32,.96);color:#e8ece7; }
      #hologram-v071[data-theme="geo"] .hg-launcher { border-radius:18px 6px 20px 8px!important;clip-path:none!important;border-color:#557461!important;background:rgba(29,40,32,.95)!important;color:#e8ece7!important;font-family:Georgia,ui-serif,serif!important;letter-spacing:.08em!important; }
      #hologram-v071[data-theme="geo"] .hg-panel button,#hologram-v071[data-theme="geo"] .hg-panel select { border-radius:11px 4px 14px 5px!important;border-color:#557461!important;background:#26372b!important;color:#e8ece7!important; }
      @media (prefers-reduced-motion: reduce) { #hologram-v071 * { animation:none!important;transition:none!important; } }
    `;
    root.append(style);
    root.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;pointer-events:none';

    canvas = document.createElement('canvas');
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';

    ctx = canvas.getContext('2d');
    root.append(canvas);

    panel = document.createElement('section');
    panel.id = 'hologram-settings';
    panel.className = 'hg-panel';
    panel.setAttribute('aria-label', 'Hologram settings');
    panel.style.cssText =
      'position:absolute;left:16px;bottom:58px;width:286px;' +
      'max-width:calc(100vw - 24px);max-height:calc(100vh - 74px);' +
      'overflow:auto;background:linear-gradient(160deg,rgba(38,34,43,.95),rgba(19,22,29,.96));' +
      'color:#f2eadb;border:1px solid rgba(217,139,163,.55);border-radius:0;' +
      'font:11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    closePanel = document.createElement('button');
    closePanel.type = 'button';
    closePanel.textContent = '×';
    closePanel.title = 'Close Hologram settings';
    closePanel.style.cssText =
      'float:right;margin:3px 5px;background:transparent;color:#f2eadb;' +
      'border:0;font-size:18px;cursor:pointer;pointer-events:auto';

    closePanel.addEventListener('click', () => {
      state.ui.panelOpen = false;
      updateOverlayUI();
    });

    const head = document.createElement('div');
    head.style.cssText =
      'padding:12px 14px;background:linear-gradient(90deg,#763c56,#3b303b);border-bottom:1px solid #c08a99;font-weight:800;letter-spacing:.15em;font-size:11px';

    head.textContent = 'HOLOGRAM  /  LONGBOW';
    head.append(closePanel);

    status = document.createElement('div');
    status.style.cssText =
      'padding:10px 13px;white-space:pre-line;color:#c8c4c4;font:10px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    summaryStatus = document.createElement('div');
    summaryStatus.style.cssText = 'padding:13px 14px;white-space:pre-line;line-height:1.7;font:11px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    const details = document.createElement('details');
    details.style.cssText = 'padding:0 14px 7px';

    const summary = document.createElement('summary');
    summary.textContent = 'RETICLE';
    details.append(summary);
    const trackingDetails = document.createElement('details');
    trackingDetails.style.cssText = details.style.cssText;
    const trackingSummary = document.createElement('summary');
    trackingSummary.textContent = 'TRACKING';
    trackingDetails.append(trackingSummary);
    const systemDetails = document.createElement('details');
    systemDetails.style.cssText = details.style.cssText;
    const systemSummary = document.createElement('summary');
    systemSummary.textContent = 'SYSTEM';
    systemDetails.append(systemSummary);

    for (const [key, min, max, step] of [
      ['opacity', 0.2, 1, 0.05]
    ]) {
      const label = document.createElement('label');
      label.textContent = `${SETTING_LABELS[key] || key} `;

      const input = document.createElement('input');
      input.type = 'range';

      Object.assign(input, {
        min,
        max,
        step,
        value: state.settings[key]
      });

      input.addEventListener('input', () => {
        state.settings[key] = Number(input.value);
        persistSettings();
      });

      label.append(input);
      details.append(label);
    }

    const bowProfileLabel = document.createElement('label');
    bowProfileLabel.append('Ballistic profile');
    const bowProfileSelect = document.createElement('select');
    bowProfileSelect.setAttribute('aria-label', 'Bow or crossbow ballistic profile');
    bowProfileSelect.style.cssText = 'width:145px;padding:5px;background:#242028;color:#f2eadb;border:1px solid #98566a;font:10px ui-monospace,monospace';
    for (const [value, name] of Object.entries(bowProfileNames)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = name;
      bowProfileSelect.append(option);
    }
    bowProfileSelect.value = state.settings.bowProfile;
    bowProfileSelect.addEventListener('change', () => {
      state.settings.bowProfile = bowProfileSelect.value;
      state.ballistics.weaponCategory = bowProfileSelect.value;
      state.ballistics.status = `${bowProfileNames[bowProfileSelect.value].toUpperCase()} · FULL DRAW ASSUMED`;
      persistSettings();
      showFeedback(`BALLISTICS · ${bowProfileNames[bowProfileSelect.value].toUpperCase()}`);
    });
    bowProfileLabel.append(bowProfileSelect);
    details.append(bowProfileLabel);
    const bowProfileNote = document.createElement('div');
    bowProfileNote.style.cssText = 'padding:1px 0 7px;color:#aaa3a4;font-size:10px;line-height:1.4';
    bowProfileNote.textContent = 'Select your equipped bow. The shot data does not identify weapon type.';
    details.append(bowProfileNote);

    for (const key of [
      'crosshair',
      'ladder',
      'calibration',
      'diagnostics',
      'performance',
      'projectionVerified',
      'acm',
      'killSfx',
      'clearFog',
      'customSky',
      'hidePassiveAds'
    ]) {
      const label = document.createElement('label');
      const input = document.createElement('input');

      input.type = 'checkbox';
      input.dataset.setting = key;
      input.checked = state.settings[key];

      input.addEventListener('change', () => {
        changeSetting(key, input.checked);
        persistSettings();
        if (key === 'projectionVerified')
          log('projection-verification', { checkedByUser: input.checked });
      });

      label.append(document.createTextNode(SETTING_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1)), input);
      const section = ['crosshair', 'ladder'].includes(key) ? details :
        ['calibration', 'projectionVerified', 'acm'].includes(key) ? trackingDetails : systemDetails;
      section.append(label);
    }

    const note = document.createElement('div');
    note.style.cssText =
      'margin-top:5px;color:#d9c8c3';

    note.textContent =
      'Use K markers to check alignment; press L to verify only after they align with players ' +
      'during live play. Recheck after a match or camera change.';

    const toleranceLabel = document.createElement('label');
    toleranceLabel.textContent = 'Near-hit tolerance (world units) ';
    const toleranceValue = document.createElement('span');
    toleranceValue.textContent = state.settings.nearHitTolerance.toFixed(1);
    const toleranceInput = document.createElement('input');
    toleranceInput.type = 'range';
    Object.assign(toleranceInput, {min: 0.6, max: 3, step: 0.1,
      value: state.settings.nearHitTolerance});
      toleranceInput.addEventListener('input', () => {
        state.settings.nearHitTolerance = Number(toleranceInput.value);
        toleranceValue.textContent = state.settings.nearHitTolerance.toFixed(1);
        persistSettings();
    });
    toleranceLabel.append(toleranceInput, toleranceValue);
    trackingDetails.append(toleranceLabel);
    trackingDetails.append(note);

    const button = document.createElement('button');
    button.textContent = 'Copy diagnostics';

    button.style.cssText =
      'margin-top:6px;padding:6px 9px;background:#f2eadb;' +
      'color:#232529;border:0;border-radius:0;clip-path:polygon(0 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%);cursor:pointer';

    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(
          JSON.stringify(api.snapshot(), null, 2)
        );
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Use console snapshot()';
      }

      setTimeout(() => {
        button.textContent = 'Copy diagnostics';
      }, 2500);
    });

    systemDetails.append(button);

    const textureDetails = document.createElement('details');
    textureDetails.style.cssText = details.style.cssText;
    const textureSummary = document.createElement('summary');
    textureSummary.textContent = 'TEXTURE PACK';
    const texturePackPicker = document.createElement('label');
    texturePackPicker.style.cssText = 'display:grid;grid-template-columns:42px 1fr;align-items:center;gap:9px;padding:7px 0';
    texturePackPreview = document.createElement('span');
    texturePackPreview.setAttribute('aria-hidden', 'true');
    texturePackPreview.style.cssText = 'width:38px;height:38px;display:grid;place-items:center;background:var(--hg-coin-color);border:2px solid #17191e;border-radius:50%;box-shadow:inset 0 0 0 3px rgba(255,255,255,.34);position:relative;color:#fff;font:900 20px/1 ui-monospace,monospace;text-shadow:0 1px 2px rgba(0,0,0,.6)';
    texturePackPreview.style.backgroundImage = `url(\"data:image/svg+xml,${encodeURIComponent(BUILTIN_TEXTURE_DATA.vanilla.coin)}\")`;
    texturePackPreview.style.backgroundSize = 'cover';
    texturePackPreview.textContent = '';
    texturePackSelect = document.createElement('select');
    texturePackSelect.setAttribute('aria-label', 'Texture pack');
    texturePackSelect.style.cssText = 'width:100%;padding:7px 8px;background:#242028;color:#f2eadb;border:1px solid #98566a;border-radius:0;font:700 11px ui-monospace,monospace;letter-spacing:.06em';
    for (const [value, label] of [['vanilla','Default Vanilla'],['hologram','Hologram · Ivory / Graphite / Burgundy'],['pulsar','Pulsar · Electric White / Slate Blue'],['geo','Geo · Greyscale / Deep Green'],['custom','Custom local pack']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      texturePackSelect.append(option);
    }
    texturePackSelect.addEventListener('change', async () => {
      if (texturePackSelect.value === 'custom') {
        texturePackInput.click();
        texturePackSelect.value = selectedTexturePack === 'custom' ? 'custom' : 'vanilla';
        return;
      }
      texturePackStatus.textContent = 'Loading texture pack…';
      texturePackSelect.disabled = true;
      try {
        await loadBuiltinTexturePack(texturePackSelect.value);
      } catch (error) {
        texturePackStatus.textContent = error.message || 'Could not load texture pack';
        texturePackSelect.value = selectedTexturePack;
      } finally {
        texturePackSelect.disabled = false;
      }
    });
    texturePackPicker.append(texturePackPreview, texturePackSelect);
    texturePackStatus = document.createElement('div');
    texturePackStatus.style.cssText = 'padding:5px 0;color:#d9c8c3';
    texturePackStatus.textContent = 'Default Vanilla · original game textures';
    texturePackInput = document.createElement('input');
    texturePackInput.type = 'file';
    texturePackInput.multiple = true;
    texturePackInput.accept = '.json,application/json,image/*';
    texturePackInput.hidden = true;
    const textureLoadButton = document.createElement('button');
    textureLoadButton.type = 'button';
    textureLoadButton.textContent = 'Load local pack';
    textureLoadButton.style.cssText = 'margin:4px 6px 4px 0;padding:6px 9px;background:#f2eadb;color:#232529;border:0;cursor:pointer';
    textureLoadButton.addEventListener('click', () => texturePackInput.click());
    const textureTemplateButton = document.createElement('button');
    textureTemplateButton.type = 'button';
    textureTemplateButton.textContent = 'Get manifest';
    textureTemplateButton.style.cssText = textureLoadButton.style.cssText;
    textureTemplateButton.addEventListener('click', () => {
      const template = {
        name: 'Ivory HUD',
        textures: { 'logo.svg': 'logo.png', 'menuUI/settings.svg': 'settings.png' }
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)],
        { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'pack.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const textureRemoveButton = document.createElement('button');
    textureRemoveButton.type = 'button';
    textureRemoveButton.textContent = 'Remove pack';
    textureRemoveButton.style.cssText = textureLoadButton.style.cssText;
    textureRemoveButton.addEventListener('click', async () => {
      try {
        await textureDbAction('delete');
        selectedTexturePack = 'vanilla';
        activateTexturePack(null);
        updateTexturePackSelector();
        texturePackStatus.textContent = 'Default Vanilla · original game textures';
      } catch (error) {
        texturePackStatus.textContent = error.message;
      }
    });
    texturePackInput.addEventListener('change', async () => {
      if (!texturePackInput.files?.length) return;
      texturePackStatus.textContent = 'Reading local pack…';
      try {
        const pack = await importTexturePack(texturePackInput.files);
        await textureDbAction('put', pack);
        selectedTexturePack = 'custom';
        activateTexturePack(pack);
        updateTexturePackSelector();
      } catch (error) {
        texturePackStatus.textContent = error.message || 'Could not load texture pack';
      } finally {
        texturePackInput.value = '';
      }
    });
    const textureHelp = document.createElement('div');
    textureHelp.style.cssText = 'padding:3px 0 7px;color:#aaa3a4;font-size:10px;line-height:1.45';
    textureHelp.textContent = 'Use Get manifest to start, then select pack.json with its image files. Example: {"name":"Ivory","textures":{"logo.svg":"logo.png","menuUI/settings.svg":"settings.png"}}. Supports logo, coin, menuUI, hudIcons, loadScreen and promo images; 3D world textures are packed separately.';
    texturePackStatus.setAttribute('role', 'status');
    texturePackStatus.setAttribute('aria-live', 'polite');
    texturePackCustomControls = document.createElement('div');
    texturePackCustomControls.hidden = false;
    texturePackCustomControls.append(textureLoadButton, textureTemplateButton, textureRemoveButton,
      texturePackInput, textureHelp);
    textureDetails.append(textureSummary, texturePackPicker, texturePackStatus, texturePackCustomControls);

    const diagnosticDetails = document.createElement('details');
    diagnosticDetails.style.cssText = 'padding:0 14px 7px';
    const diagnosticSummary = document.createElement('summary');
    diagnosticSummary.textContent = 'DIAGNOSTICS';
    diagnosticDetails.append(diagnosticSummary, status);
    panel.append(head, summaryStatus, details, trackingDetails, systemDetails, textureDetails, diagnosticDetails);
    root.append(panel);


    healthBar = document.createElement('div');
    healthBar.className = 'hg-health';
    healthBar.setAttribute('role', 'meter');
    healthBar.innerHTML = '<div class="hg-health-head"><span>VITALS</span><span class="hg-health-number">--%</span></div><div class="hg-health-rail"><div class="hg-health-fill"></div><div class="hg-health-mark">CCIdeas</div></div>';
    healthFill = healthBar.querySelector('.hg-health-fill');
    healthNumber = healthBar.querySelector('.hg-health-number');
    root.append(healthBar);

    comboMeter = document.createElement('div');
    comboMeter.className = 'hg-combo';
    comboMeter.innerHTML = '<span>HIT STREAK</span><strong>0×</strong><span class="hg-hit-label">HIT CONFIRMED</span><div class="hg-track"><i class="hg-fill"></i></div>';
    comboCount = comboMeter.querySelector('strong');
    comboFill = comboMeter.querySelector('.hg-fill');
    hitLabel = comboMeter.querySelector('.hg-hit-label');
    root.append(comboMeter);

    calibrationToast = document.createElement('div');
    calibrationToast.className = 'hg-toast';
    root.append(calibrationToast);

    launcher = document.createElement('button');
    launcher.className = 'hg-launcher';
    launcher.type = 'button';
    launcher.setAttribute('aria-controls', 'hologram-settings');
    launcher.textContent = '▰  HOLOGRAM  /  K · L · O';

    launcher.style.cssText =
      'position:absolute;left:16px;bottom:16px;padding:9px 13px;' +
      'background:rgba(35,30,40,.9);color:#f2eadb;border:1px solid #b97d94;' +
      'border-radius:0;clip-path:polygon(0 0,calc(100% - 9px) 0,100% 9px,100% 100%,0 100%);font:700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;letter-spacing:.14em;'  +
      'pointer-events:auto;cursor:pointer';

    launcher.addEventListener('click', () => {
      state.ui.panelOpen = !state.ui.panelOpen;
      updateOverlayUI();
    });
    root.append(launcher);
    document.body.append(root);
    updateOverlayUI();
    restoreTexturePack();
  }

  function changeSetting(key, value) {
    if (state.settings[key] === value) return;
    state.settings[key] = value;
    persistSettings();
    if (key === 'calibration') calibrationFeedback();
    else if (key === 'projectionVerified') projectionFeedback();
    else if (key === 'clearFog') fogFeedback();
    else updateOverlayUI();
  }

  function reticleVisible() {
    if (state.settings.manual === 'hide') return false;
    if (state.settings.manual === 'show') return true;
    if (!state.game.started || state.game.ended ||
        !document.pointerLockElement) return false;
    const own = state.players[state.game.ownedPlayerId];
    return !own || own.alive !== false;
  }

  function syncReticleVisibility() {
    const visible = reticleVisible();
    const display = visible ? 'block' : 'none';
    if (canvas.style.display !== display) canvas.style.display = display;
    document.body.classList.toggle('hg-crosshair-replaced', visible && state.settings.crosshair);
    return visible;
  }

  function updateOverlayUI() {
    if (!root || !canvas) return;
    const locked = !!document.pointerLockElement;
    const inMatch = state.game.started && !state.game.ended;
    if (inMatch && locked) state.ui.panelOpen = false;
    syncReticleVisibility();
    const replaceHealth = state.game.started && !state.game.ended && state.health.value != null;
    healthBar?.classList.toggle('hg-visible', replaceHealth);
    document.body.classList.toggle('hg-health-replaced', replaceHealth);
    document.body.classList.toggle('hg-hide-passive-ads', state.settings.hidePassiveAds);
    panel.classList.toggle('hg-open', state.ui.panelOpen);
    launcher.classList.toggle('hg-open', state.ui.panelOpen);
    launcher.setAttribute('aria-expanded', String(state.ui.panelOpen));
    launcher.style.display = locked ? 'none' : 'block';
    if (status) status.style.display = state.settings.diagnostics ? 'block' : 'none';
    for (const input of panel.querySelectorAll('input[type="checkbox"][data-setting]'))
      input.checked = state.settings[input.dataset.setting];
  }

  document.addEventListener('keydown', event => {
    if (event.repeat) return;
    const target = event.target;
    if (target?.isContentEditable ||
        panel?.contains?.(target) ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName || ''))
      return;

    if (event.key.toLowerCase() === 'k') {
      changeSetting('calibration', !state.settings.calibration);
      log('calibration', {
        enabled: state.settings.calibration
      });
    } else if (event.key.toLowerCase() === 'l') {
      changeSetting('projectionVerified', !state.settings.projectionVerified);
      log('projection-verification', {
        checkedByUser: state.settings.projectionVerified,
        source: 'L hotkey'
      });
    } else if (event.key.toLowerCase() === 'o') {
      if (!state.game.started || state.game.ended) return;
      changeSetting('clearFog', !state.settings.clearFog);
      log('fog-toggle', { enabled: state.settings.clearFog });
    } else if (event.key === 'F8') {
      changeSetting('manual',
        state.settings.manual === 'auto' ? 'show' :
        state.settings.manual === 'show' ? 'hide' : 'auto');
      log('manual-visibility', {
        mode: state.settings.manual
      });
    }
  });

  document.addEventListener('pointerlockchange', updateOverlayUI);
  const invalidateViewport = reason => {
    revokeProjection(`${reason}; verify camera alignment again`);
    forceRectRefresh = true;
    for (const name of ['view', 'projection']) {
      const record = state.camera[name];
      if (record) record.rect = null;
    }
  };
  window.addEventListener('resize', () => invalidateViewport('viewport resized'));
  window.addEventListener('scroll', () => invalidateViewport('page scrolled'), true);

  let lastDraw = 0;
  let crosshairPitch = 0;
  let lastPitchUpdate = 0;
  let lastHealthSync = -1000;
  let drawCount = 0;
  let lastPacketCount = 0;
  let lastMatrixCount = 0;

  function draw(t) {
    requestAnimationFrame(draw);
    if (!root || !ctx) return;
    if (t - lastDraw < 33) return;
    lastDraw = t;
    const visible = syncReticleVisibility();
    if (comboMeter) {
      const age = t - state.feedback.lastHitMs;
      const active = state.feedback.combo > 0 && age < 4500 && visible;
      comboMeter.classList.toggle('hg-active', active);
      if (active && comboFill) comboFill.style.width = `${Math.max(0, 100 * (1 - age / 4500))}%`;
      if (state.feedback.combo && age >= 4500) state.feedback.combo = 0;
    }
    if (t - lastHealthSync >= 100) {
      syncNativeHealth();
      lastHealthSync = t;
    }
    if (!visible) return;

    const began = performance.now();
    selectRangeTarget(t);

    const ratio = Math.min(devicePixelRatio || 1, 2);
    const w = innerWidth;
    const h = innerHeight;
    const pixelW = Math.round(w * ratio);
    const pixelH = Math.round(h * ratio);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const flashAge = t - state.feedback.flashAt;
    const shake = flashAge >= 0 && flashAge < 210 && !reducedMotion?.matches
      ? (1 - flashAge / 210) * 2.6 : 0;
    ctx.translate(Math.sin(t * .19) * shake, Math.cos(t * .23) * shake);
    if (flashAge >= 0 && flashAge < 280) {
      const flashColor = selectedTexturePack === 'pulsar' ? '120,152,183' :
        selectedTexturePack === 'geo' ? '85,116,97' : '116,52,71';
      ctx.fillStyle = `rgba(${flashColor},${0.09 * (1 - flashAge / 280)})`;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalAlpha = state.settings.opacity;
    if (flashAge >= 0 && flashAge < 520) {
      const a = 1 - flashAge / 520;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 13 + 22 * (1 - a), 0, Math.PI * 2);
      const ringColor = selectedTexturePack === 'pulsar' ? '214,236,255' :
        selectedTexturePack === 'geo' ? '190,201,192' : '242,234,219';
      ctx.strokeStyle = `rgba(${ringColor},${a * .82})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Keep the center fixed while pitch moves the surrounding crosshair arms.
    const cx = w / 2;
    const cy = h / 2;
    const view = state.camera.view;
    const ownPlayer = state.players[state.game.ownedPlayerId];
    let aimPitch = null;
    if (view?.matrix && t - view.t < MATRIX_MAX_AGE_MS && finite(view.matrix[6]))
      aimPitch = Math.asin(Math.max(-1, Math.min(1, -view.matrix[6])));
    else if (ownPlayer && finite(ownPlayer.pitch) &&
             finite(ownPlayer.lastSeenMs) && t - ownPlayer.lastSeenMs < 500)
      aimPitch = ownPlayer.pitch;
    const targetPitch = aimPitch == null ? 0 : Math.max(-1, Math.min(1, aimPitch / (Math.PI / 2)));
    const pitchDt = lastPitchUpdate ? Math.max(0, Math.min(100, t - lastPitchUpdate)) : 33;
    crosshairPitch += (targetPitch - crosshairPitch) * (1 - Math.exp(-pitchDt / 110));
    if (targetPitch <= -0.985 && crosshairPitch <= -0.96) crosshairPitch = -1;
    lastPitchUpdate = t;

    function diamond(x, y, size, fill, outline = '#292b30') {
      ctx.beginPath();
      ctx.moveTo(x, y - size);
      ctx.lineTo(x + size, y);
      ctx.lineTo(x, y + size);
      ctx.lineTo(x - size, y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = outline;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const lockFlashAge = t - projectionChangedAt;
    const lockTint = state.settings.projectionVerified && !reducedMotion?.matches &&
      lockFlashAge >= 0 && lockFlashAge < 560
      ? Math.sin(Math.PI * lockFlashAge / 560) : 0;
    // Keep the image core fixed and vary only the ladder's vertical spacing.
    const ladderSpan = Math.max(0, crosshairPitch < 0
      ? 1 + crosshairPitch : 1 + 0.6 * crosshairPitch);
    const drawReticleLayer = (tinted, alpha) => {
      ctx.save();
      ctx.globalAlpha *= alpha;
      const themeArt = reticleArt[selectedTexturePack] || reticleArt.hologram;
      const core = tinted ? reticleArt.coreFlash : themeArt.core;
      if (state.settings.crosshair && core.complete && core.naturalWidth)
        ctx.drawImage(core, cx - 110, cy - 80, 220, 300);
      if (state.settings.ladder && ladderSpan > 0) {
        ctx.globalAlpha *= Math.min(1, ladderSpan * 4);
        const rungs = tinted ? reticleArt.ladderFlash : themeArt.ladder;
        if (rungs.complete && rungs.naturalWidth) {
          for (let i = 0; i < 5; i++) {
            const sourceY = 102 + i * 22 - 7;
            const rungY = cy + 22 + i * 22 * ladderSpan - 7;
            ctx.drawImage(rungs, 0, sourceY, 220, 14,
              cx - 110, rungY, 220, 14);
          }
        }
        ctx.beginPath();
        ctx.moveTo(cx, cy + 16);
        ctx.lineTo(cx, cy + 16 + 112 * ladderSpan);
        ctx.lineCap = 'butt';
        ctx.strokeStyle = '#242028';
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.strokeStyle = tinted ? '#b78cff' : selectedTexturePack === 'pulsar'
          ? '#7898b7' : selectedTexturePack === 'geo' ? '#557461' : '#d0c5be';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
      ctx.restore();
    };
    drawReticleLayer(false, 1);
    if (lockTint > 0) drawReticleLayer(true, lockTint);
    if (state.settings.crosshair && state.settings.projectionVerified) {
      ctx.save();
      ctx.globalAlpha *= reducedMotion?.matches ? 1 :
        Math.min(1, Math.max(0, lockFlashAge / 340));
      ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#242028';
      ctx.fillStyle = '#f2eadb';
      const labelY = cy + (state.settings.ladder ? 32 + 116 * ladderSpan : 147);
      ctx.strokeText('CALIBRATED', cx, labelY);
      ctx.fillText('CALIBRATED', cx, labelY);
      if (lockTint > 0) {
        ctx.globalAlpha *= lockTint;
        ctx.fillStyle = '#d4b5ff';
        ctx.fillText('CALIBRATED', cx, labelY);
      }
      ctx.restore();
    }

    const ownedId = state.game.ownedPlayerId;
    const own = state.players[ownedId];

    if (state.settings.calibration || state.settings.acm || state.settings.projectionVerified) {
      const calibrationAge = t - calibrationChangedAt;
      const entry = !state.settings.calibration || reducedMotion?.matches ? 1 : Math.min(1, Math.max(0, calibrationAge / 260));
      const ease = 1 - Math.pow(1 - entry, 3);
      ctx.save();
      ctx.globalAlpha *= ease;
      for (const p of Object.values(state.players)) {
        const acmFlight = state.settings.acm && p.acm.flightUntil > t;
        const acmAim = state.settings.acm && p.acm.aimUntil > t;
        if (!state.settings.calibration && !state.settings.projectionVerified &&
            !acmFlight && !acmAim) continue;
        if (!p.position || !finite(p.lastSeenMs) ||
            t - p.lastSeenMs > TARGET_MAX_AGE_MS) continue;

        // Movement positions are at the feet; the capsule torso is ~1u above.
        const q = worldToScreen([
          p.position[0], p.position[1] + 1, p.position[2]
        ]);
        if (!q || !q.visible) continue;

        const selected = p.id === state.rangefinder.targetId;
        const isOwn = p.id === ownedId;
        const sameTeam = !!own && p.teamId != null &&
          own.teamId != null && p.teamId === own.teamId;

        const fill = acmFlight || acmAim ? '#ff8200' : selected && state.rangefinder.nominalHit
          ? '#8f67d9'
          : selected || isOwn
            ? '#f2eadb'
            : sameTeam
              ? '#777b84'
              : own?.teamId != null && p.teamId != null
                ? '#743447'
                : '#d8aa58';

        const pulse = reducedMotion?.matches ? 0 : selected ? 1.2 * Math.sin(t / 260) : 0;
        diamond(q.x, q.y, (acmFlight || acmAim ? 9 : selected ? 7 : 5) + pulse, fill,
          acmFlight || acmAim ? '#fff1d6' : '#292b30');
        if (state.settings.calibration && !reducedMotion?.matches && calibrationAge >= 0 && calibrationAge < 1500) {
          for (let wave = 0; wave < 3; wave++) {
            const progress = (calibrationAge - wave * 260) / 760;
            if (progress < 0 || progress > 1) continue;
            const radius = 8 + progress * 38;
            ctx.save();
            ctx.globalAlpha = ease * (1 - progress) * 0.95;
            ctx.beginPath();
            ctx.moveTo(q.x, q.y - radius);
            ctx.lineTo(q.x + radius, q.y);
            ctx.lineTo(q.x, q.y + radius);
            ctx.lineTo(q.x - radius, q.y);
            ctx.closePath();
            ctx.lineWidth = 5;
            ctx.strokeStyle = '#2a2028';
            ctx.stroke();
            ctx.lineWidth = selected ? 3 : 2.5;
            ctx.strokeStyle = selected ? '#fff8e8' : '#dba2b4';
            ctx.stroke();
            ctx.restore();
          }
          if (calibrationAge < 500) {
            ctx.save();
            ctx.globalAlpha = ease * (1 - calibrationAge / 500);
            ctx.strokeStyle = '#fff8e8';
            ctx.lineWidth = 2.5;
            const arm = 12 + calibrationAge / 55;
            ctx.beginPath();
            ctx.moveTo(q.x - arm, q.y); ctx.lineTo(q.x - 7, q.y);
            ctx.moveTo(q.x + 7, q.y); ctx.lineTo(q.x + arm, q.y);
            ctx.moveTo(q.x, q.y - arm); ctx.lineTo(q.x, q.y - 7);
            ctx.moveTo(q.x, q.y + 7); ctx.lineTo(q.x, q.y + arm);
            ctx.stroke();
            ctx.restore();
          }
        }
        const lockAge = t - projectionChangedAt;
        if (state.settings.projectionVerified && !reducedMotion?.matches &&
            lockAge >= 0 && lockAge < 1250) {
          const progress = Math.min(1, lockAge / 650);
          const gap = 52 - 36 * (1 - Math.pow(1 - progress, 3));
          ctx.save();
          ctx.globalAlpha = Math.min(1, lockAge / 120) *
            (1 - Math.max(0, lockAge - 900) / 350);
          for (const [width, stroke] of [[7, '#2a2028'], [3.5, '#fff8e8']]) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = width;
            for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
              ctx.beginPath();
              ctx.moveTo(q.x + sx * (gap - 11), q.y + sy * gap);
              ctx.lineTo(q.x + sx * gap, q.y + sy * gap);
              ctx.lineTo(q.x + sx * gap, q.y + sy * (gap - 11));
              ctx.stroke();
            }
          }
          if (lockAge >= 520 && lockAge < 1050) {
            const flash = (lockAge - 520) / 530;
            const radius = 10 + flash * 30;
            ctx.globalAlpha *= 1 - flash;
            ctx.beginPath();
            ctx.moveTo(q.x, q.y - radius); ctx.lineTo(q.x + radius, q.y);
            ctx.lineTo(q.x, q.y + radius); ctx.lineTo(q.x - radius, q.y);
            ctx.closePath();
            ctx.strokeStyle = '#ffcfaa';
            ctx.lineWidth = 2.5;
            ctx.stroke();
          }
          ctx.restore();
        }

        let distanceLabel = null;
        if (state.settings.calibration && own?.position && finite(own.lastSeenMs) &&
            t - own.lastSeenMs <= TARGET_MAX_AGE_MS) {
          const distance = Math.hypot(
            p.position[0] - own.position[0],
            p.position[1] - own.position[1],
            p.position[2] - own.position[2]
          );
          if (finite(distance)) distanceLabel = `${distance.toFixed(1)} U`;
        }
        const acmLabel = acmFlight || acmAim
          ? `${acmFlight ? 'Flight' : ''}${acmFlight && acmAim ? ' / ' : ''}${acmAim ? 'Aim' : ''} ACM`
          : null;
        if (distanceLabel || acmLabel) {
          const offset = acmLabel ? 20 : selected ? 17 : 15;
          ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
          const distanceWidth = distanceLabel ? ctx.measureText(distanceLabel).width : 0;
          ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
          const acmWidth = acmLabel ? ctx.measureText(acmLabel).width : 0;
          const preferredFits = q.x - offset - distanceWidth >= 8 &&
            q.x + offset + acmWidth <= w - 8;
          const reversedFits = q.x - offset - acmWidth >= 8 &&
            q.x + offset + distanceWidth <= w - 8;
          const distanceOnLeft = acmLabel
            ? preferredFits || !reversedFits
            : q.x - offset - distanceWidth >= 8 ||
              q.x + offset + distanceWidth > w - 8;
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#09090b';
          if (distanceLabel) {
            ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
            ctx.textAlign = distanceOnLeft ? 'right' : 'left';
            ctx.fillStyle = '#f2eadb';
            const x = q.x + (distanceOnLeft ? -offset : offset);
            ctx.strokeText(distanceLabel, x, q.y + 4);
            ctx.fillText(distanceLabel, x, q.y + 4);
          }
          if (acmLabel) {
            ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
            ctx.textAlign = distanceOnLeft ? 'left' : 'right';
            ctx.fillStyle = '#ff8200';
            const x = q.x + (distanceOnLeft ? offset : -offset);
            ctx.strokeText(acmLabel, x, q.y + 4);
            ctx.fillText(acmLabel, x, q.y + 4);
          }
        }
      }
      ctx.restore();
    }
    drawCount++;

    const r = state.rangefinder;
    if (r.targetId != null && r.trajectory && r.aimTier !== 'none' &&
        state.settings.projectionVerified && !cameraValidity(t)) {
      const x = r.trajectory.x, y = r.trajectory.y;
      if (finite(x) && finite(y) && x >= 0 && x <= w && y >= 0 && y <= h) {
        const color = r.aimTier === 'ivory' ? '#f2eadb' : '#a36cf0';
        ctx.beginPath();
        ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y);
        ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath();
        const cuePulse = reducedMotion?.matches ? 0 : Math.sin(t / 310) * 1.2;
        ctx.lineWidth = 2; ctx.strokeStyle = color;
        ctx.translate(x, y);
        ctx.scale(1 + cuePulse / 16, 1 + cuePulse / 16);
        ctx.translate(-x, -y);
        if (r.aimTier === 'solid') {
          ctx.fillStyle = color; ctx.fill();
          ctx.strokeStyle = '#f2eadb';
        }
        ctx.stroke();
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      }
    }

    const elapsed = performance.now() - began;

    state.performance.hudRenderMs =
      0.8 * state.performance.hudRenderMs +
      0.2 * elapsed;
  }

  function renderStatus() {
    const t = performance.now();
    const invalidCamera = cameraValidity(t);

    state.cameraInvalidReason = invalidCamera || '';


    if (canvas?.style.display === 'none') selectRangeTarget(t);

    if (t - state.performance.lastSampleMs >= 1000) {
      const seconds =
        (t - state.performance.lastSampleMs) / 1000;

      const packets =
        state.counters.inboundFrames +
        state.counters.outboundFrames;

      state.performance.hudFps =
        Math.round(drawCount / seconds);

      state.performance.telemetryPerSecond =
        Math.round(
          (packets - lastPacketCount) / seconds
        );

      state.performance.matricesPerSecond =
        Math.round(
          (state.counters.matrixUpdates - lastMatrixCount) /
          seconds
        );

      state.performance.lastSampleMs = t;

      lastPacketCount = packets;
      lastMatrixCount = state.counters.matrixUpdates;

      drawCount = 0;

      for (const [id, p] of Object.entries(state.players)) {
        if (
          p.lastSeenMs &&
          t - p.lastSeenMs > 30000
        ) {
          delete state.players[id];
          delete state.feedback.healthById[id];
        }
      }
    }

    if (summaryStatus) {
      const r = state.rangefinder;
      const own = state.players[state.game.ownedPlayerId];
      const suspects = Object.values(state.players).filter(p =>
        p.acm.flightUntil > t || p.acm.aimUntil > t).length;
      summaryStatus.textContent = [
        `RETICLE  ${state.settings.manual.toUpperCase()} · F8`,
        `BALLISTICS  ${bowProfileNames[state.settings.bowProfile]} · full draw model`,
        `TRACKING  ${r.distance == null ? r.status : `${r.distance.toFixed(1)} units`}`,
        `TEAM  ${own?.teamId == null ? 'unknown' : `observed ${own.teamId}`} · ${r.teamStatus}`,
        `MODEL  ${r.aimTier} · clearance ${r.nearMiss == null ? 'n/a' : r.nearMiss.toFixed(2) + 'u'} · ${r.correction?.label || 'direction unavailable'}`,
        `PROJECTION  ${r.projectionStatus}`,
        `ACM  ${state.settings.acm ? `${suspects} movement/aim suspect${suspects === 1 ? '' : 's'}` : 'off'}`
      ].join('\n');
    }

    if (status && state.settings.diagnostics) {
      const range = state.rangefinder;
      const debug = range.localDebug || {};
      const last = state.arrows.at(-1);

      status.textContent = [
        `Sockets: ${state.sockets.length}`,
        `Packets In/Out: ` +
          `${state.counters.inboundFrames}/` +
          `${state.counters.outboundFrames}`,

        `Bounds: ${state.bounds ? 'observed' : 'waiting'}`,

        `Arrows 3/5: ` +
          `${state.counters.arrow3}/` +
          `${state.counters.arrow5}`,

        `Movement In/Out: ` +
          `${state.movement.inboundPackets}/` +
          `${state.movement.outboundPackets}`,

        `Tracked players: ${Object.keys(state.players).length}`,
        `Observed teams: ${JSON.stringify(Object.values(state.players).filter(p => p.teamId != null).map(p => ({id:p.id, team:p.teamId, source:p.teamSource, packetLength:p.teamPacketLength})).slice(0,16))}`,
        `Unknown team IDs: ${JSON.stringify(Object.values(state.players).filter(p => p.teamId == null).map(p => p.id).slice(0,16))}`,
        `Team packet shapes: ${JSON.stringify(Object.entries(state.packetShapes).filter(([k]) => k.startsWith('inbound:1:') || k.startsWith('inbound:25:')).slice(0,16))}`,

        `Owned player: ` +
          `${state.game.ownedPlayerId ?? 'unknown'}`,

        `Match: ${
          state.game.started && !state.game.ended
            ? 'started'
            : 'inactive'
        }`,

        `Camera: ${
          Object.keys(state.camera.candidates).join(', ') ||
          'waiting'
        }`,

        `Projection: ${range.projectionStatus}`,

        `Camera validity: ${
          state.cameraInvalidReason || 'candidate valid'
        }`,

        `K markers: ${
          state.settings.calibration ? 'on' : 'off'
        }`,

        range.distance == null
          ? `Range: ${range.status}`
          : `Range: ${range.distance.toFixed(1)} units`,

        `Target team: ${range.teamStatus}`,
        `Team schema: client type-1 creates; type-25 changes team; both [ID, team] u32`,
        `Team packets: ${state.teamDiagnostics.creations} creation / ${state.teamDiagnostics.changes} update / ${state.teamDiagnostics.repeats} repeat / ${state.teamDiagnostics.ownership} ownership`,
        `Team issues: ${state.teamDiagnostics.invalidIds} ID width / ${state.teamDiagnostics.malformed} malformed; ${state.teamDiagnostics.lastIssue || 'none'}`,
        `Near tolerance: ${state.settings.nearHitTolerance.toFixed(1)}u`,
        `Aim tier: ${range.aimTier}; clearance: ${range.nearMiss == null ? 'n/a' : range.nearMiss.toFixed(2) + 'u'}`,
        `Correction: ${range.correction?.label || 'unavailable'}`,

        `Target life: ${range.lifeStatus}`,

        `Nominal hit: ${
          range.nominalHit ? 'YES (estimated)' : 'no'
        }`,

        `Occlusion: unknown`,

        'LOCAL PLAYER DEBUG',

        `Owned ID: ${debug.ownedId ?? 'unknown'}`,

        `Record: ${debug.recordExists ? 'YES' : 'NO'}`,

        `Position: ${
          debug.positionAvailable ? 'YES' : 'NO'
        }`,

        `Position age: ${
          debug.positionAgeMs == null
            ? 'n/a'
            : `${debug.positionAgeMs.toFixed(0)} ms`
        }`,

        `Inbound IDs: ${
          JSON.stringify(debug.inboundMovementIds || [])
        }`,

        `Outbound IDs: ${
          JSON.stringify(debug.outboundMovementIds || [])
        }`,

        `Position source: ${
          debug.positionSource || 'unavailable'
        }`,

        last
          ? `Last arrow: ${last.type}`
          : 'Last arrow: waiting',

        `${bowProfileNames[state.settings.bowProfile]}: full draw assumed`,

        'Solid purple = estimated hit; hollow purple = path near miss; ivory = substantial miss',

        'Random spread and collisions are not accounted for',

        `F8 visibility: ${state.settings.manual}`
      ].join('\n');

      if (state.settings.performance) {
        status.textContent += '\n' + [
          'PERFORMANCE',
          `HUD FPS: ${state.performance.hudFps}`,
          `Packets/s: ${
            state.performance.telemetryPerSecond
          }`,
          `Matrix captures/s: ${
            state.performance.matricesPerSecond
          }`,
          `Render time: ${
            state.performance.hudRenderMs.toFixed(2)
          } ms`
        ].join('\n');
      }
    }
  }

  const api = Object.freeze({
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },

    arrowModel,

    decodeArrowPacket,

    decodeWorldBoundsPacket,

    worldToScreen,

    projectSynthetic: project,

    chooseTargetSynthetic(
      candidates,
      previousId,
      thresholdPx
    ) {
      return chooseTargetWithHysteresis(
        candidates,
        previousId,
        thresholdPx
      );
    },

    setSetting(key, value) {
      if (!Object.prototype.hasOwnProperty.call(
        state.settings,
        key
      )) {
        throw new RangeError('Unknown setting');
      }

      if (key === 'nearHitTolerance' && (!finite(value) || value < 0.6 || value > 3))
        throw new RangeError('Invalid near-hit tolerance');

      if (
        key === 'opacity' &&
        (
          !finite(value) ||
          value < 0.2 ||
          value > 1
        )
      ) {
        throw new RangeError('Invalid opacity');
      }

      if (
        key === 'manual' &&
        !['auto', 'show', 'hide'].includes(value)
      ) {
        throw new RangeError('Invalid visibility mode');
      }

      if (
        key !== 'manual' &&
        key !== 'opacity' &&
        key !== 'nearHitTolerance' &&
        typeof value !== 'boolean'
      ) {
        throw new RangeError('Expected boolean');
      }

      changeSetting(key, value);
    }
  });

  Object.defineProperty(
    window,
    '__hologramV071',
    {
      value: api,
      configurable: false
    }
  );

  if (document.body) {
    mount();
  } else {
    document.addEventListener(
      'DOMContentLoaded',
      mount,
      { once: true }
    );

    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        mount();
      }
    });

    observer.observe(
      document.documentElement,
      {
        childList: true,
        subtree: true
      }
    );
  }

  setInterval(renderStatus, 500);
  requestAnimationFrame(draw);

  log('observer-installed');

})();
