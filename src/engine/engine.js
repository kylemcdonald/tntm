import * as THREE from 'three';
import { mapView } from '../taumakoData.js';
import { skyDate } from '../astro.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import {
  blendPoses,
  eyeFromPose,
  eyePose,
  orbitFromPose,
  orbitPose,
  setObserverFraction,
  skyPose,
  viewMatrixForPose,
} from './camera.js';
import { makeProjector, raySphere, viewUniforms } from './projection.js';
import {
  applyVisualSettings,
  loadSkyImage,
  makeWorldSky,
  siderealRotation,
  skyBodyView,
  updateMoonLimb,
  updateSkyLabelsAndHits,
  updateSunAndMoon,
  updateWideLineResolutions,
} from './sky.js';
import { GlobeLayer } from './globe.js';

// One renderer and one camera for the whole scene. The "globe camera" is a free eye above the
// Earth (heading and tilt, no roll) and the "sky camera" stands on the deck; `blend` moves between
// the two poses, and the field of view decides how rectilinear or fisheye the single shared
// projection is.

export const MIN_GLOBE_FOV = 15;
export const MIN_SKY_FOV = 22;
export const MAX_FOV = 180;
const MODE_TRANSITION_MS = 1100;
const FOV_TRANSITION_MS = 520;
const FOCUS_TRANSITION_MS = 1200;
const WHEEL_FOV_RATE = 0.0008;
const WHEEL_DISTANCE_RATE = 0.0015;
const MIN_GLOBE_ALTITUDE = 0.00003;
const MAX_GLOBE_ALTITUDE = 8;
const MAX_ORBIT_PITCH = 89;
const MIN_TILT = -89.5;
const MAX_TILT = 80;
const GLOBE_SPACE_COLOR = new THREE.Color('#01031a');
const SKY_BACKGROUND_COLOR = new THREE.Color('#020934');

