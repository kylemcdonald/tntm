import * as THREE from 'three';
import { TAUMAKO, VANUATU, VOYAGE_FRACTION, VOYAGE_POSITION } from '../taumakoData.js';
import { raySphere } from './projection.js';

// World space is in Earth radii with the globe as the unit sphere at the origin. The globe camera
// orbits a point on the surface (like a map camera); the sky camera stands on the deck at the voyage
// position. Both are just poses (position + orientation), so switching modes blends two poses.

// About 120 m up, which puts the sea horizon ~0.35° below level.
export const SKY_EYE_ALTITUDE = 1.9e-5;

export function lngLatToVector({ lng, lat }) {
  const lngRad = THREE.MathUtils.degToRad(lng);
  const latRad = THREE.MathUtils.degToRad(lat);
  const cosLat = Math.cos(latRad);
  return new THREE.Vector3(Math.sin(lngRad) * cosLat, Math.sin(latRad), Math.cos(lngRad) * cosLat).normalize();
}

export function vectorToLngLat(vector) {
  const v = vector.clone().normalize();
  return {
    lng: THREE.MathUtils.radToDeg(Math.atan2(v.x, v.z)),
    lat: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(v.y, -1, 1))),
  };
}

export function localFrame(up) {
  let east = new THREE.Vector3(up.z, 0, -up.x);
  if (east.lengthSq() < 1e-12) {
    east = new THREE.Vector3(1, 0, 0);
  }
  east.normalize();
  const north = new THREE.Vector3().crossVectors(up, east).normalize();
  return { up: up.clone().normalize(), east, north };
}

function frameAt(position) {
  const frame = localFrame(lngLatToVector(position));
  return { ...frame, south: frame.north.clone().negate() };
}

// Fixed reference frame the sky is built in. The sky is attached to the Earth (only sidereal time
// turns it), so it stays correct wherever the boat is on the route.
export const VOYAGE_FRAME = frameAt(VOYAGE_POSITION);

// Where the boat (and the sky camera) is along the route; mutated in place by setObserverFraction.
export const OBSERVER = {
  fraction: VOYAGE_FRACTION,
  position: { ...VOYAGE_POSITION },
  frame: frameAt(VOYAGE_POSITION),
};

export function setObserverFraction(fraction) {
  if (fraction === OBSERVER.fraction) {
    return false;
  }
  OBSERVER.fraction = fraction;
  OBSERVER.position = {
    lng: TAUMAKO.lng + (VANUATU.lng - TAUMAKO.lng) * fraction,
    lat: TAUMAKO.lat + (VANUATU.lat - TAUMAKO.lat) * fraction,
  };
  OBSERVER.frame = frameAt(OBSERVER.position);
  return true;
}

function poseFromBasis(position, right, up, forward) {
  const matrix = new THREE.Matrix4().makeBasis(right, up, forward.clone().negate());
  return { position, quaternion: new THREE.Quaternion().setFromRotationMatrix(matrix) };
}

export function poseForward(pose) {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
}

export function viewMatrixForPose(pose) {
  return new THREE.Matrix4().compose(pose.position, pose.quaternion, new THREE.Vector3(1, 1, 1)).invert();
}

// Globe camera: looks at a surface point from `distance` away, tilted by `pitch` from straight down,
// with `bearing` the compass direction at the top of the screen (degrees).
export function orbitPose({ lng, lat, distance, pitch, bearing }) {
  const { up, east, north } = localFrame(lngLatToVector({ lng, lat }));
  const b = THREE.MathUtils.degToRad(bearing);
  const p = THREE.MathUtils.degToRad(pitch);
  const ahead = north.clone().multiplyScalar(Math.cos(b)).addScaledVector(east, Math.sin(b));
  const right = east.clone().multiplyScalar(Math.cos(b)).addScaledVector(north, -Math.sin(b));
  const position = up.clone()
    .addScaledVector(up, distance * Math.cos(p))
    .addScaledVector(ahead, -distance * Math.sin(p));
  const forward = ahead.clone().multiplyScalar(Math.sin(p)).addScaledVector(up, -Math.cos(p));
  const cameraUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  return poseFromBasis(position, right, cameraUp, forward);
}

// Inverse of orbitPose for a camera with no roll; null when the view center misses the globe.
export function orbitFromPose(pose) {
  const forward = poseForward(pose);
  const t = raySphere(pose.position, forward);
  if (t === null) {
    return null;
  }
  const center = pose.position.clone().addScaledVector(forward, t);
  const { up, east, north } = localFrame(center);
  const pitch = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(-forward.dot(up), -1, 1)));
  let ahead = forward.clone().projectOnPlane(up);
  if (ahead.lengthSq() < 1e-10) {
    ahead = new THREE.Vector3(0, 1, 0).applyQuaternion(pose.quaternion).projectOnPlane(up);
  }
  ahead.normalize();
  return {
    ...vectorToLngLat(center),
    distance: t,
    pitch,
    bearing: THREE.MathUtils.radToDeg(Math.atan2(ahead.dot(east), ahead.dot(north))),
  };
}

