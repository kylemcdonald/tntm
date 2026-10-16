// Tunable visual settings. Non-default values are mirrored in the query string
// (e.g. ?skyExposure=0.5&lineWidth=4) so a tuned view can be shared and turned into defaults.
export const SETTINGS_GROUPS = [
  {
    title: 'Milky Way image',
    settings: [
      { key: 'skyExposure', label: 'Exposure', min: -3, max: 3, step: 0.05, default: 0.2, unit: 'stops' },
      { key: 'skyGamma', label: 'Gamma', min: 0.3, max: 3, step: 0.01, default: 0.93 },
      { key: 'skyContrast', label: 'Contrast', min: 0, max: 3, step: 0.01, default: 0.55 },
      { key: 'skyBrightness', label: 'Brightness', min: -0.3, max: 0.3, step: 0.005, default: -0.09 },
      { key: 'skySaturation', label: 'Saturation', min: 0, max: 2, step: 0.01, default: 0.91 },
      { key: 'skyBlackPoint', label: 'Black point', min: 0, max: 0.2, step: 0.001, default: 0.032 },
    ],
  },
  {
    title: 'Map',
    settings: [
      { key: 'mapOpacity', label: 'Opacity', min: 0, max: 1, step: 0.01, default: 0.9 },
      { key: 'mapInvert', label: 'Night invert', min: 0, max: 1, step: 0.01, default: 1 },
      { key: 'mapBrightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.005, default: 0 },
      { key: 'mapContrast', label: 'Contrast', min: 0, max: 3, step: 0.01, default: 1 },
      { key: 'mapSaturation', label: 'Saturation', min: 0, max: 2, step: 0.01, default: 1 },
      { key: 'mapTintRed', label: 'Tint red', min: 0, max: 2, step: 0.01, default: 0.8 },
      { key: 'mapTintGreen', label: 'Tint green', min: 0, max: 2, step: 0.01, default: 0.9 },
      { key: 'mapTintBlue', label: 'Tint blue', min: 0, max: 2, step: 0.01, default: 1.6 },
    ],
  },
  {
    title: 'Constellations',
    settings: [
      { key: 'lineWidth', label: 'Line thickness', min: 0.5, max: 10, step: 0.1, default: 5.1, unit: 'px' },
      { key: 'lineOpacity', label: 'Line brightness', min: 0, max: 1, step: 0.01, default: 1 },
      { key: 'namedStarSize', label: 'Star size', min: 0.3, max: 3, step: 0.05, default: 2.7 },
      { key: 'namedStarOpacity', label: 'Star brightness', min: 0, max: 1, step: 0.01, default: 0.88 },
      { key: 'labelSize', label: 'Label size', min: 0.4, max: 2, step: 0.05, default: 0.9 },
    ],
  },
  {
    title: 'Sky',
    settings: [
      { key: 'fieldStarSize', label: 'Field star size', min: 0.3, max: 3, step: 0.05, default: 1.6 },
      { key: 'fieldStarOpacity', label: 'Field star brightness', min: 0, max: 1, step: 0.01, default: 0.49 },
      { key: 'pathOpacity', label: 'Star path brightness', min: 0, max: 2, step: 0.01, default: 0.51 },
    ],
  },
  {
    title: 'Voyage',
    settings: [
      { key: 'boatPosition', label: 'Boat position (Taumako → Vanuatu)', min: 0, max: 100, step: 0.5, default: 20, unit: '%' },
    ],
  },
  {
    title: 'Camera',
    settings: [
      { key: 'regularFov', label: 'Regular FOV', min: 15, max: 90, step: 0.5, default: 36.87, unit: '°' },
      { key: 'wideFov', label: 'Wide FOV', min: 30, max: 180, step: 0.5, default: 62, unit: '°' },
    ],
  },
];

const SETTINGS_LIST = SETTINGS_GROUPS.flatMap((group) => group.settings);

export const DEFAULT_SETTINGS = Object.fromEntries(SETTINGS_LIST.map((setting) => [setting.key, setting.default]));

function clampSetting(setting, value) {
  return Math.min(setting.max, Math.max(setting.min, value));
}

export function readSettingsFromQuery(search = window.location.search) {
  const params = new URLSearchParams(search);
  const settings = { ...DEFAULT_SETTINGS };
  SETTINGS_LIST.forEach((setting) => {
    const raw = params.get(setting.key);
    const value = raw === null ? NaN : Number(raw);
    if (Number.isFinite(value)) {
      settings[setting.key] = clampSetting(setting, value);
    }
  });
  return settings;
}

export function writeSettingsToQuery(settings) {
  const params = new URLSearchParams(window.location.search);
  SETTINGS_LIST.forEach((setting) => {
    const value = settings[setting.key];
    if (Math.abs(value - setting.default) < 1e-9) {
      params.delete(setting.key);
    } else {
      params.set(setting.key, String(Number(value.toFixed(4))));
    }
  });
  const query = params.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
    window.history.replaceState(null, '', next);
  }
}
