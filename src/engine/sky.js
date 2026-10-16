import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { namedStars, skyBodies, skyBodiesById, VOYAGE_POSITION } from '../taumakoData.js';
import { brightFieldStars } from '../brightStars.js';
import { equatorOfDateToGalactic, localSiderealHours, precessToSkyYear, skyDate, sunAndMoon } from '../astro.js';
import { OBSERVER, VOYAGE_FRAME } from './camera.js';
import {
  PROJECTION_GLSL,
  SKY_VERTEX_PROJECT,
  viewUniforms,
  withViewUniforms,
} from './projection.js';

// The sky: Milky Way panorama, stars, Taumako star bodies and their labels, sun and moon, star
// paths and the horizon grid. Positions are on a sphere of radius SKY_RADIUS_EARTH_RADII in the
// frame of the reference sidereal time; the engine rotates `root` to the current sidereal time.

const STAR_GOLD = '#ffe51e';

const STAR_LINE = '#807818';

const ARC_BLUE = '#1c8dff';

const GRID_BLUE = '#66bdff';

const SKY_RADIUS_EARTH_RADII = 500;

const SKY_HORIZON_Y = 55.5;

const REFERENCE_LST_HOURS = 11;
// Above this FOV the sky view blends from rectilinear toward stereographic.

const SUN_POINT_SIZE = 46;

const MOON_POINT_SIZE = 34;

const ASSET_BASE_URL = import.meta.env.BASE_URL || '/';

let starTexture;

export function assetUrl(path) {
  return `${ASSET_BASE_URL}${path.replace(/^\/+/, '')}`;
}

// Shared by every sky material. When uSkyFisheye is on, sky geometry is projected with a
// general perspective projection: k = 0 is rectilinear, k = 1 is stereographic.

function makeSkyLineMaterial(color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    }),
    vertexShader: `
      ${PROJECTION_GLSL}
      void main() {
        ${SKY_VERTEX_PROJECT}
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity);
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
}

// Fat lines (three's LineMaterial) patched to use the shared projection. `space` is 'sky' for
// directions at infinity or 'surface' for lines on the globe, which hide behind its limb.
export function makeWideLineMaterial(color, opacity, width, space = 'sky') {
  const material = new LineMaterial({
    color,
    linewidth: width,
    opacity,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  Object.assign(material.uniforms, viewUniforms);
  const project = space === 'sky' ? 'projectSkyPosition' : 'projectWorldPosition';
  const hidden = space === 'sky'
    ? 'clipStart.w <= 0.0 || clipEnd.w <= 0.0'
    : 'clipStart.w <= 0.0 || clipEnd.w <= 0.0 || surfaceFacing( start.xyz ) < 0.0 || surfaceFacing( end.xyz ) < 0.0';
  material.vertexShader = material.vertexShader
    .replace('void trimSegment(', `${PROJECTION_GLSL}\nvoid trimSegment(`)
    .replace('vec4 start = modelViewMatrix * vec4( instanceStart, 1.0 );', 'vec4 start = modelMatrix * vec4( instanceStart, 1.0 );')
    .replace('vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );', 'vec4 end = modelMatrix * vec4( instanceEnd, 1.0 );')
    .replace('vec4 clipStart = projectionMatrix * start;', `vec4 clipStart = ${project}( start.xyz );`)
    .replace('vec4 clipEnd = projectionMatrix * end;', `vec4 clipEnd = ${project}( end.xyz );`)
    .replace(
      'gl_Position = clip;',
      `gl_Position = clip;
      if ( ${hidden} ) {
        gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
      }`,
    );
  material.needsUpdate = true;
  return material;
}

function makeSkyFieldStarMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      uMap: { value: getStarTexture() },
      uOpacity: { value: 0.78 },
      uSizeScale: { value: 1 },
    }),
    vertexShader: `
      ${PROJECTION_GLSL}
      attribute vec3 color;
      attribute float alpha;
      attribute float starSize;
      uniform float uSizeScale;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vColor = color;
        vAlpha = alpha;
        ${SKY_VERTEX_PROJECT}
        gl_PointSize = starSize * uSizeScale;
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform float uOpacity;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec4 texel = texture2D(uMap, gl_PointCoord);
        float alpha = texel.a * uOpacity * vAlpha;
        if (alpha < 0.05) discard;
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
}

