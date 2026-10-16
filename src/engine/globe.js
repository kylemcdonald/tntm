import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { islandFeatures, routeFeature } from '../taumakoData.js';
import { lngLatToVector, localFrame, OBSERVER, vectorToLngLat } from './camera.js';
import { PROJECTION_GLSL, raySphere, viewUniforms, withViewUniforms, WORLD_VERTEX_PROJECT } from './projection.js';
import { assetUrl, makeScreenLabelMaterial, makeWideLineMaterial } from './sky.js';

// The Earth: a per-pixel base sphere (exact limb in any projection), OpenStreetMap raster tiles,
// the graticule, the voyage route, island markers, and the compass, boat and island labels.

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MIN_TILE_ZOOM = 2;
const MAX_TILE_ZOOM = 12;
const TILE_PIXELS = 256;
const MAX_TILES = 220;
const MAX_TILE_REQUESTS = 6;
const TEXTURE_CACHE_SIZE = 400;
const EARTH_COLOR = new THREE.Color('#0a1d55');
const ATMOSPHERE_COLOR = new THREE.Color('#2969b2');

const BOAT_ASPECT_RATIO = 512 / 1074;

// Ring center of public/compass.png (1120x1120), from a circle fit, as a fraction from the top left.
const COMPASS_RING_CENTER = { x: 551.1 / 1120, y: 534.4 / 1120 };

function bleedTransparentPixels(imageData, width, height, passes = 10) {
  const { data } = imageData;
  const filled = new Uint8Array(width * height);
  const distance = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const offsets = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  for (let i = 0; i < filled.length; i += 1) {
    if (data[i * 4 + 3] > 0) {
      filled[i] = 1;
      queue[tail] = i;
      tail += 1;
    }
  }

  while (head < tail) {
    const pixel = queue[head];
    head += 1;

    if (distance[pixel] >= passes) {
      continue;
    }

    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const sourceOffset = pixel * 4;

    offsets.forEach(([offsetX, offsetY]) => {
      const nx = x + offsetX;
      const ny = y + offsetY;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
        return;
      }

      const neighbor = ny * width + nx;
      if (filled[neighbor]) {
        return;
      }

      const neighborOffset = neighbor * 4;
      data[neighborOffset] = data[sourceOffset];
      data[neighborOffset + 1] = data[sourceOffset + 1];
      data[neighborOffset + 2] = data[sourceOffset + 2];
      filled[neighbor] = 1;
      distance[neighbor] = distance[pixel] + 1;
      queue[tail] = neighbor;
      tail += 1;
    });
  }
}

function loadCompassTexture(onLoad) {
  const canvas = document.createElement('canvas');
  const image = new Image();
  image.onload = () => {
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    bleedTransparentPixels(imageData, canvas.width, canvas.height);
    ctx.putImageData(imageData, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    onLoad(texture);
  };
  image.src = assetUrl('/compass.png');
}

function makeIslandLabelTexture(name) {
  const canvas = document.createElement('canvas');
  const width = 1024;
  const height = 336;
  const lines = String(name).split('\n');
  const fontSize = lines.length > 1 ? 70 : 84;
  const lineHeight = fontSize * 1.02;
  const blockHeight = lineHeight * lines.length;

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.88)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#f5f8ff';
  ctx.font = `700 ${fontSize}px "Trebuchet MS", sans-serif`;

  const startY = height / 2 - blockHeight / 2 + lineHeight / 2;
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2, startY + index * lineHeight);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData.aspect = width / height;
  return texture;
}

function targetMarkerPixels(width, height) {
  if (width < 700) {
    return THREE.MathUtils.clamp(Math.min(width * 0.72, height * 0.36), 230, 300);
  }
  return THREE.MathUtils.clamp(Math.min(width * 0.2, height * 0.32), 220, 320);
}

// Shared night styling for every tile; the engine sets these from the settings.
export const tileStyleUniforms = {
  uMapOpacity: { value: 0.9 },
  uMapInvert: { value: 1 },
  uMapBrightness: { value: 0 },
  uMapContrast: { value: 1 },
  uMapSaturation: { value: 1 },
  uMapTint: { value: new THREE.Vector3(1, 1, 1) },
};

function makeTileMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      ...tileStyleUniforms,
      uMap: { value: null },
      uUvTransform: { value: new THREE.Vector4(0, 0, 1, 1) },
    }),
    vertexShader: `
      ${PROJECTION_GLSL}
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        ${WORLD_VERTEX_PROJECT}
      }
    `,
    fragmentShader: `
      uniform vec3 uViewPosition;
      uniform sampler2D uMap;
      uniform vec4 uUvTransform;
      uniform float uMapOpacity;
      uniform float uMapInvert;
      uniform float uMapBrightness;
      uniform float uMapContrast;
      uniform float uMapSaturation;
      uniform vec3 uMapTint;
      varying vec2 vUv;
      varying vec3 vWorld;
      const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
      void main() {
        // Exact limb: drop fragments on the far side of the globe.
        vec3 normal = normalize(vWorld);
        if (dot(normal, uViewPosition - normal) < 0.0) discard;
        vec3 color = texture2D(uMap, uUvTransform.xy + vUv * uUvTransform.zw).rgb;
        // Night styling: invert lightness while keeping hue, so pale land turns dark and the
        // light blue sea turns deep teal; then contrast, brightness, saturation and a tint.
        float lightness = dot(color, LUMA);
        color = mix(color, clamp(color + (1.0 - 2.0 * lightness), 0.0, 1.0), uMapInvert);
        color = (color - 0.5) * uMapContrast + 0.5 + uMapBrightness;
        color = mix(vec3(dot(color, LUMA)), color, uMapSaturation) * uMapTint;
        gl_FragColor = vec4(clamp(color, 0.0, 1.0), uMapOpacity);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function tileLatitude(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return THREE.MathUtils.radToDeg(Math.atan(Math.sinh(n)));
}

function tileLngLat(z, x, y) {
  return {
    west: (x / 2 ** z) * 360 - 180,
    east: ((x + 1) / 2 ** z) * 360 - 180,
    north: tileLatitude(y, z),
    south: tileLatitude(y + 1, z),
  };
}

function tileContains(z, x, y, { lng, lat }) {
  const n = 2 ** z;
  const tx = ((lng + 180) / 360) * n;
  const latRad = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(lat, -85.05, 85.05));
  const ty = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return tx >= x && tx < x + 1 && ty >= y && ty < y + 1;
}

function makeTileGeometry(z, x, y) {
  const segments = z < 4 ? 24 : 12;
  const { west, east } = tileLngLat(z, x, y);
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= segments; j += 1) {
    const lat = tileLatitude(y + j / segments, z);
    for (let i = 0; i <= segments; i += 1) {
      const point = lngLatToVector({ lng: west + ((east - west) * i) / segments, lat });
      positions.push(point.x, point.y, point.z);
      uvs.push(i / segments, 1 - j / segments);
    }
  }
  for (let j = 0; j < segments; j += 1) {
    for (let i = 0; i < segments; i += 1) {
      const a = j * (segments + 1) + i;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

// Picks the tiles that cover the view at about one texel per pixel, loads them, and draws each
// with its own texture or, while that loads, the matching part of its nearest loaded ancestor.
class TileLayer {
  constructor(requestRender) {
    this.group = new THREE.Group();
    this.requestRender = requestRender;
    this.textures = new Map();
    this.meshes = new Map();
    this.queue = [];
    this.inFlight = 0;
    this.frame = 0;
  }

  update(projector, width, height) {
    this.frame += 1;
    const needed = this.selectTiles(projector, width, height);
    const neededKeys = new Set();

    needed.forEach(({ z, x, y }) => {
      const key = `${z}/${x}/${y}`;
      neededKeys.add(key);
      this.request(z, x, y);
      const source = this.loadedSource(z, x, y);
      let mesh = this.meshes.get(key);
      if (!source) {
        if (mesh) {
          mesh.visible = false;
        }
        return;
      }
      if (!mesh) {
        mesh = new THREE.Mesh(makeTileGeometry(z, x, y), makeTileMaterial());
        mesh.frustumCulled = false;
        mesh.renderOrder = z;
        this.meshes.set(key, mesh);
        this.group.add(mesh);
      }
      const scale = 2 ** (source.z - z);
      mesh.material.uniforms.uMap.value = source.texture;
      mesh.material.uniforms.uUvTransform.value.set(
        x * scale - source.x,
        1 - (y * scale - source.y) - scale,
        scale,
        scale,
      );
      mesh.visible = true;
      mesh.userData.frame = this.frame;
    });

    this.meshes.forEach((mesh, key) => {
      if (!neededKeys.has(key)) {
        mesh.visible = false;
        if (this.frame - (mesh.userData.frame ?? 0) > 120) {
          mesh.geometry.dispose();
          mesh.material.dispose();
          this.group.remove(mesh);
          this.meshes.delete(key);
        }
      }
    });
    this.pump();
    this.evictTextures(neededKeys);
  }

  selectTiles(projector, width, height) {
    const eye = projector.eye;
    const pixelsPerRadian = projector.pixelsPerRadian(height);
    // Globe points under a coarse grid of screen rays catch big tiles whose sample points all
    // fall outside the view (e.g. the camera close to the surface).
    const hits = [];
    for (let j = 0; j <= 8; j += 1) {
      for (let i = 0; i <= 10; i += 1) {
        const ray = projector.unprojectWorld((i / 10) * 2 - 1, (j / 8) * 2 - 1);
        const t = raySphere(eye, ray);
        if (t !== null) {
          hits.push(vectorToLngLat(eye.clone().addScaledVector(ray, t)));
        }
      }
    }
    hits.push(vectorToLngLat(eye));

    const run = (detail) => {
      const tiles = [];
      const visit = (z, x, y) => {
        const bounds = tileLngLat(z, x, y);
        const samples = z < 5 ? 4 : 2;
        let visible = false;
        let nearest = Infinity;
        let nearestFacing = 1;
        for (let j = 0; j <= samples; j += 1) {
          const lat = tileLatitude(y + j / samples, z);
          for (let i = 0; i <= samples; i += 1) {
            const point = lngLatToVector({ lng: bounds.west + ((bounds.east - bounds.west) * i) / samples, lat });
            const toEye = eye.clone().sub(point);
            const distance = toEye.length();
            const facing = point.dot(toEye) / distance;
            if (distance < nearest) {
              nearest = distance;
              nearestFacing = facing;
            }
            if (!visible && facing > 0) {
              const projected = projector.projectWorld(point);
              visible = projected.w > 0 && Math.abs(projected.x) < 1.3 && Math.abs(projected.y) < 1.3;
            }
          }
        }
        if (!visible) {
          visible = hits.some((hit) => tileContains(z, x, y, hit));
        }
        if (!visible) {
          return;
        }
        const latCenter = THREE.MathUtils.degToRad((bounds.north + bounds.south) / 2);
        const size = Math.max(
          THREE.MathUtils.degToRad(bounds.east - bounds.west) * Math.cos(latCenter),
          THREE.MathUtils.degToRad(bounds.north - bounds.south),
        );
        const foreshortening = Math.sqrt(THREE.MathUtils.clamp(nearestFacing, 0.15, 1));
        const pixels = (size / nearest) * pixelsPerRadian * foreshortening;
        if (z < MAX_TILE_ZOOM && pixels > TILE_PIXELS * detail) {
          for (let dy = 0; dy < 2; dy += 1) {
            for (let dx = 0; dx < 2; dx += 1) {
              visit(z + 1, x * 2 + dx, y * 2 + dy);
            }
          }
        } else {
          tiles.push({ z, x, y });
        }
      };
      const n = 2 ** MIN_TILE_ZOOM;
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1) {
          visit(MIN_TILE_ZOOM, x, y);
        }
      }
      return tiles;
    };

    let detail = 1.25;
    let tiles = run(detail);
    while (tiles.length > MAX_TILES && detail < 8) {
      detail *= 1.6;
      tiles = run(detail);
    }
    return tiles;
  }

  loadedSource(z, x, y) {
    for (let level = z; level >= 0; level -= 1) {
      const shift = z - level;
      const sx = x >> shift;
      const sy = y >> shift;
      const entry = this.textures.get(`${level}/${sx}/${sy}`);
      if (entry?.texture) {
        entry.used = this.frame;
        return { z: level, x: sx, y: sy, texture: entry.texture };
      }
    }
    return null;
  }

  request(z, x, y) {
    const key = `${z}/${x}/${y}`;
    const entry = this.textures.get(key);
    if (entry) {
      entry.used = this.frame;
      return;
    }
    this.textures.set(key, { status: 'queued', used: this.frame, z });
    this.queue.push({ key, z, x, y });
    // Keep ancestors coming too, so there is always something coarse to fall back on.
    if (z > MIN_TILE_ZOOM) {
      this.request(z - 1, x >> 1, y >> 1);
    }
  }

  pump() {
    this.queue.sort((a, b) => a.z - b.z);
    while (this.inFlight < MAX_TILE_REQUESTS && this.queue.length) {
      const { key, z, x, y } = this.queue.shift();
      const entry = this.textures.get(key);
      if (!entry || entry.status !== 'queued' || this.frame - entry.used > 2) {
        this.textures.delete(key);
        continue;
      }
      entry.status = 'loading';
      this.inFlight += 1;
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        this.inFlight -= 1;
        const texture = new THREE.Texture(image);
        texture.colorSpace = THREE.NoColorSpace;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
        entry.texture = texture;
        entry.status = 'loaded';
        this.requestRender();
      };
      image.onerror = () => {
        this.inFlight -= 1;
        entry.status = 'error';
        this.requestRender();
      };
      image.src = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    }
  }

  evictTextures(neededKeys) {
    if (this.textures.size <= TEXTURE_CACHE_SIZE) {
      return;
    }
    const entries = [...this.textures.entries()]
      .filter(([key, entry]) => entry.status === 'loaded' && !neededKeys.has(key) && entry.z > MIN_TILE_ZOOM)
      .sort((a, b) => a[1].used - b[1].used);
    const excess = this.textures.size - TEXTURE_CACHE_SIZE;
    entries.slice(0, excess).forEach(([key, entry]) => {
      entry.texture.dispose();
      this.textures.delete(key);
    });
  }

  dispose() {
    this.meshes.forEach((mesh) => {
      mesh.geometry.dispose();
      mesh.material.dispose();
    });
    this.textures.forEach((entry) => entry.texture?.dispose());
  }
}

// Full-screen pass that shades the unit-sphere Earth per pixel, plus a faint atmosphere at the
// limb. It is exact for any projection, so tile gaps and the far edge of the view never show sky.
function makeEarthBase() {
  const material = new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      uEarthColor: { value: EARTH_COLOR.clone() },
      uAtmosphereColor: { value: ATMOSPHERE_COLOR.clone() },
      uEarthOpacity: { value: 1 },
    }),
    vertexShader: `
      varying vec2 vNdc;
      void main() {
        vNdc = position.xy;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform mat4 uViewMatrix;
      uniform vec3 uViewPosition;
      uniform float uViewK;
      uniform vec2 uViewScale;
      uniform vec3 uEarthColor;
      uniform vec3 uAtmosphereColor;
      uniform float uEarthOpacity;
      varying vec2 vNdc;
      void main() {
        float s = 1.0 + uViewK;
        vec2 ab = vNdc / uViewScale;
        float q = dot(ab, ab) / (s * s);
        float t = (uViewK + sqrt(max(0.0, uViewK * uViewK - (q + 1.0) * (uViewK * uViewK - 1.0)))) / (q + 1.0);
        vec3 ray = normalize(transpose(mat3(uViewMatrix)) * normalize(vec3(ab * t / s, uViewK - t)));
        float b = dot(uViewPosition, ray);
        float c = dot(uViewPosition, uViewPosition) - 1.0;
        float disc = b * b - c;
        if (disc > 0.0 && -b - sqrt(disc) > 0.0) {
          vec3 normal = normalize(uViewPosition + ray * (-b - sqrt(disc)));
          float facing = clamp(-dot(normal, ray), 0.0, 1.0);
          vec3 color = mix(uAtmosphereColor * 0.55, uEarthColor, smoothstep(0.0, 0.35, facing));
          gl_FragColor = vec4(color, uEarthOpacity);
          return;
        }
        // Rays that pass close above the limb pick up a thin glow.
        float closest = sqrt(max(0.0, c + 1.0 - b * b));
        float glow = b < 0.0 ? exp(-(closest - 1.0) * 60.0) * 0.35 : 0.0;
        if (glow < 0.004) discard;
        gl_FragColor = vec4(uAtmosphereColor, glow * uEarthOpacity);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  return mesh;
}

function graticuleStepForDistance(distance) {
  if (distance < 0.5) {
    return 1;
  }
  if (distance < 1.5) {
    return 5;
  }
  return 10;
}

// Lat/lng lines; the 1° grid is only built around the view center since it is dense.
class Graticule {
  constructor() {
    this.group = new THREE.Group();
    this.major = new LineSegments2(new LineSegmentsGeometry(), makeWideLineMaterial('#62baff', 0.42, 1.35, 'surface'));
    this.minor = new LineSegments2(new LineSegmentsGeometry(), makeWideLineMaterial('#62baff', 0.22, 0.72, 'surface'));
    [this.major, this.minor].forEach((line) => {
      line.frustumCulled = false;
      line.renderOrder = 40;
      this.group.add(line);
    });
    this.key = null;
  }

  update(center, distance, opacity) {
    this.major.material.opacity = 0.42 * opacity;
    this.minor.material.opacity = 0.22 * opacity;
    const step = graticuleStepForDistance(distance);
    const span = step === 1 ? 24 : 180;
    const anchorLng = step === 1 ? Math.round(center.lng / 6) * 6 : 0;
    const anchorLat = step === 1 ? Math.round(center.lat / 6) * 6 : 0;
    const key = `${step}/${anchorLng}/${anchorLat}`;
    if (key === this.key) {
      return;
    }
    this.key = key;
    const major = [];
    const minor = [];
    const sample = step === 1 ? 0.5 : 2;
    const push = (target, a, b) => {
      const p = lngLatToVector(a);
      const q = lngLatToVector(b);
      target.push(p.x, p.y, p.z, q.x, q.y, q.z);
    };
    const lngMin = step === 1 ? anchorLng - span : -180;
    const lngMax = step === 1 ? anchorLng + span : 180;
    const latMin = step === 1 ? Math.max(-85, anchorLat - span) : -85;
    const latMax = step === 1 ? Math.min(85, anchorLat + span) : 85;
    for (let lng = Math.ceil(lngMin / step) * step; lng <= lngMax; lng += step) {
      const target = lng % 10 === 0 ? major : minor;
      for (let lat = latMin; lat < latMax; lat += sample) {
        push(target, { lng, lat }, { lng, lat: Math.min(latMax, lat + sample) });
      }
    }
    for (let lat = Math.ceil(Math.max(latMin, -80) / step) * step; lat <= Math.min(latMax, 80); lat += step) {
      const target = lat % 10 === 0 ? major : minor;
      for (let lng = lngMin; lng < lngMax; lng += sample) {
        push(target, { lng, lat }, { lng: Math.min(lngMax, lng + sample), lat });
      }
    }
    this.major.geometry.dispose();
    this.minor.geometry.dispose();
    this.major.geometry = new LineSegmentsGeometry().setPositions(major);
    this.minor.geometry = new LineSegmentsGeometry().setPositions(minor);
  }
}

function makeRoute() {
  const [from, to] = routeFeature.features[0].geometry.coordinates
    .map(([lng, lat]) => lngLatToVector({ lng, lat }));
  const points = [];
  const steps = 64;
  for (let i = 0; i <= steps; i += 1) {
    points.push(from.clone().lerp(to, i / steps).normalize().multiplyScalar(1.000002));
  }
  const group = new THREE.Group();
  const glowGeometry = new LineGeometry().setFromPoints(points);
  const glow = new Line2(glowGeometry, makeWideLineMaterial('#d6de57', 0.08, 12, 'surface'));
  const coreGeometry = new LineGeometry().setFromPoints(points);
  const coreMaterial = makeWideLineMaterial('#d8e56a', 0.58, 3, 'surface');
  coreMaterial.dashed = true;
  coreMaterial.dashSize = 0.0011;
  coreMaterial.gapSize = 0.0009;
  const core = new Line2(coreGeometry, coreMaterial);
  core.computeLineDistances();
  [glow, core].forEach((line, index) => {
    line.frustumCulled = false;
    line.renderOrder = 50 + index;
    group.add(line);
  });
  group.userData.materials = [glow.material, core.material];
  return group;
}

// Island dots: a blurred dark green glow under a green disk with a dark stroke.
function makeIslands() {
  const positions = [];
  const sizes = [];
  islandFeatures.features.forEach((feature) => {
    const [lng, lat] = feature.geometry.coordinates;
    const point = lngLatToVector({ lng, lat });
    positions.push(point.x, point.y, point.z);
    sizes.push(feature.properties.size ?? 1);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('islandSize', new THREE.Float32BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      uOpacity: { value: 1 },
      uPixelRatio: { value: 1 },
    }),
    vertexShader: `
      ${PROJECTION_GLSL}
      attribute float islandSize;
      uniform float uPixelRatio;
      varying float vCore;
      void main() {
        vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = surfaceFacing(world) < 0.0 ? vec4(2.0, 2.0, 2.0, 1.0) : projectWorldPosition(world);
        float t = clamp((islandSize - 0.6) / 0.6, 0.0, 1.0);
        float glowRadius = mix(10.0, 25.0, t);
        vCore = mix(4.0, 11.0, t) / glowRadius;
        gl_PointSize = glowRadius * 2.0 * uPixelRatio;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying float vCore;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        float stroke = vCore * 0.18;
        vec4 glow = vec4(0.043, 0.306, 0.086, 0.62 * (1.0 - smoothstep(0.0, 1.0, r)));
        vec4 color = glow;
        if (r < vCore + stroke) {
          color = vec4(0.020, 0.188, 0.071, 0.96);
        }
        if (r < vCore) {
          color = vec4(0.071, 0.506, 0.165, 0.96);
        }
        gl_FragColor = vec4(color.rgb, color.a * uOpacity);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 60;
  return points;
}

function makeProjectedTextureMaterial(texture, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      uMap: { value: texture },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uOpacity: { value: opacity },
    }),
    vertexShader: `
      ${PROJECTION_GLSL}
      varying vec2 vUv;
      void main() {
        vUv = uv;
        ${WORLD_VERTEX_PROJECT}
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        vec4 texel = texture2D(uMap, vUv);
        gl_FragColor = vec4(texel.rgb * uColor, texel.a * uOpacity);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function makeSolidTexture(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 2, 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Wind compass lying on the sea at the voyage position, kept at a constant size on screen.
function makeCompass(requestRender) {
  // Local frame at the voyage position: x east, y up, z south (right-handed).
  const anchor = new THREE.Group();
  anchor.matrixAutoUpdate = false;
  const scaler = new THREE.Group();
  scaler.rotation.y = Math.PI;
  const rotator = new THREE.Group();
  anchor.add(scaler);
  scaler.add(rotator);

  const center = new THREE.Mesh(
    new THREE.CircleGeometry(0.32, 48),
    makeProjectedTextureMaterial(makeSolidTexture('#03133f'), 0.78),
  );
  center.rotation.x = -Math.PI / 2;
  center.renderOrder = 90;
  rotator.add(center);

  const compassMaterial = makeProjectedTextureMaterial(null, 0.92);
  loadCompassTexture((texture) => {
    compassMaterial.uniforms.uMap.value = texture;
    requestRender();
  });
  // The rings in compass.png are not centered in the image, so shift the plane until the ring
  // center sits on the voyage position (and compass rotation pivots around it).
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1, 24, 24).translate(0.5 - COMPASS_RING_CENTER.x, COMPASS_RING_CENTER.y - 0.5, 0),
    compassMaterial,
  );
  plane.rotation.x = -Math.PI / 2;
  plane.renderOrder = 91;
  plane.visible = false;
  rotator.add(plane);

  anchor.traverse((child) => {
    child.frustumCulled = false;
  });
  return { anchor, scaler, rotator, center, plane, compassMaterial };
}

export class GlobeLayer {
  constructor(requestRender) {
    this.requestRender = requestRender;
    this.scene = new THREE.Scene();
    this.earth = makeEarthBase();
    this.earth.renderOrder = 0;
    this.tiles = new TileLayer(requestRender);
    this.overlays = new THREE.Group();
    this.graticule = new Graticule();
    this.route = makeRoute();
    this.islands = makeIslands();
    this.compass = makeCompass(requestRender);

    this.scene.add(this.earth);
    this.scene.add(this.tiles.group);
    this.overlays.add(this.graticule.group);
    this.overlays.add(this.route);
    this.overlays.add(this.islands);
    this.scene.add(this.overlays);
    this.scene.add(this.compass.anchor);

    this.hudScene = new THREE.Scene();
    this.hudCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    const boatTexture = new THREE.TextureLoader().load(assetUrl('/boat-raster.png'), () => requestRender());
    boatTexture.colorSpace = THREE.SRGBColorSpace;
    this.boat = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: boatTexture,
        transparent: true,
        opacity: 0.98,
        alphaTest: 0.01,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.boat.renderOrder = 100;
    this.hudScene.add(this.boat);
    this.islandLabels = islandFeatures.features.map((feature) => {
      const texture = makeIslandLabelTexture(feature.properties.name);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), makeScreenLabelMaterial(texture));
      mesh.renderOrder = 80;
      this.hudScene.add(mesh);
      const [lng, lat] = feature.geometry.coordinates;
      return {
        mesh,
        point: lngLatToVector({ lng, lat }),
        size: feature.properties.size ?? 1,
        aspect: texture.userData.aspect ?? 512 / 168,
      };
    });
  }

  // `mapFade` hides the map decorations (route, islands, compass, labels) as the camera moves to
  // the deck; the Earth itself stays as the sea.
  // `referenceProjector` is the same pose at the regular FOV: the compass is sized against it so
  // that widening the view shrinks the compass like everything else.
  update({
    projector,
    referenceProjector,
    width,
    height,
    pixelRatio,
    orbitCenter,
    orbitDistance,
    state,
    settings,
    mapFade,
    earthOpacity,
  }) {
    this.earth.material.uniforms.uEarthOpacity.value = earthOpacity;
    tileStyleUniforms.uMapOpacity.value = settings.mapOpacity * earthOpacity * mapFade;
    this.tiles.group.visible = mapFade > 0.001;
    tileStyleUniforms.uMapInvert.value = settings.mapInvert;
    tileStyleUniforms.uMapBrightness.value = settings.mapBrightness;
    tileStyleUniforms.uMapContrast.value = settings.mapContrast;
    tileStyleUniforms.uMapSaturation.value = settings.mapSaturation;
    tileStyleUniforms.uMapTint.value.set(settings.mapTintRed, settings.mapTintGreen, settings.mapTintBlue);
    if (this.tiles.group.visible) {
      this.tiles.update(projector, width, height);
    }

    this.graticule.group.visible = Boolean(state.showGrid) && mapFade > 0.001;
    if (this.graticule.group.visible) {
      this.graticule.update(orbitCenter, orbitDistance, mapFade);
    }
    this.route.visible = mapFade > 0.001;
    this.route.userData.materials[0].opacity = 0.08 * mapFade;
    this.route.userData.materials[1].opacity = 0.58 * mapFade;
    this.islands.visible = mapFade > 0.001;
    this.islands.material.uniforms.uOpacity.value = mapFade;
    this.islands.material.uniforms.uPixelRatio.value = pixelRatio;
    [this.graticule.major, this.graticule.minor, ...this.route.children].forEach((line) => {
      line.material.resolution.set(width, height);
    });

    // Compass: constant on-screen size, measured from how a small step on the sea projects.
    const markerFade = (state.showCompass ? 1 : 0) * mapFade;
    const markerPixels = targetMarkerPixels(width, height);
    const frame = OBSERVER.frame;
    const voyage = frame.up;
    const base = projector.projectWorld(voyage);
    const referenceBase = referenceProjector.projectWorld(voyage);
    const step = 1e-4;
    const pixelsPerUnit = Math.max(
      ...[frame.east, frame.south].map((axis) => {
        const moved = referenceProjector.projectWorld(voyage.clone().addScaledVector(axis, step));
        return Math.hypot((moved.x - referenceBase.x) * width, (moved.y - referenceBase.y) * height) / 2 / step;
      }),
    );
    const compassVisible = markerFade > 0.001 && base.w > 0 && referenceBase.w > 0
      && Number.isFinite(pixelsPerUnit) && pixelsPerUnit > 0;
    this.compass.anchor.visible = compassVisible;
    if (compassVisible) {
      const scale = (markerPixels * 2) / pixelsPerUnit;
      this.compass.anchor.matrix.makeBasis(frame.east, frame.up, frame.south)
        .setPosition(frame.up.clone().multiplyScalar(1.000001));
      this.compass.scaler.scale.setScalar(scale);
      this.compass.rotator.rotation.y = THREE.MathUtils.degToRad(state.compassRotation ?? 0);
      this.compass.center.material.uniforms.uOpacity.value = 0.78 * markerFade;
      this.compass.compassMaterial.uniforms.uOpacity.value = 0.92 * markerFade;
      this.compass.plane.visible = Boolean(this.compass.compassMaterial.uniforms.uMap.value);
      this.compass.anchor.updateMatrixWorld(true);
    }

    // Screen-space boat and island labels.
    const aspect = width / Math.max(1, height);
    this.hudCamera.left = -aspect;
    this.hudCamera.right = aspect;
    this.hudCamera.updateProjectionMatrix();
    const toHud = (projected) => new THREE.Vector2(projected.x * aspect, projected.y);
    const facing = (point) => point.dot(projector.eye.clone().sub(point)) > 0;

    const boatHeight = markerPixels * 0.48;
    const boatWidth = boatHeight * BOAT_ASPECT_RATIO;
    this.boat.visible = markerFade > 0.001 && base.w > 0 && facing(voyage);
    this.boat.material.opacity = 0.98 * markerFade;
    if (this.boat.visible) {
      const at = toHud(base);
      this.boat.position.set(at.x, at.y + boatHeight / height, 0);
      this.boat.scale.set((boatWidth / width) * 2 * aspect, (boatHeight / height) * 2, 1);
    }

    this.islandLabels.forEach(({ mesh, point, size, aspect: textureAspect }) => {
      const projected = projector.projectWorld(point);
      const labelWidth = THREE.MathUtils.clamp(360 * size, 260, 520);
      const labelHeight = labelWidth / textureAspect;
      const offset = 28 + size * 20;
      mesh.visible = mapFade > 0.001 && projected.w > 0 && facing(point)
        && Math.abs(projected.x) < 1.3 && Math.abs(projected.y) < 1.3;
      mesh.material.opacity = 0.92 * mapFade;
      if (mesh.visible) {
        const at = toHud(projected);
        mesh.position.set(at.x, at.y - (offset * 2) / height, 0);
        mesh.scale.set((labelWidth / width) * 2 * aspect, (labelHeight / height) * 2, 1);
      }
    });
  }

  dispose() {
    this.tiles.dispose();
  }
}

export { vectorToLngLat, localFrame };