export function skyLookDirection(yaw, pitch) {
  const yawRad = THREE.MathUtils.degToRad(yaw);
  const pitchRad = THREE.MathUtils.degToRad(pitch);
  const horizontal = Math.cos(pitchRad);
  return new THREE.Vector3()
    .addScaledVector(OBSERVER.frame.south, Math.cos(yawRad) * horizontal)
    .addScaledVector(OBSERVER.frame.east, -Math.sin(yawRad) * horizontal)
    .addScaledVector(OBSERVER.frame.up, Math.sin(pitchRad))
    .normalize();
}

export function skyLookForDirection(direction) {
  return {
    yaw: THREE.MathUtils.radToDeg(Math.atan2(-direction.dot(OBSERVER.frame.east), direction.dot(OBSERVER.frame.south))),
    pitch: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(direction.dot(OBSERVER.frame.up), -1, 1))),
  };
}

// Sky camera: standing on the boat, looking along yaw (0 = south) and pitch.
export function skyPose({ yaw, pitch }) {
  const forward = skyLookDirection(yaw, pitch);
  let right = new THREE.Vector3().crossVectors(forward, OBSERVER.frame.up);
  if (right.lengthSq() < 1e-10) {
    right = OBSERVER.frame.east.clone().negate();
  }
  right.normalize();
  const cameraUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  const position = OBSERVER.frame.up.clone().multiplyScalar(1 + SKY_EYE_ALTITUDE);
  return poseFromBasis(position, right, cameraUp, forward);
}

// Blends two poses: direction from the globe center and altitude interpolate separately so the
// path never cuts through the Earth; orientation slerps.
export function blendPoses(from, to, t) {
  if (t <= 0) {
    return { position: from.position.clone(), quaternion: from.quaternion.clone() };
  }
  if (t >= 1) {
    return { position: to.position.clone(), quaternion: to.quaternion.clone() };
  }
  const fromRadius = from.position.length();
  const toRadius = to.position.length();
  const fromDirection = from.position.clone().divideScalar(fromRadius);
  const toDirection = to.position.clone().divideScalar(toRadius);
  const angle = fromDirection.angleTo(toDirection);
  let direction;
  if (angle < 1e-6) {
    direction = fromDirection;
  } else {
    const axis = new THREE.Vector3().crossVectors(fromDirection, toDirection).normalize();
    direction = fromDirection.clone().applyAxisAngle(axis, angle * t);
  }
  // Interpolate altitude geometrically so the descent to the deck slows near the surface.
  const fromAltitude = Math.max(fromRadius - 1, SKY_EYE_ALTITUDE);
  const toAltitude = Math.max(toRadius - 1, SKY_EYE_ALTITUDE);
  const altitude = fromAltitude * (toAltitude / fromAltitude) ** t;
  return {
    position: direction.multiplyScalar(1 + altitude),
    quaternion: from.quaternion.clone().slerp(to.quaternion, t),
  };
}

// Free globe camera: an eye above the Earth (altitude in Earth radii) looking along `heading`
// (compass degrees) and `tilt` (degrees above the local horizontal), with no roll.
export function eyePose({ lng, lat, altitude, heading, tilt }) {
  const { up, east, north } = localFrame(lngLatToVector({ lng, lat }));
  const h = THREE.MathUtils.degToRad(heading);
  const t = THREE.MathUtils.degToRad(tilt);
  const forward = north.clone().multiplyScalar(Math.cos(h) * Math.cos(t))
    .addScaledVector(east, Math.sin(h) * Math.cos(t))
    .addScaledVector(up, Math.sin(t));
  let right = new THREE.Vector3().crossVectors(forward, up);
  if (right.lengthSq() < 1e-10) {
    right = east.clone().multiplyScalar(Math.cos(h)).addScaledVector(north, -Math.sin(h));
  }
  right.normalize();
  const cameraUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  return poseFromBasis(up.clone().multiplyScalar(1 + altitude), right, cameraUp, forward);
}

export function eyeFromPose(pose) {
  const radius = pose.position.length();
  const { up, east, north } = localFrame(pose.position.clone().divideScalar(radius));
  const forward = poseForward(pose);
  return {
    ...vectorToLngLat(pose.position),
    altitude: radius - 1,
    heading: THREE.MathUtils.radToDeg(Math.atan2(forward.dot(east), forward.dot(north))),
    tilt: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(forward.dot(up), -1, 1))),
  };
}