function makeSkyNamedStarMaterial(size) {
  return new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      uColor: { value: new THREE.Color(STAR_GOLD) },
      uMap: { value: getStarTexture() },
      uOpacity: { value: 0.95 },
      uSize: { value: size },
    }),
    vertexShader: `
      ${PROJECTION_GLSL}
      uniform float uSize;
      void main() {
        ${SKY_VERTEX_PROJECT}
        gl_PointSize = uSize;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform sampler2D uMap;
      uniform float uOpacity;
      void main() {
        vec4 texel = texture2D(uMap, gl_PointCoord);
        float alpha = texel.a * uOpacity;
        if (alpha < 0.05) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
}

export function makeScreenLabelMaterial(texture) {
  return new THREE.MeshBasicMaterial({
    map: texture,
    opacity: 0.96,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function makeSkySolidMaterial(color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
    }),
    vertexShader: `
      ${PROJECTION_GLSL}
      void main() {
        ${SKY_VERTEX_PROJECT}
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        gl_FragColor = vec4(uColor, uOpacity);
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

export function getStarTexture() {
  if (starTexture) {
    return starTexture;
  }

  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.translate(48, 48);
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const radius = i % 2 === 0 ? 42 : 17;
    const angle = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 8;
  ctx.fill();

  starTexture = new THREE.CanvasTexture(canvas);
  starTexture.colorSpace = THREE.SRGBColorSpace;
  return starTexture;
}

const LABEL_STYLES = {
  default: { title: '#ffd75d', subtitle: 'rgba(255, 225, 116, 0.92)' },
  dark: { title: '#b9d4ff', subtitle: 'rgba(185, 212, 255, 0.82)' },
  sequence: { title: '#ffc98a', subtitle: 'rgba(255, 210, 160, 0.86)' },
};

function makeLabelTexture(name, association, style = 'default') {
  const colors = LABEL_STYLES[style] ?? LABEL_STYLES.default;
  const canvas = document.createElement('canvas');
  const width = 1024;
  const height = 308;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = colors.title;
  ctx.font = `${style === 'dark' ? 'italic ' : ''}700 84px "Trebuchet MS", sans-serif`;
  ctx.fillText(name, 36, 120);
  let textWidth = 36 + ctx.measureText(name).width;
  if (association) {
    ctx.shadowBlur = 16;
    ctx.fillStyle = colors.subtitle;
    ctx.font = '500 48px "Trebuchet MS", sans-serif';
    ctx.fillText(association, 40, 196);
    textWidth = Math.max(textWidth, 40 + ctx.measureText(association).width);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.userData.aspect = width / height;
  // Fractional bounds of the drawn text inside the texture, used for label collision.
  texture.userData.textBounds = {
    left: 30 / width,
    right: Math.min(width, textWidth + 6) / width,
    top: 46 / height,
    bottom: (association ? 214 : 140) / height,
  };
  return texture;
}

function pctToSkyPosition(x, y, radius = SKY_RADIUS_EARTH_RADII) {
  const azimuth = THREE.MathUtils.degToRad(((x - 50) / 50) * 82);
  const altitude = THREE.MathUtils.degToRad(((SKY_HORIZON_Y - y) / SKY_HORIZON_Y) * 78);
  const horizontal = Math.cos(altitude);

  return new THREE.Vector3()
    .addScaledVector(VOYAGE_FRAME.south, Math.cos(azimuth) * horizontal)
    .addScaledVector(VOYAGE_FRAME.east, -Math.sin(azimuth) * horizontal)
    .addScaledVector(VOYAGE_FRAME.up, Math.sin(altitude))
    .normalize()
    .multiplyScalar(radius);
}

// Expects equator-of-date coordinates; the sky frame is fixed at REFERENCE_LST_HOURS.

// Expects equator-of-date coordinates; the sky frame is fixed at REFERENCE_LST_HOURS.
export function equatorialDateToSkyPosition({ ra, dec }, radius = SKY_RADIUS_EARTH_RADII) {
  const latitude = THREE.MathUtils.degToRad(VOYAGE_POSITION.lat);
  const hourAngle = THREE.MathUtils.degToRad((REFERENCE_LST_HOURS - ra) * 15);
  const declination = THREE.MathUtils.degToRad(dec);
  const cosDec = Math.cos(declination);
  const east = -cosDec * Math.sin(hourAngle);
  const north = Math.cos(latitude) * Math.sin(declination)
    - Math.sin(latitude) * cosDec * Math.cos(hourAngle);
  const up = Math.sin(latitude) * Math.sin(declination)
    + Math.cos(latitude) * cosDec * Math.cos(hourAngle);

  return new THREE.Vector3()
    .addScaledVector(VOYAGE_FRAME.east, east)
    .addScaledVector(VOYAGE_FRAME.south, -north)
    .addScaledVector(VOYAGE_FRAME.up, up)
    .normalize()
    .multiplyScalar(radius);
}

// Expects J2000 catalog coordinates.

// Expects J2000 catalog coordinates.
function equatorialToSkyPosition(star, radius = SKY_RADIUS_EARTH_RADII) {
  return equatorialDateToSkyPosition(precessToSkyYear(star), radius);
}

function makeSkyToGalacticMatrix() {
  const axes = [
    equatorialDateToSkyPosition({ ra: 0, dec: 0 }, 1),
    equatorialDateToSkyPosition({ ra: 6, dec: 0 }, 1),
    equatorialDateToSkyPosition({ ra: 0, dec: 90 }, 1),
  ];
  const basis = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const columns = basis.map((direction) => new THREE.Vector3(
    ...equatorOfDateToGalactic(axes.map((axis) => axis.dot(direction))),
  ));
  return new THREE.Matrix3().set(
    columns[0].x, columns[1].x, columns[2].x,
    columns[0].y, columns[1].y, columns[2].y,
    columns[0].z, columns[1].z, columns[2].z,
  );
}

function visualSizeForMagnitude(magnitude) {
  return THREE.MathUtils.clamp(1.5 - (magnitude + 1.5) * 0.18, 0.34, 1.62);
}

function clamp01(value) {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function makeWorldLine(points, color, opacity, options = {}) {
  const { wide = false, width = 1 } = options;

  if (wide) {
    const geometry = new LineGeometry();
    geometry.setFromPoints(points);
    return new Line2(geometry, makeWideLineMaterial(color, opacity, width));
  }

  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    makeSkyLineMaterial(color, opacity),
  );
}

// Samples the great circle between two sky positions so long lines curve correctly under fisheye.

// Samples the great circle between two sky positions so long lines curve correctly under fisheye.
export function greatCirclePoints(from, to, maxStepDegrees = 2) {
  const angle = from.angleTo(to);
  const steps = Math.max(1, Math.ceil(THREE.MathUtils.radToDeg(angle) / maxStepDegrees));
  if (steps === 1) {
    return [from, to];
  }
  const radius = from.length();
  const a = from.clone().normalize();
  const b = to.clone().normalize();
  const sinAngle = Math.sin(angle);
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    return a.clone().multiplyScalar(Math.sin((1 - t) * angle) / sinAngle)
      .add(b.clone().multiplyScalar(Math.sin(t * angle) / sinAngle))
      .multiplyScalar(radius);
  });
}

