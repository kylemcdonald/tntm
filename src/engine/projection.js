import * as THREE from 'three';

// Every object in the scene (sky, globe, tiles, overlays) is drawn with one general perspective
// projection: k = 0 is rectilinear, k = 1 is stereographic. k is picked from the field of view, so
// wide views turn into a fisheye smoothly and nothing is ever composited between projections.
export const FISHEYE_START_FOV = 70;
const FISHEYE_FULL_FOV = 130;
// Geometry near the point behind the viewer would wrap across the whole screen in fisheye, so it is
// clipped; it is far outside the visible field anyway.
const FISHEYE_CULL_W = 0.3;

export function fisheyeAmountForFov(fov) {
  return THREE.MathUtils.smoothstep(fov, FISHEYE_START_FOV, FISHEYE_FULL_FOV);
}

// Shared by every material; the engine updates them once per frame.
export const viewUniforms = {
  uViewMatrix: { value: new THREE.Matrix4() },
  uViewPosition: { value: new THREE.Vector3() },
  uViewK: { value: 0 },
  uViewScale: { value: new THREE.Vector2(1, 1) },
};

export function withViewUniforms(uniforms) {
  return { ...viewUniforms, ...uniforms };
}

export const PROJECTION_GLSL = `
  uniform mat4 uViewMatrix;
  uniform vec3 uViewPosition;
  uniform float uViewK;
  uniform vec2 uViewScale;

  vec4 projectCameraDirection(vec3 direction) {
    float w = uViewK - direction.z;
    if (uViewK > 0.0001 && w < ${FISHEYE_CULL_W.toFixed(2)} * uViewK) {
      return vec4(0.0, 0.0, 0.0, -1.0);
    }
    return vec4(direction.xy * uViewScale * (1.0 + uViewK), 0.0, w);
  }

  // Sky objects are directions at infinity, so only the camera rotation applies.
  vec4 projectSkyPosition(vec3 world) {
    return projectCameraDirection(normalize(mat3(uViewMatrix) * world));
  }

  vec4 projectWorldPosition(vec3 world) {
    return projectCameraDirection(normalize((uViewMatrix * vec4(world, 1.0)).xyz));
  }

  // > 0 when a point on the unit-sphere globe faces the camera.
  float surfaceFacing(vec3 world) {
    return dot(normalize(world), uViewPosition - world);
  }
`;

// Vertex shader bodies for the two kinds of geometry.
export const SKY_VERTEX_PROJECT = `
  gl_Position = projectSkyPosition((modelMatrix * vec4(position, 1.0)).xyz);
`;

export const WORLD_VERTEX_PROJECT = `
  gl_Position = projectWorldPosition((modelMatrix * vec4(position, 1.0)).xyz);
`;

// JS mirror of the shader projection, used for labels, hit testing, tile selection and picking.
export function makeProjector({ view, eye, fov, aspect }) {
  const k = fisheyeAmountForFov(fov);
  const halfFov = THREE.MathUtils.degToRad(fov / 2);
  const edgeRadius = ((1 + k) * Math.sin(halfFov)) / (k + Math.cos(halfFov));
  const scale = new THREE.Vector2(1 / (edgeRadius * aspect), 1 / edgeRadius);
  const rotation = new THREE.Matrix3().setFromMatrix4(view);
  const inverseRotation = rotation.clone().transpose();
  const scratch = new THREE.Vector3();

  const projectDirection = (direction) => {
    const w = k - direction.z;
    if ((k > 0.0001 && w < FISHEYE_CULL_W * k) || w <= 0) {
      return { x: 0, y: 0, w: -1 };
    }
    return {
      x: (direction.x * scale.x * (1 + k)) / w,
      y: (direction.y * scale.y * (1 + k)) / w,
      w,
    };
  };

  // Camera-space unit ray shown at an NDC position (inverse of projectDirection).
  const unprojectCamera = (ndcX, ndcY) => {
    const s = 1 + k;
    const a = ndcX / scale.x;
    const b = ndcY / scale.y;
    const q = (a * a + b * b) / (s * s);
    const t = (k + Math.sqrt(Math.max(0, k * k - (q + 1) * (k * k - 1)))) / (q + 1);
    return new THREE.Vector3((a * t) / s, (b * t) / s, k - t).normalize();
  };

  return {
    view,
    eye,
    fov,
    aspect,
    k,
    scale,
    // Pixels per radian at the center of the view.
    pixelsPerRadian: (height) => (scale.y * height) / 2,
    projectSky: (point) => projectDirection(scratch.copy(point).applyMatrix3(rotation).normalize()),
    projectWorld: (point) => projectDirection(scratch.copy(point).applyMatrix4(view).normalize()),
    unprojectCamera,
    unprojectWorld: (ndcX, ndcY) => unprojectCamera(ndcX, ndcY).applyMatrix3(inverseRotation).normalize(),
  };
}

// Distance along a ray from `origin` to the unit sphere, or null when it misses.
export function raySphere(origin, direction) {
  const b = origin.dot(direction);
  const c = origin.lengthSq() - 1;
  const disc = b * b - c;
  if (disc < 0) {
    return null;
  }
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}