// Default framing, matching the original map view of the voyage looking south toward Vanuatu.
export const DEFAULT_GLOBE = eyeFromPose(orbitPose({
  lng: mapView.center[0],
  lat: mapView.center[1],
  distance: 0.13,
  pitch: mapView.pitch,
  bearing: mapView.bearing,
}));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function easeInOut(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function smootherStep(value) {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

// Map decorations fade over the middle of the transition.
function decorationFade(blend) {
  return 1 - smootherStep((clamp01(blend) - 0.1) / 0.8);
}

function normalizeDegrees(value) {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

function lerpEye(from, to, t) {
  return {
    lng: from.lng + normalizeDegrees(to.lng - from.lng) * t,
    lat: from.lat + (to.lat - from.lat) * t,
    altitude: from.altitude * (to.altitude / from.altitude) ** t,
    heading: from.heading + normalizeDegrees(to.heading - from.heading) * t,
    tilt: from.tilt + (to.tilt - from.tilt) * t,
  };
}

function formatNumber(value, digits) {
  return Number(value).toFixed(digits).replace(/\.?0+$/, '');
}

export function readViewHash(regularFov) {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const parse = (key, count) => {
    const values = params.get(key)?.split(',').map(Number);
    return values && values.length >= count && values.every(Number.isFinite) ? values : null;
  };
  const globe = parse('eye', 6);
  const sky = parse('sky', 3);
  return {
    globe: globe ? { lng: globe[0], lat: globe[1], altitude: globe[2], heading: globe[3], tilt: globe[4] } : null,
    globeFov: globe ? globe[5] : regularFov,
    sky: sky ? { yaw: sky[0], pitch: sky[1] } : null,
    skyFov: sky ? sky[2] : null,
    mode: params.get('mode') === 'sky' ? 'sky' : 'globe',
  };
}

export class SkyGlobeEngine {
  constructor(container, { settings, onSelect, onViewChange, onBlendChange }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onViewChange = onViewChange;
    this.onBlendChange = onBlendChange;
    this.state = { settings: settings ?? DEFAULT_SETTINGS };
    setObserverFraction(this.state.settings.boatPosition / 100);
    const view = readViewHash(this.state.settings.regularFov);
    this.globe = { ...DEFAULT_GLOBE, ...view.globe };
    this.globeFov = clamp(view.globeFov, MIN_GLOBE_FOV, MAX_FOV);
    this.sky = { yaw: 0, pitch: 0, ...view.sky };
    this.skyFov = clamp(view.skyFov ?? this.state.settings.wideFov, MIN_SKY_FOV, MAX_FOV);
    this.mode = view.mode;
    this.blend = this.mode === 'sky' ? 1 : 0;
    this.tweens = new Map();
    this.hitTargets = [];
    this.pointers = new Map();
    this.needsRender = true;
    this.lastViewKey = '';

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none';
    container.appendChild(this.canvas);

    this.camera = new THREE.Camera();
    this.worldSky = makeWorldSky();
    this.skyScene = new THREE.Scene();
    this.skyScene.add(this.worldSky.root);
    this.labelScene = new THREE.Scene();
    this.labelCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    this.worldSky.screenLabels.forEach(({ mesh }) => this.labelScene.add(mesh));
    loadSkyImage(this.worldSky.milkyWay, this.renderer, () => this.requestRender());
    this.globeLayer = new GlobeLayer(() => this.requestRender());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.bindInput();
    this.frame = this.frame.bind(this);
    this.rafId = requestAnimationFrame(this.frame);
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.hashTimer);
    this.resizeObserver.disconnect();
    this.unbindInput();
    this.globeLayer.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  requestRender() {
    this.needsRender = true;
  }

  setState(next) {
    const previous = this.state.settings;
    this.state = { ...this.state, ...next };
    const settings = this.state.settings;
    setObserverFraction((settings.boatPosition ?? DEFAULT_SETTINGS.boatPosition) / 100);
    // Editing the regular/wide FOV applies right away when that preset is active.
    if (previous && settings !== previous) {
      ['regularFov', 'wideFov'].forEach((key) => {
        if (previous[key] !== settings[key] && this.activePreset(previous) === key) {
          this.setModeFov(settings[key]);
        }
      });
    }
    this.requestRender();
  }

  // ---- camera state -------------------------------------------------------------------------

  get width() {
    return this.container.clientWidth || 1;
  }

  get height() {
    return this.container.clientHeight || 1;
  }

  modeFov() {
    return this.mode === 'sky' ? this.skyFov : this.globeFov;
  }

  setModeFov(fov) {
    if (this.mode === 'sky') {
      this.skyFov = clamp(fov, MIN_SKY_FOV, MAX_FOV);
    } else {
      this.globeFov = clamp(fov, MIN_GLOBE_FOV, MAX_FOV);
    }
    this.requestRender();
  }

  activePreset(settings = this.state.settings) {
    return this.modeFov() > (settings.regularFov + settings.wideFov) / 2 ? 'wideFov' : 'regularFov';
  }

  currentPose() {
    const t = smootherStep(this.blend);
    return {
      pose: blendPoses(eyePose(this.globe), skyPose(this.sky), t),
      fov: this.globeFov + (this.skyFov - this.globeFov) * t,
    };
  }

  projectorFor(pose, fov) {
    return makeProjector({
      view: viewMatrixForPose(pose),
      eye: pose.position,
      fov,
      aspect: this.width / this.height,
    });
  }

  // ---- animation ----------------------------------------------------------------------------

  tween(key, duration, update, onDone) {
    this.tweens.set(key, { start: performance.now(), duration, update, onDone });
    this.requestRender();
  }

  cancelTween(key) {
    this.tweens.delete(key);
  }

  stepTweens(now) {
    this.tweens.forEach((tween, key) => {
      const progress = clamp01((now - tween.start) / tween.duration);
      tween.update(progress);
      if (progress >= 1) {
        this.tweens.delete(key);
        tween.onDone?.();
      }
    });
  }

  animateBlend(target) {
    const from = this.blend;
    this.tween('blend', MODE_TRANSITION_MS * Math.abs(target - from), (p) => {
      this.blend = from + (target - from) * easeInOut(p);
    });
  }

  // ---- public camera actions ----------------------------------------------------------------

  toggleMode() {
    this.cancelTween('look');
    if (this.mode === 'globe') {
      this.mode = 'sky';
      this.sky = { yaw: 0, pitch: 0 };
      this.skyFov = this.state.settings.wideFov;
      this.animateBlend(1);
    } else {
      this.mode = 'globe';
      this.animateBlend(0);
    }
    this.notifyView();
  }

  toggleWide() {
    const settings = this.state.settings;
    const target = this.activePreset() === 'wideFov' ? settings.regularFov : settings.wideFov;
    const from = this.modeFov();
    this.tween('fov', FOV_TRANSITION_MS, (p) => {
      this.setModeFov(from + (target - from) * easeInOut(p));
    });
  }

  reset() {
    const fromGlobe = { ...this.globe };
    const fromGlobeFov = this.globeFov;
    const targetFov = this.state.settings.regularFov;
    this.mode = 'globe';
    this.tweens.clear();
    this.animateBlend(0);
    this.tween('globe', MODE_TRANSITION_MS, (p) => {
      const t = easeInOut(p);
      this.globe = lerpEye(fromGlobe, DEFAULT_GLOBE, t);
      this.globeFov = fromGlobeFov + (targetFov - fromGlobeFov) * t;
    });
    this.notifyView();
  }

  // Turns the sky camera to a star body (switching from the globe if needed), re-aiming every
  // frame so it lands on the body even while the sky moves.
  focusBody(bodyId) {
    const target = () => {
      const view = skyBodyView(bodyId, this.state.dayOfYear, this.state.phase);
      if (!view) {
        return null;
      }
      return {
        yaw: view.yaw,
        pitch: clamp(view.pitch, -24, 88),
        fov: clamp(Math.max(this.state.settings.regularFov, view.radius * 2.6 + 12), MIN_SKY_FOV, MAX_FOV),
      };
    };
    const first = target();
    if (!first) {
      return;
    }
    this.cancelTween('fov');
    if (this.mode === 'globe') {
      this.mode = 'sky';
      this.animateBlend(1);
      this.tween('look', MODE_TRANSITION_MS, () => {
        const aim = target();
        if (aim) {
          this.sky = { yaw: aim.yaw, pitch: aim.pitch };
          this.skyFov = aim.fov;
        }
      });
      this.notifyView();
      return;
    }
    const from = { ...this.sky, fov: this.skyFov };
    this.tween('look', FOCUS_TRANSITION_MS, (p) => {
      const aim = target();
      if (!aim) {
        return;
      }
      const t = easeInOut(p);
      this.sky = {
        yaw: normalizeDegrees(from.yaw + normalizeDegrees(aim.yaw - from.yaw) * t),
        pitch: from.pitch + (aim.pitch - from.pitch) * t,
      };
      this.skyFov = from.fov + (aim.fov - from.fov) * t;
    });
  }

  notifyView() {
    const wide = this.activePreset() === 'wideFov';
    const key = `${this.mode}/${wide}`;
    if (key !== this.lastViewKey) {
      this.lastViewKey = key;
      this.onViewChange?.({ mode: this.mode, wide });
    }
  }

  writeHash() {
    const parts = [
      `eye=${[
        formatNumber(this.globe.lng, 6),
        formatNumber(this.globe.lat, 6),
        formatNumber(this.globe.altitude, 7),
        formatNumber(normalizeDegrees(this.globe.heading), 2),
        formatNumber(this.globe.tilt, 2),
        formatNumber(this.globeFov, 2),
      ].join(',')}`,
    ];
    if (this.mode === 'sky') {
      parts.push(`sky=${[
        formatNumber(this.sky.yaw, 2),
        formatNumber(this.sky.pitch, 2),
        formatNumber(this.skyFov, 2),
      ].join(',')}`);
      parts.push('mode=sky');
    }
    const hash = `#${parts.join('&')}`;
    if (window.location.hash !== hash) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
  }

  // ---- input --------------------------------------------------------------------------------

  ndcFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: 1 - ((event.clientY - rect.top) / rect.height) * 2,
      px: event.clientX - rect.left,
      py: event.clientY - rect.top,
    };
  }

  // The globe point under an NDC position, or null over the sky.
  globePointAt(ndc) {
    const { pose, fov } = this.currentPose();
    const projector = this.projectorFor(pose, fov);
    const ray = projector.unprojectWorld(ndc.x, ndc.y);
    const t = raySphere(pose.position, ray);
    return t === null ? null : pose.position.clone().addScaledVector(ray, t).normalize();
  }

  bindInput() {
    this.handlers = {
      pointerdown: (event) => this.handlePointerDown(event),
      pointermove: (event) => this.handlePointerMove(event),
      pointerup: (event) => this.handlePointerUp(event),
      pointercancel: (event) => this.handlePointerUp(event),
      wheel: (event) => this.handleWheel(event),
      contextmenu: (event) => event.preventDefault(),
    };
    Object.entries(this.handlers).forEach(([name, handler]) => {
      this.canvas.addEventListener(name, handler, { passive: name !== 'wheel' && name !== 'contextmenu' });
    });
  }

  unbindInput() {
    Object.entries(this.handlers).forEach(([name, handler]) => this.canvas.removeEventListener(name, handler));
  }

  interactive() {
    return !this.tweens.has('blend');
  }

  handlePointerDown(event) {
    this.canvas.setPointerCapture?.(event.pointerId);
    const ndc = this.ndcFromEvent(event);
    const rotate = event.button === 2 || event.ctrlKey || event.metaKey;
    this.pointers.set(event.pointerId, {
      start: ndc,
      last: ndc,
      moved: false,
      rotate,
      grab: this.mode === 'globe' && !rotate ? this.globePointAt(ndc) : null,
    });
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = {
        distance: Math.hypot(a.last.px - b.last.px, a.last.py - b.last.py),
        fov: this.modeFov(),
      };
    }
  }

  handlePointerMove(event) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) {
      return;
    }
    const ndc = this.ndcFromEvent(event);
    const dx = ndc.px - pointer.last.px;
    const dy = ndc.py - pointer.last.py;
    pointer.last = ndc;
    pointer.moved = pointer.moved || Math.hypot(ndc.px - pointer.start.px, ndc.py - pointer.start.py) > 5;
    if (!this.interactive() || !pointer.moved) {
      return;
    }
    this.cancelTween('look');
    this.cancelTween('globe');

    if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const spread = Math.max(1, Math.hypot(a.last.px - b.last.px, a.last.py - b.last.py));
      if (this.mode === 'globe') {
        this.dolly(this.pinch.distance / spread, { x: 0, y: 0 });
        this.pinch.distance = spread;
      } else {
        this.setModeFov(this.pinch.fov * (this.pinch.distance / spread));
      }
      this.requestRender();
      return;
    }

    if (this.mode === 'sky') {
      this.sky = {
        yaw: normalizeDegrees(this.sky.yaw - dx * 0.12 * (this.skyFov / 62)),
        pitch: clamp(this.sky.pitch + dy * 0.12 * (this.skyFov / 62), -24, 88),
      };
    } else if (pointer.grab && !pointer.rotate) {
      this.panGlobe(pointer.grab, ndc);
    } else {
      this.rotateGlobe(dx, dy);
    }
    this.requestRender();
  }

  // Orbits around the point at the view center (like a map) when it is on the sea; otherwise
  // turns the camera in place.
  rotateGlobe(dx, dy) {
    const orbit = orbitFromPose(eyePose(this.globe));
    if (orbit && orbit.pitch < MAX_ORBIT_PITCH + 0.5) {
      const next = eyeFromPose(orbitPose({
        ...orbit,
        bearing: orbit.bearing - dx * 0.3,
        pitch: clamp(orbit.pitch - dy * 0.3, 0, MAX_ORBIT_PITCH),
      }));
      if (next.altitude > MIN_GLOBE_ALTITUDE) {
        this.globe = next;
        return;
      }
    }
    this.globe = {
      ...this.globe,
      heading: normalizeDegrees(this.globe.heading - dx * 0.2),
      tilt: clamp(this.globe.tilt - dy * 0.2, MIN_TILT, MAX_TILT),
    };
  }

  // Moves the eye toward (factor < 1) or away from the sea point under `ndc`, keeping the view
  // direction; over the sky it moves straight up or down.
  dolly(factor, ndc) {
    const pose = eyePose(this.globe);
    const ray = this.projectorFor(pose, this.globeFov).unprojectWorld(ndc.x, ndc.y);
    const t = raySphere(pose.position, ray);
    if (t === null) {
      const altitude = clamp(this.globe.altitude * factor, MIN_GLOBE_ALTITUDE, MAX_GLOBE_ALTITUDE);
      this.globe = { ...this.globe, altitude };
      return;
    }
    const target = pose.position.clone().addScaledVector(ray, t);
    const position = target.clone().addScaledVector(pose.position.clone().sub(target), factor);
    const altitude = position.length() - 1;
    if (altitude < MIN_GLOBE_ALTITUDE || altitude > MAX_GLOBE_ALTITUDE) {
      return;
    }
    this.globe = eyeFromPose({ position, quaternion: pose.quaternion });
  }

  // Rotates the camera around the Earth's center so the grabbed point stays under the pointer.
  panGlobe(grab, ndc) {
    const under = this.globePointAt(ndc);
    if (!under) {
      return;
    }
    let rotation = new THREE.Quaternion().setFromUnitVectors(under, grab);
    const angle = 2 * Math.acos(clamp(Math.abs(rotation.w), -1, 1));
    if (angle > 0.2) {
      rotation = new THREE.Quaternion().slerp(rotation, 0.2 / angle);
    }
    const pose = eyePose(this.globe);
    pose.position.applyQuaternion(rotation);
    pose.quaternion.premultiply(rotation);
    this.globe = eyeFromPose(pose);
  }

  handlePointerUp(event) {
    const pointer = this.pointers.get(event.pointerId);
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) {
      this.pinch = null;
    }
    if (pointer && !pointer.moved && event.type === 'pointerup' && event.button === 0) {
      this.select(pointer.start.px, pointer.start.py);
    }
  }

  handleWheel(event) {
    event.preventDefault();
    if (!this.interactive()) {
      return;
    }
    this.cancelTween('fov');
    this.cancelTween('look');
    this.cancelTween('globe');
    const ndc = this.ndcFromEvent(event);
    if (this.mode === 'globe' && (event.altKey || event.ctrlKey)) {
      // Option/Alt-wheel or a trackpad pinch moves the camera toward the point under the pointer.
      this.dolly(Math.exp(event.deltaY * WHEEL_DISTANCE_RATE), ndc);
      this.requestRender();
      return;
    }
    const fromFov = this.modeFov();
    const minFov = this.mode === 'sky' ? MIN_SKY_FOV : MIN_GLOBE_FOV;
    const toFov = clamp(fromFov * Math.exp(event.deltaY * WHEEL_FOV_RATE), minFov, MAX_FOV);
    if (this.mode === 'sky') {
      this.sky = this.anchoredSkyLook(fromFov, toFov, ndc);
    } else {
      this.globe = this.anchoredGlobeEye(fromFov, toFov, ndc);
    }
    this.setModeFov(toFov);
  }

  // Sky look that keeps the sky point under the pointer fixed while the FOV changes (Gauss-Newton
  // on the 3D direction error with backtracking; the target can be out of the pitch range).
  anchoredSkyLook(fromFov, toFov, ndc) {
    const anchor = this.projectorFor(skyPose(this.sky), fromFov).unprojectWorld(ndc.x, ndc.y);
    const seenAt = (yaw, pitch) => this.projectorFor(skyPose({ yaw, pitch }), toFov).unprojectWorld(ndc.x, ndc.y);
    const delta = 0.01;
    let { yaw, pitch } = this.sky;
    for (let iteration = 0; iteration < 12; iteration += 1) {
      const seen = seenAt(yaw, pitch);
      const error = anchor.clone().sub(seen);
      if (error.lengthSq() < 1e-12) {
        break;
      }
      const dYaw = seenAt(yaw + delta, pitch).sub(seen).divideScalar(delta);
      const dPitch = seenAt(yaw, pitch + delta).sub(seen).divideScalar(delta);
      const a = dYaw.dot(dYaw);
      const b = dYaw.dot(dPitch);
      const c = dPitch.dot(dPitch);
      const det = a * c - b * b;
      if (Math.abs(det) < 1e-12) {
        break;
      }
      const ey = dYaw.dot(error);
      const ep = dPitch.dot(error);
      const stepYaw = (c * ey - b * ep) / det;
      const stepPitch = (a * ep - b * ey) / det;
      let accepted = false;
      for (let scale = 1; scale > 0.01; scale *= 0.5) {
        const nextYaw = yaw + stepYaw * scale;
        const nextPitch = clamp(pitch + stepPitch * scale, -24, 88);
        if (anchor.distanceToSquared(seenAt(nextYaw, nextPitch)) < error.lengthSq()) {
          yaw = nextYaw;
          pitch = nextPitch;
          accepted = true;
          break;
        }
      }
      if (!accepted) {
        break;
      }
    }
    return { yaw: normalizeDegrees(yaw), pitch };
  }

  // Globe eye that keeps the direction under the pointer fixed while the FOV changes: the camera
  // turns in place (re-leveled each step, since it never rolls).
  anchoredGlobeEye(fromFov, toFov, ndc) {
    const anchor = this.projectorFor(eyePose(this.globe), fromFov).unprojectWorld(ndc.x, ndc.y);
    let eye = this.globe;
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const pose = eyePose(eye);
      const seen = this.projectorFor(pose, toFov).unprojectWorld(ndc.x, ndc.y);
      if (seen.distanceToSquared(anchor) < 1e-12) {
        break;
      }
      pose.quaternion.premultiply(new THREE.Quaternion().setFromUnitVectors(seen, anchor));
      const next = eyeFromPose(pose);
      eye = { ...next, tilt: clamp(next.tilt, MIN_TILT, MAX_TILT) };
    }
    return eye;
  }

  select(x, y) {
    const distanceToSegment = (x1, y1, x2, y2) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lengthSquared = dx * dx + dy * dy;
      if (lengthSquared <= 0.0001) {
        return Math.hypot(x - x1, y - y1);
      }
      const t = clamp(((x - x1) * dx + (y - y1) * dy) / lengthSquared, 0, 1);
      return Math.hypot(x - (x1 + dx * t), y - (y1 + dy * t));
    };
    let best = null;
    this.hitTargets.forEach((target) => {
      let score = Infinity;
      if (target.width && target.height) {
        const dx = Math.abs(x - target.x);
        const dy = Math.abs(y - target.y);
        if (dx <= target.width * 0.5 && dy <= target.height * 0.5) {
          score = dx / Math.max(target.width, 1) + dy / Math.max(target.height, 1);
        }
      } else if (Number.isFinite(target.x1)) {
        const distance = distanceToSegment(target.x1, target.y1, target.x2, target.y2);
        if (distance <= target.radius) {
          // Bias toward stars, which sit at line endpoints and may select a more specific body.
          score = distance / Math.max(target.radius, 1) + 0.5;
        }
      } else {
        const distance = Math.hypot(x - target.x, y - target.y);
        if (distance <= target.radius) {
          score = distance / Math.max(target.radius, 1);
        }
      }
      if (score < (best?.score ?? Infinity)) {
        best = { ...target, score };
      }
    });
    if (best?.id) {
      this.onSelect?.(best.id);
    }
  }

  // ---- rendering ----------------------------------------------------------------------------

  resize() {
    this.renderer.setSize(this.width, this.height, false);
    updateWideLineResolutions(this.skyScene, this.width, this.height);
    this.requestRender();
  }

  frame(now) {
    this.rafId = requestAnimationFrame(this.frame);
    if (this.tweens.size) {
      this.stepTweens(now);
      this.needsRender = true;
    }
    if (!this.needsRender) {
      return;
    }
    this.needsRender = false;
    this.render();
    this.notifyView();
    if (this.blend !== this.lastBlend) {
      this.lastBlend = this.blend;
      this.onBlendChange?.(this.blend);
    }
    // Throttled rather than debounced: tile loads can keep frames coming continuously.
    if (!this.hashTimer) {
      this.hashTimer = setTimeout(() => {
        this.hashTimer = null;
        this.writeHash();
      }, 250);
    }
  }

  render() {
    const { state } = this;
    const settings = state.settings ?? DEFAULT_SETTINGS;
    const width = this.width;
    const height = this.height;
    const t = smootherStep(this.blend);
    const { pose, fov } = this.currentPose();
    const projector = this.projectorFor(pose, fov);

    viewUniforms.uViewMatrix.value.copy(projector.view);
    viewUniforms.uViewPosition.value.copy(pose.position);
    viewUniforms.uViewK.value = projector.k;
    viewUniforms.uViewScale.value.copy(projector.scale);

    // Sky
    const sky = this.worldSky;
    sky.gridGroup.visible = Boolean(state.showGrid);
    sky.pathGroup.visible = Boolean(state.showPaths);
    sky.fieldStars.visible = Boolean(state.showFieldStars);
    sky.milkyWay.visible = Boolean(state.showMilkyWay) && Boolean(sky.milkyWay.userData.loaded);
    sky.sun.visible = Boolean(state.showSunMoon);
    sky.moon.visible = Boolean(state.showSunMoon);
    applyVisualSettings(sky, settings);
    const date = skyDate(state.dayOfYear ?? 1, (state.phase ?? 0) / 15);
    sky.root.quaternion.setFromAxisAngle(sky.diurnalAxis, siderealRotation(date));
    sky.root.updateMatrixWorld(true);
    const ephemerisKey = Math.round(date.getTime() / 60000);
    if (this.ephemerisKey !== ephemerisKey) {
      this.ephemerisKey = ephemerisKey;
      updateSunAndMoon(sky, date);
    }
    updateMoonLimb(sky, projector, width, height);
    const aspect = width / height;
    this.labelCamera.left = -aspect;
    this.labelCamera.right = aspect;
    this.labelCamera.updateProjectionMatrix();
    this.hitTargets = updateSkyLabelsAndHits(sky, {
      projector,
      width,
      height,
      showLabels: Boolean(state.showLabels),
      labelSize: settings.labelSize ?? 1,
      occluded: (direction) => raySphere(pose.position, direction) !== null,
    });

    // Globe
    this.globeLayer.update({
      projector,
      referenceProjector: this.projectorFor(pose, settings.regularFov),
      width,
      height,
      pixelRatio: this.renderer.getPixelRatio(),
      orbitCenter: { lng: this.globe.lng, lat: this.globe.lat },
      orbitDistance: this.globe.altitude * 10,
      state,
      settings,
      mapFade: decorationFade(this.blend),
      earthOpacity: 1 - 0.22 * t,
    });

    const background = GLOBE_SPACE_COLOR.clone().lerp(SKY_BACKGROUND_COLOR, t);
    this.renderer.setClearColor(background, 1);
    this.renderer.clear();
    this.renderer.render(this.skyScene, this.camera);
    this.renderer.render(this.labelScene, this.labelCamera);
    this.renderer.render(this.globeLayer.scene, this.camera);
    this.renderer.render(this.globeLayer.hudScene, this.globeLayer.hudCamera);
  }
}