function makeSkyArrowFromPoints(tip, previous, color, opacity) {
  const radius = tip.length();
  const radial = tip.clone().normalize();
  const tangent = tip.clone().sub(previous).projectOnPlane(radial).normalize();
  const side = new THREE.Vector3().crossVectors(radial, tangent).normalize();
  const baseCenter = tip.clone().addScaledVector(tangent, -radius * 0.008);
  const baseA = baseCenter.clone().addScaledVector(side, radius * 0.0035);
  const baseB = baseCenter.clone().addScaledVector(side, -radius * 0.0035);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([
      tip.x,
      tip.y,
      tip.z,
      baseA.x,
      baseA.y,
      baseA.z,
      baseB.x,
      baseB.y,
      baseB.z,
    ], 3),
  );
  return new THREE.Mesh(geometry, makeSkySolidMaterial(color, opacity));
}

function makeSkyGrid(positionForSky = pctToSkyPosition) {
  const group = new THREE.Group();

  for (let y = 12; y <= SKY_HORIZON_Y; y += 10.5) {
    const points = [];
    for (let x = 0; x <= 100; x += 2) {
      points.push(positionForSky(x, y, SKY_RADIUS_EARTH_RADII * 0.992));
    }
    group.add(makeWorldLine(
      points,
      GRID_BLUE,
      y === SKY_HORIZON_Y ? 0.72 : 0.34,
      { wide: true, width: y === SKY_HORIZON_Y ? 2.4 : 1.35 },
    ));
  }

  for (let x = 4; x <= 96; x += 9.2) {
    const points = [];
    for (let y = 4; y <= 95; y += 3) {
      points.push(positionForSky(x, y, SKY_RADIUS_EARTH_RADII * 0.99));
    }
    group.add(makeWorldLine(points, GRID_BLUE, 0.28, { wide: true, width: 1.15 }));
  }

  return group;
}

function altitudeToDiagramY(altitudeDegrees) {
  return SKY_HORIZON_Y - (altitudeDegrees / 78) * SKY_HORIZON_Y;
}

function makeDiurnalBasis(positionForSky) {
  const poleAltitude = Math.abs(VOYAGE_POSITION.lat);
  const axis = positionForSky(50, altitudeToDiagramY(poleAltitude), SKY_RADIUS_EARTH_RADII).normalize();
  const highMeridian = positionForSky(50, altitudeToDiagramY(70), SKY_RADIUS_EARTH_RADII).normalize();
  let meridian = highMeridian.clone().projectOnPlane(axis);

  if (meridian.lengthSq() < 0.000001) {
    meridian = new THREE.Vector3(1, 0, 0).projectOnPlane(axis);
  }

  meridian.normalize();

  const eastWest = new THREE.Vector3().crossVectors(axis, meridian).normalize();
  const rightReference = positionForSky(58, altitudeToDiagramY(45), SKY_RADIUS_EARTH_RADII)
    .sub(positionForSky(50, altitudeToDiagramY(45), SKY_RADIUS_EARTH_RADII))
    .normalize();

  if (eastWest.dot(rightReference) < 0) {
    eastWest.negate();
  }

  return { axis, meridian, eastWest };
}

function diurnalPoint({ axis, meridian, eastWest }, separationDegrees, phaseRadians, radius = SKY_RADIUS_EARTH_RADII) {
  const separation = THREE.MathUtils.degToRad(separationDegrees);
  return new THREE.Vector3()
    .addScaledVector(axis, Math.cos(separation) * radius)
    .addScaledVector(meridian, Math.sin(separation) * Math.cos(phaseRadians) * radius)
    .addScaledVector(eastWest, Math.sin(separation) * Math.sin(phaseRadians) * radius);
}

function makeStarMotionPaths(diurnalBasis) {
  const group = new THREE.Group();
  const separations = [];

  for (let separation = 5; separation <= 175; separation += 10) {
    separations.push(separation);
  }

  separations.forEach((separationDegrees) => {
    const linePoints = [];
    const samples = 180;

    for (let i = 0; i <= samples; i += 1) {
      const phase = (i / samples) * Math.PI * 2;
      linePoints.push(diurnalPoint(diurnalBasis, separationDegrees, phase, SKY_RADIUS_EARTH_RADII * 0.984));
    }

    group.add(makeWorldLine(linePoints, ARC_BLUE, 0.42, { wide: true, width: 2.25 }));

    for (let i = 0; i < 12; i += 1) {
      const phase = (i / 12) * Math.PI * 2;
      const tip = diurnalPoint(diurnalBasis, separationDegrees, phase, SKY_RADIUS_EARTH_RADII * 0.986);
      const previous = diurnalPoint(
        diurnalBasis,
        separationDegrees,
        phase - 0.055,
        SKY_RADIUS_EARTH_RADII * 0.986,
      );
      group.add(makeSkyArrowFromPoints(tip, previous, ARC_BLUE, 0.7));
    }
  });

  return group;
}

function makeWorldFieldStars() {
  const positions = [];
  const colors = [];
  const sizes = [];
  const alphas = [];

  function pushStar(position, brightness, size, alpha, tint = 0.5) {
    positions.push(position.x, position.y, position.z);
    const warm = tint < 0.38;
    const cool = tint > 0.72;
    colors.push(
      Math.min(1, brightness * (warm ? 1.12 : cool ? 0.88 : 1)),
      Math.min(1, brightness * (warm ? 1.01 : cool ? 0.95 : 0.98)),
      Math.min(1, brightness * (warm ? 0.76 : cool ? 1.18 : 1.05)),
    );
    sizes.push(size);
    alphas.push(alpha);
  }

  brightFieldStars.forEach(([, ra, dec, mag]) => {
    const size = THREE.MathUtils.clamp(7.1 - mag * 1.05, 2.1, 8.8);
    const alpha = THREE.MathUtils.clamp(1.02 - (mag + 1.5) * 0.12, 0.32, 0.94);
    const brightness = THREE.MathUtils.clamp(1.04 - Math.max(mag, -1.5) * 0.1, 0.62, 1);
    const tint = dec < -35 ? 0.74 : dec > 20 ? 0.42 : 0.55;
    const position = equatorialToSkyPosition({ ra, dec }, SKY_RADIUS_EARTH_RADII * 0.998);
    pushStar(position, brightness, size, alpha, tint);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('starSize', new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('alpha', new THREE.Float32BufferAttribute(alphas, 1));

  return new THREE.Points(
    geometry,
    makeSkyFieldStarMaterial(),
  );
}

const SKY_NOISE_GLSL = `
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(
        mix(hash13(i), hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 0.0)), hash13(i + vec3(1.0, 1.0, 0.0)), f.x),
        f.y
      ),
      mix(
        mix(hash13(i + vec3(0.0, 0.0, 1.0)), hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash13(i + vec3(0.0, 1.0, 1.0)), hash13(i + vec3(1.0, 1.0, 1.0)), f.x),
        f.y
      ),
      f.z
    );
  }

  float fbm(vec3 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      total += valueNoise(p) * amplitude;
      p = p * 2.03 + 17.1;
      amplitude *= 0.5;
    }
    return total;
  }
`;

// NOIRLab 360° Milky Way panorama (noirlab2430b), equirectangular in galactic coordinates
// with the galactic center in the middle and longitude increasing to the left.
// Credit: NOIRLab/NSF/AURA/E. Slawik/M. Zamani (CC BY 4.0).

// NOIRLab 360° Milky Way panorama (noirlab2430b), equirectangular in galactic coordinates
// with the galactic center in the middle and longitude increasing to the left.
// Credit: NOIRLab/NSF/AURA/E. Slawik/M. Zamani (CC BY 4.0).
const SKY_IMAGE_URLS = [
  { url: '/milky-way-4k.webp', width: 4096 },
  { url: '/milky-way-8k.webp', width: 8192 },
];

const SKY_IMAGE_OPACITY = 0.9;

function makeMilkyWay() {
  const material = new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      uGalactic: { value: makeSkyToGalacticMatrix() },
      uOpacity: { value: SKY_IMAGE_OPACITY },
      uMap: { value: null },
      uExposure: { value: 0 },
      uGamma: { value: 1.25 },
      uContrast: { value: 1 },
      uBrightness: { value: 0 },
      uSaturation: { value: 1 },
      uBlackPoint: { value: 0.015 },
    }),
    vertexShader: `
      ${PROJECTION_GLSL}
      varying vec3 vDirection;
      void main() {
        vDirection = position;
        ${SKY_VERTEX_PROJECT}
      }
    `,
    fragmentShader: `
      uniform mat3 uGalactic;
      uniform float uOpacity;
      uniform sampler2D uMap;
      uniform float uExposure;
      uniform float uGamma;
      uniform float uContrast;
      uniform float uBrightness;
      uniform float uSaturation;
      uniform float uBlackPoint;
      varying vec3 vDirection;

      void main() {
        vec3 g = normalize(uGalactic * normalize(vDirection));
        float l = atan(g.y, g.x);
        float b = asin(clamp(g.z, -1.0, 1.0));
        float u = 0.5 - l / 6.28318530718;
        float v = 0.5 + b / 3.14159265359;
        // Pick whichever u parameterization is continuous here so mipmapping has no seam at l = 180°.
        float uA = fract(u);
        float uB = fract(u + 0.5) - 0.5;
        u = fwidth(uA) <= fwidth(uB) + 0.000001 ? uA : uB;
        vec3 color = texture2D(uMap, vec2(u, v)).rgb;
        // Drop the panorama's faint black level so it adds only light to the sky color.
        color = max(color - uBlackPoint, 0.0) / max(1.0 - uBlackPoint, 0.001);
        color = pow(color, vec3(uGamma)) * exp2(uExposure) * 1.1;
        color = (color - 0.18) * uContrast + 0.18 + uBrightness;
        float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color = max(mix(vec3(luma), color, uSaturation), 0.0);
        gl_FragColor = vec4(color * uOpacity, 1.0);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS_EARTH_RADII * 0.999, 128, 64), material);
  mesh.renderOrder = -10;
  mesh.visible = false;
  return mesh;
}

// Loads the low-resolution panorama first, then upgrades if the GPU supports larger textures.

// Loads the low-resolution panorama first, then upgrades if the GPU supports larger textures.
export function loadSkyImage(mesh, renderer, onLoad) {
  const loader = new THREE.TextureLoader();
  const maxSize = renderer.capabilities.maxTextureSize;
  const sources = SKY_IMAGE_URLS.filter(({ width }) => width <= maxSize);
  let bestLoaded = -1;
  sources.forEach(({ url }, index) => {
    loader.load(assetUrl(url), (texture) => {
      if (index < bestLoaded) {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      mesh.material.uniforms.uMap.value?.dispose();
      mesh.material.uniforms.uMap.value = texture;
      mesh.userData.loaded = true;
      bestLoaded = index;
      onLoad?.();
    });
  });
}

function makeSunSprite() {
  const material = new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      uOpacity: { value: 1 },
      uSize: { value: SUN_POINT_SIZE },
    }),
    vertexShader: `
      ${PROJECTION_GLSL}
      uniform float uSize;
      void main() {
        ${SKY_VERTEX_PROJECT}
        gl_PointSize = uSize;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float disk = 1.0 - smoothstep(0.3, 0.36, r);
        float glow = exp(-r * r * 3.5) * 0.85 * (1.0 - smoothstep(0.8, 1.0, r));
        float alpha = clamp(disk + glow, 0.0, 1.0) * uOpacity;
        if (alpha < 0.01) discard;
        vec3 color = mix(vec3(1.0, 0.66, 0.18), vec3(1.0, 0.95, 0.7), disk);
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const sun = new THREE.Points(geometry, material);
  sun.renderOrder = 5;
  return sun;
}

function makeMoonSprite() {
  const material = new THREE.ShaderMaterial({
    uniforms: withViewUniforms({
      uOpacity: { value: 1 },
      uSize: { value: MOON_POINT_SIZE },
      // xy: screen direction toward the sun, z: phase angle (0 = full, PI = new).
      uLight: { value: new THREE.Vector3(1, 0, 0) },
    }),
    vertexShader: `
      ${PROJECTION_GLSL}
      uniform float uSize;
      void main() {
        ${SKY_VERTEX_PROJECT}
        gl_PointSize = uSize;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      uniform vec3 uLight;
      ${SKY_NOISE_GLSL}
      void main() {
        vec2 c = (gl_PointCoord - 0.5) * 2.0;
        c.y = -c.y;
        float r = length(c) / 0.82;
        float glow = exp(-r * r * 2.2) * 0.22;
        if (r > 1.0) {
          if (glow < 0.01) discard;
          gl_FragColor = vec4(vec3(0.85, 0.9, 1.0), glow * uOpacity);
          return;
        }
        vec3 normal = vec3(c / 0.82, sqrt(max(0.0, 1.0 - r * r)));
        vec3 light = vec3(normalize(uLight.xy) * sin(uLight.z), cos(uLight.z));
        float lit = smoothstep(-0.04, 0.06, dot(normal, light));
        float maria = 0.82 + 0.18 * fbm(vec3(normal.xy * 2.6, 1.7));
        float edge = 1.0 - smoothstep(0.93, 1.0, r);
        vec3 color = mix(vec3(0.1, 0.12, 0.2), vec3(0.97, 0.96, 0.9) * maria, lit);
        float alpha = mix(0.55, 1.0, lit) * edge;
        gl_FragColor = vec4(color, max(alpha, glow) * uOpacity);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const moon = new THREE.Points(geometry, material);
  moon.renderOrder = 6;
  return moon;
}

export function setPointPosition(points, position) {
  const attribute = points.geometry.getAttribute('position');
  attribute.setXYZ(0, position.x, position.y, position.z);
  attribute.needsUpdate = true;
}

function makeWorldStar(star) {
  const position = equatorialToSkyPosition(star, SKY_RADIUS_EARTH_RADII);
  const size = visualSizeForMagnitude(star.mag);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([position.x, position.y, position.z], 3));

  return new THREE.Points(
    geometry,
    makeSkyNamedStarMaterial(11 * size + 3),
  );
}

const DARK_SHAPE_COLOR = '#8fb8ff';

const SEQUENCE_COLOR = '#ffb46b';

function centroidDirection(positions) {
  const position = positions
    .reduce((total, point) => total.add(point.clone().normalize()), new THREE.Vector3());
  if (position.lengthSq() < 0.000001) {
    return positions[0].clone().normalize();
  }
  return position.normalize();
}

function bodyStarPositions(body) {
  return (body?.stars ?? []).map((star) => equatorialToSkyPosition(star, SKY_RADIUS_EARTH_RADII));
}

function bodyLabelDirection(body) {
  if (body.labelAt) {
    return equatorialToSkyPosition(body.labelAt, 1);
  }
  if (body.labelStar) {
    return equatorialToSkyPosition(namedStars[body.labelStar], 1);
  }
  if (body.anchor) {
    return equatorialToSkyPosition(body.anchor, 1);
  }
  if (body.path) {
    return centroidDirection(body.path.map((point) => equatorialToSkyPosition(point, 1)));
  }
  if (body.sequence) {
    return centroidDirection(body.sequence.flatMap((id) => bodyStarPositions(skyBodiesById[id])));
  }
  if (body.stars?.length) {
    return centroidDirection(bodyStarPositions(body));
  }
  return null;
}

const LABEL_PRIORITY = { Constellation: 0, 'Dark shape': 1, Star: 2, Sequence: 3 };

// Unit directions (at the reference sidereal time) that a body covers, for camera framing.

// Unit directions (at the reference sidereal time) that a body covers, for camera framing.
function bodyFocusPoints(body) {
  const mapped = skyBodies.flatMap((figure) => (
    Object.entries(figure.starBodies ?? {})
      .filter(([, id]) => id === body.id)
      .map(([index]) => equatorialToSkyPosition(figure.stars[Number(index)], 1))
  ));
  if (mapped.length) {
    return mapped;
  }
  if (body.stars?.length) {
    return body.stars.map((star) => equatorialToSkyPosition(star, 1));
  }
  if (body.labelStar) {
    return [equatorialToSkyPosition(namedStars[body.labelStar], 1)];
  }
  if (body.path) {
    return body.path.map((point) => equatorialToSkyPosition(point, 1));
  }
  if (body.sequence) {
    return body.sequence.flatMap((id) => bodyFocusPoints(skyBodiesById[id]));
  }
  if (body.anchor) {
    return [equatorialToSkyPosition(body.anchor, 1)];
  }
  return [];
}

function labelStyleForBody(body) {
  if (body.kind === 'Dark shape') {
    return 'dark';
  }
  if (body.kind === 'Sequence') {
    return 'sequence';
  }
  return 'default';
}

function makeWorldLabel(body) {
  const direction = bodyLabelDirection(body);
  if (!direction) {
    return null;
  }
  const subtitle = [body.translation, body.western].filter(Boolean).join(' · ');
  const texture = makeLabelTexture(body.name, subtitle, labelStyleForBody(body));
  const position = direction.multiplyScalar(SKY_RADIUS_EARTH_RADII * 0.975);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    makeScreenLabelMaterial(texture),
  );
  mesh.renderOrder = 20;
  return {
    mesh,
    position,
    id: body.id,
    aspect: texture.userData.aspect ?? 512 / 154,
    textBounds: texture.userData.textBounds,
    priority: LABEL_PRIORITY[body.kind] ?? 4,
    size: body.labelSize ?? (body.kind === 'Star' ? 0.72 : 1),
  };
}

export function makeWorldSky(positionForSky = pctToSkyPosition) {
  const root = new THREE.Group();
  const starMotionGroup = new THREE.Group();
  const labelGroup = new THREE.Group();
  const pathGroup = new THREE.Group();
  const diurnalBasis = makeDiurnalBasis(positionForSky);
  const gridGroup = new THREE.Group();
  const fieldStars = makeWorldFieldStars();
  const milkyWay = makeMilkyWay();
  const sun = makeSunSprite();
  const moon = makeMoonSprite();
  const constellationGroups = [];
  const screenLabels = [];
  const starHitTargets = [];
  const lineHitTargets = [];

  root.add(milkyWay);
  root.add(gridGroup);
  root.add(fieldStars);
  root.add(sun);
  root.add(moon);
  root.add(starMotionGroup);
  root.add(pathGroup);
  root.add(labelGroup);

  pathGroup.add(makeStarMotionPaths(diurnalBasis));

  const addPathLine = (id, from, to, color, opacity, width) => {
    starMotionGroup.add(makeWorldLine(greatCirclePoints(from, to), color, opacity, { wide: true, width }));
    lineHitTargets.push({ id, from, to, radius: 13 });
  };

  skyBodies.forEach((body) => {
    if (body.stars?.length) {
      const group = new THREE.Group();
      const starPositions = bodyStarPositions(body);

      body.lines.forEach(([from, to], index) => {
        group.add(makeWorldLine(
          greatCirclePoints(starPositions[from], starPositions[to]),
          STAR_LINE,
          0.6,
          { wide: true, width: 3.2 },
        ));
        lineHitTargets.push({
          id: body.lineBodies?.[index] ?? body.id,
          from: starPositions[from],
          to: starPositions[to],
          radius: 13,
        });
      });

      body.stars.forEach((star) => {
        group.add(makeWorldStar(star));
      });

      starPositions.forEach((position, index) => {
        const star = body.stars[index];
        const size = visualSizeForMagnitude(star.mag);
        starHitTargets.push({
          id: body.starBodies?.[index] ?? body.id,
          position,
          radius: 14 + size * 9,
        });
      });

      starMotionGroup.add(group);
      constellationGroups.push({ group });
    }

    if (body.path) {
      const points = body.path.map((point) => equatorialToSkyPosition(point, SKY_RADIUS_EARTH_RADII));
      for (let index = 1; index < points.length; index += 1) {
        addPathLine(body.id, points[index - 1], points[index], DARK_SHAPE_COLOR, 0.32, 2.2);
      }
    }

    if (body.anchor) {
      starHitTargets.push({
        id: body.id,
        position: equatorialToSkyPosition(body.anchor, SKY_RADIUS_EARTH_RADII),
        radius: 34,
      });
    }

    if (body.sequence) {
      const points = body.sequence.map((id) => (
        centroidDirection(bodyStarPositions(skyBodiesById[id])).multiplyScalar(SKY_RADIUS_EARTH_RADII)
      ));
      for (let index = 1; index < points.length; index += 1) {
        addPathLine(body.id, points[index - 1], points[index], SEQUENCE_COLOR, 0.34, 2);
      }
    }

    const label = makeWorldLabel(body);
    if (label) {
      screenLabels.push(label);
    }
  });

  // Higher-priority labels claim screen space first; see updateScreenLabels.
  screenLabels.sort((a, b) => a.priority - b.priority);

  root.traverse((child) => {
    child.frustumCulled = false;
  });

  return {
    root,
    starMotionGroup,
    labelGroup,
    pathGroup,
    gridGroup,
    fieldStars,
    milkyWay,
    sun,
    moon,
    constellationGroups,
    screenLabels,
    starHitTargets,
    lineHitTargets,
    diurnalAxis: diurnalBasis.axis,
  };
}

export function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry) {
      child.geometry.dispose();
    }
    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach((material) => material.dispose());
      } else {
        child.material.dispose();
      }
    }
  });
}

export function updateWideLineResolutions(object, width, height) {
  object.traverse((child) => {
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (material?.isLineMaterial) {
        material.resolution.set(width, height);
      }
    });
  });
}

export function setMaterialOpacityScale(material, scale) {
  if (!material) {
    return;
  }

  if (material.uniforms?.uOpacity) {
    material.userData.baseUOpacity ??= material.uniforms.uOpacity.value;
    material.uniforms.uOpacity.value = material.userData.baseUOpacity * scale;
    return;
  }

  if (typeof material.opacity === 'number') {
    material.userData.baseOpacity ??= material.opacity;
    material.opacity = material.userData.baseOpacity * scale;
  }
}

export function applyVisualSettings(worldSky, settings) {
  const skyUniformsForImage = worldSky.milkyWay.material.uniforms;
  skyUniformsForImage.uExposure.value = settings.skyExposure;
  skyUniformsForImage.uGamma.value = settings.skyGamma;
  skyUniformsForImage.uContrast.value = settings.skyContrast;
  skyUniformsForImage.uBrightness.value = settings.skyBrightness;
  skyUniformsForImage.uSaturation.value = settings.skySaturation;
  skyUniformsForImage.uBlackPoint.value = settings.skyBlackPoint;

  const fieldStarUniforms = worldSky.fieldStars.material.uniforms;
  fieldStarUniforms.uSizeScale.value = settings.fieldStarSize;
  fieldStarUniforms.uOpacity.value = settings.fieldStarOpacity;

  worldSky.constellationGroups.forEach(({ group }) => {
    group.children.forEach((child) => {
      if (child.material?.isLineMaterial) {
        child.material.linewidth = settings.lineWidth;
        child.material.opacity = settings.lineOpacity;
      } else if (child.material?.uniforms?.uSize) {
        child.userData.baseSize ??= child.material.uniforms.uSize.value;
        child.material.uniforms.uSize.value = child.userData.baseSize * settings.namedStarSize;
        child.material.uniforms.uOpacity.value = settings.namedStarOpacity;
      }
    });
  });

  worldSky.pathGroup.traverse((child) => {
    setMaterialOpacityScale(child.material, settings.pathOpacity);
  });
}

let focusDiurnalAxis = null;

// Current look direction (sky camera yaw/pitch in degrees) and angular extent of a sky body.

// Current look direction (sky camera yaw/pitch in degrees) and angular extent of a sky body.
export function skyBodyView(bodyId, dayOfYear, phase) {
  const body = skyBodiesById[bodyId];
  if (!body) {
    return null;
  }
  const points = bodyFocusPoints(body);
  if (!points.length) {
    return null;
  }
  const date = skyDate(dayOfYear ?? 1, (phase ?? 0) / 15);
  const siderealAngle = THREE.MathUtils.degToRad((localSiderealHours(date) - REFERENCE_LST_HOURS) * 15);
  focusDiurnalAxis ??= makeDiurnalBasis(pctToSkyPosition).axis;
  const rotation = new THREE.Quaternion().setFromAxisAngle(focusDiurnalAxis, siderealAngle);
  const center = (body.labelAt
    ? equatorialToSkyPosition(body.labelAt, 1)
    : centroidDirection(points)).applyQuaternion(rotation);
  const radiusDegrees = points.reduce(
    (largest, point) => Math.max(largest, THREE.MathUtils.radToDeg(point.clone().applyQuaternion(rotation).angleTo(center))),
    0,
  );
  const south = center.dot(OBSERVER.frame.south);
  const east = center.dot(OBSERVER.frame.east);
  const up = center.dot(OBSERVER.frame.up);
  return {
    yaw: THREE.MathUtils.radToDeg(Math.atan2(-east, south)),
    pitch: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(up, -1, 1))),
    radius: radiusDegrees,
  };
}

// Sets the sun and moon positions; the moon moves ~0.5° per hour, so callers recompute about once
// per sky minute.
export function updateSunAndMoon(worldSky, date) {
  const { sun, moon } = sunAndMoon(date);
  worldSky.sunPosition = equatorialDateToSkyPosition(sun, SKY_RADIUS_EARTH_RADII * 0.996);
  worldSky.moonPosition = equatorialDateToSkyPosition(moon, SKY_RADIUS_EARTH_RADII * 0.995);
  setPointPosition(worldSky.sun, worldSky.sunPosition);
  setPointPosition(worldSky.moon, worldSky.moonPosition);
}

export function siderealRotation(date) {
  const angle = THREE.MathUtils.degToRad((localSiderealHours(date) - REFERENCE_LST_HOURS) * 15);
  return angle;
}

// Points the moon's lit limb toward the sun as seen on screen.
export function updateMoonLimb(worldSky, projector, width, height) {
  if (!worldSky.moon.visible || !worldSky.moonPosition) {
    return;
  }
  const rotation = worldSky.root.quaternion;
  const moonDirection = worldSky.moonPosition.clone().applyQuaternion(rotation).normalize();
  const sunDirection = worldSky.sunPosition.clone().applyQuaternion(rotation).normalize();
  const towardSun = sunDirection.clone().addScaledVector(moonDirection, -moonDirection.dot(sunDirection)).normalize();
  const phaseAngle = Math.PI - moonDirection.angleTo(sunDirection);
  const moonScreen = projector.projectSky(moonDirection);
  const limbScreen = projector.projectSky(moonDirection.clone().addScaledVector(towardSun, 0.01));
  const limb = new THREE.Vector2((limbScreen.x - moonScreen.x) * width, (limbScreen.y - moonScreen.y) * height);
  if (limb.lengthSq() > 0) {
    limb.normalize();
  } else {
    limb.set(1, 0);
  }
  worldSky.moon.material.uniforms.uLight.value.set(limb.x, limb.y, phaseAngle);
}

// Places the screen-space sky labels (hiding ones that overlap a higher-priority label or sit
// below the horizon) and returns the click targets for labels, stars and lines.
export function updateSkyLabelsAndHits(worldSky, { projector, width, height, showLabels, labelSize, occluded }) {
  const aspect = width / Math.max(1, height);
  const rotation = worldSky.root.quaternion;
  const toScreen = ({ x, y }) => ({ x: ((x + 1) / 2) * width, y: ((1 - y) / 2) * height });
  const project = (position) => {
    const direction = position.clone().applyQuaternion(rotation).normalize();
    if (occluded(direction)) {
      return null;
    }
    const projected = projector.projectSky(direction);
    return projected.w > 0 ? projected : null;
  };
  const hitTargets = [];
  const labelWidthPixels = (width < 700 ? 232 : 336) * labelSize;
  const placedRects = [];

  worldSky.screenLabels.forEach(({ mesh, position, id, aspect: textureAspect, textBounds, size = 1 }) => {
    const labelWidth = labelWidthPixels * size;
    const labelHeight = labelWidth / textureAspect;
    const projected = showLabels ? project(position) : null;
    mesh.visible = Boolean(projected) && Math.abs(projected.x) < 1.18 && Math.abs(projected.y) < 1.18;
    if (!mesh.visible) {
      return;
    }
    const bounds = textBounds ?? { left: 0, right: 1, top: 0, bottom: 1 };
    const center = toScreen(projected);
    const left = center.x - labelWidth / 2;
    const top = center.y - labelHeight / 2;
    const rect = {
      left: left + labelWidth * bounds.left,
      right: left + labelWidth * bounds.right,
      top: top + labelHeight * bounds.top,
      bottom: top + labelHeight * bounds.bottom,
    };
    if (placedRects.some((other) => (
      rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top
    ))) {
      mesh.visible = false;
      return;
    }
    placedRects.push(rect);
    mesh.position.set(projected.x * aspect, projected.y, 0);
    mesh.scale.set((labelWidth / width) * 2 * aspect, (labelHeight / height) * 2, 1);
    hitTargets.push({
      id,
      x: (rect.left + rect.right) / 2,
      y: (rect.top + rect.bottom) / 2,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    });
  });

  worldSky.starHitTargets.forEach(({ id, position, radius }) => {
    const projected = project(position);
    if (projected && Math.abs(projected.x) < 1.08 && Math.abs(projected.y) < 1.08) {
      hitTargets.push({ id, ...toScreen(projected), radius });
    }
  });

  worldSky.lineHitTargets.forEach(({ id, from, to, radius }) => {
    const a = project(from);
    const b = project(to);
    if (a && b && Math.abs(a.x) < 1.12 && Math.abs(a.y) < 1.12 && Math.abs(b.x) < 1.12 && Math.abs(b.y) < 1.12) {
      const start = toScreen(a);
      const end = toScreen(b);
      hitTargets.push({ id, x1: start.x, y1: start.y, x2: end.x, y2: end.y, radius });
    }
  });

  return hitTargets;
}
