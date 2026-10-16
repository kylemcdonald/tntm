import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Aperture,
  Compass,
  Crosshair,
  Grid2X2,
  LocateFixed,
  Orbit,
  Pause,
  Play,
  Route,
  Settings,
  Sparkles,
  SunMoon,
  Tags,
  Telescope,
  X,
} from 'lucide-react';
import { SkyGlobeEngine } from './engine/engine.js';
import {
  dayOfSkyYear,
  daysInSkyYear,
  formatSkyDay,
  formatSkyHour,
  sunsetLocalHour,
} from './astro.js';
import { PART_OF_NAMES, skyBodies, skyBodiesById } from './taumakoData.js';
import {
  DEFAULT_SETTINGS,
  readSettingsFromQuery,
  SETTINGS_GROUPS,
  writeSettingsToQuery,
} from './settings.js';

const SKY_YEAR_DAYS = daysInSkyYear();
// Default view: sunset on May 15.
const DEFAULT_DAY_OF_YEAR = dayOfSkyYear(5, 15);
const DEFAULT_PHASE = sunsetLocalHour(DEFAULT_DAY_OF_YEAR) * 15;
const SKY_DEGREES_PER_MS = 0.00086;
const DEGREES_PER_HOUR = 15;

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function formatSettingValue(setting, value) {
  const decimals = Math.max(0, -Math.floor(Math.log10(setting.step)));
  return `${value.toFixed(decimals)}${setting.unit ? ` ${setting.unit}` : ''}`;
}

// Range input whose drag locks the pointer, so dragging keeps going past the ends and wraps
// around (e.g. 23:59 -> 00:00). Clicking still jumps to the clicked position.
function LoopingRange({ min, max, period = max - min, step, value, round, onChange, onDragStart }) {
  const dragRef = useRef(null);

  useEffect(() => () => dragRef.current?.stop(), []);

  const wrap = (raw) => {
    const wrapped = min + ((((raw - min) % period) + period) % period);
    return round ? round(wrapped) : wrapped;
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const unitsPerPixel = (max - min) / Math.max(rect.width, 1);
    let current = min + clamp01((event.clientX - rect.left) / Math.max(rect.width, 1)) * (max - min);
    onDragStart?.();
    onChange(wrap(current));
    element.focus();

    const handleMove = (moveEvent) => {
      current += moveEvent.movementX * unitsPerPixel;
      onChange(wrap(current));
    };
    const stop = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
      if (document.pointerLockElement === element) {
        document.exitPointerLock();
      }
      dragRef.current = null;
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    dragRef.current = { stop };
    try {
      Promise.resolve(element.requestPointerLock?.()).catch(() => {});
    } catch {
      // Pointer lock is optional; without it the drag still works within the window.
    }
  };

  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onPointerDown={handlePointerDown}
      onChange={(event) => {
        onDragStart?.();
        onChange(Number(event.target.value));
      }}
    />
  );
}

function SettingsModal({ settings, onChange, onReset, onClose }) {
  const [copied, setCopied] = useState(false);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="settings-modal" role="dialog" aria-label="Settings">
        <header>
          <h2>Settings</h2>
          <button className="settings-close" type="button" aria-label="Close settings" onClick={onClose}>
            <X size={18} strokeWidth={2.2} />
          </button>
        </header>
        <div className="settings-body">
          {SETTINGS_GROUPS.map((group) => (
            <fieldset key={group.title}>
              <legend>{group.title}</legend>
              {group.settings.map((setting) => {
                const value = settings[setting.key];
                const changed = Math.abs(value - setting.default) > 1e-9;
                return (
                  <label key={setting.key} className={changed ? 'settings-row is-changed' : 'settings-row'}>
                    <span>{setting.label}</span>
                    <input
                      type="range"
                      min={setting.min}
                      max={setting.max}
                      step={setting.step}
                      value={value}
                      onChange={(event) => onChange(setting.key, Number(event.target.value))}
                      onDoubleClick={() => onChange(setting.key, setting.default)}
                    />
                    <output>{formatSettingValue(setting, value)}</output>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
        <footer>
          <span>Changed values are saved in the URL. Double-click a slider to reset it.</span>
          <button type="button" onClick={onReset}>Reset all</button>
          <button type="button" className="is-primary" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
        </footer>
    </section>
  );
}

function IconToggle({ active, icon: Icon, label, onClick }) {
  return (
    <button
      className={active ? 'tool-button is-active' : 'tool-button'}
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={18} strokeWidth={2.2} />
    </button>
  );
}

export default function App() {
  const shellRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const engineRef = useRef(null);
  const settingsRef = useRef(null);
  if (!settingsRef.current) {
    settingsRef.current = readSettingsFromQuery();
  }

  const [selectedId, setSelectedId] = useState('kaua-kona');
  const [playing, setPlaying] = useState(true);
  const [phase, setPhase] = useState(DEFAULT_PHASE);
  const [dayOfYear, setDayOfYear] = useState(DEFAULT_DAY_OF_YEAR);
  const [showLabels, setShowLabels] = useState(true);
  const [showPaths, setShowPaths] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showCompass, setShowCompass] = useState(true);
  const [showFieldStars, setShowFieldStars] = useState(true);
  const [showMilkyWay, setShowMilkyWay] = useState(true);
  const [showSunMoon, setShowSunMoon] = useState(true);
  const [compassRotation, setCompassRotation] = useState(0);
  const [settings, setSettings] = useState(settingsRef.current);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stellariumMode, setStellariumMode] = useState(false);
  const [wideFov, setWideFov] = useState(false);

  const selected = useMemo(() => skyBodiesById[selectedId] ?? skyBodies[0], [selectedId]);
  const relatedBodies = useMemo(() => {
    const parts = skyBodies.filter((body) => body.partOf === selected.id);
    const members = (selected.sequence ?? []).map((id) => skyBodiesById[id]).filter(Boolean);
    const sequences = skyBodies.filter((body) => body.sequence?.includes(selected.id));
    return [
      parts.length ? { label: 'Parts', bodies: parts } : null,
      members.length ? { label: 'Sequence', bodies: members } : null,
      sequences.length ? { label: 'In sequence', bodies: sequences } : null,
    ].filter(Boolean);
  }, [selected]);

  useEffect(() => {
    const engine = new SkyGlobeEngine(canvasContainerRef.current, {
      settings: settingsRef.current,
      onSelect: setSelectedId,
      onViewChange: ({ mode, wide }) => {
        setStellariumMode(mode === 'sky');
        setWideFov(wide);
      },
      onBlendChange: (blend) => {
        shellRef.current?.style.setProperty('--stellarium-mode-blend', blend.toFixed(4));
      },
    });
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setState({
      phase,
      dayOfYear,
      showLabels,
      showPaths,
      showGrid,
      showCompass,
      showFieldStars,
      showMilkyWay,
      showSunMoon,
      compassRotation,
      settings,
    });
  }, [
    phase,
    dayOfYear,
    showLabels,
    showPaths,
    showGrid,
    showCompass,
    showFieldStars,
    showMilkyWay,
    showSunMoon,
    compassRotation,
    settings,
  ]);

  useEffect(() => {
    settingsRef.current = settings;
    writeSettingsToQuery(settings);
  }, [settings]);

  useEffect(() => {
    if (!settingsOpen) {
      return undefined;
    }
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [settingsOpen]);

  useEffect(() => {
    if (!playing) {
      return undefined;
    }
    let lastTick = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const delta = now - lastTick;
      lastTick = now;
      setPhase((value) => (value + delta * SKY_DEGREES_PER_MS) % 360);
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing]);

  function focusBody(bodyId) {
    setSelectedId(bodyId);
    engineRef.current?.focusBody(bodyId);
  }

  function resetView() {
    setDayOfYear(DEFAULT_DAY_OF_YEAR);
    setPhase(DEFAULT_PHASE);
    setCompassRotation(0);
    engineRef.current?.reset();
  }

  function updateSetting(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  return (
    <main ref={shellRef} className={stellariumMode ? 'app-shell is-stellarium' : 'app-shell'}>
      <div ref={canvasContainerRef} className="map-canvas" />

      <section className="title-block" aria-label="Title">
        <p className="overline">Nga Hetu o Lata</p>
        <h1>Taumako Southern Sky</h1>
      </section>

      <aside className="info-panel" aria-live="polite">
        <p className="panel-kicker">
          {[selected.kind, selected.taumakoType].filter(Boolean).join(' · ')}
          {selected.partOf && (
            <>
              {' · part of '}
              {skyBodiesById[selected.partOf] ? (
                <button type="button" onClick={() => focusBody(selected.partOf)}>
                  {skyBodiesById[selected.partOf].name}
                </button>
              ) : (PART_OF_NAMES[selected.partOf] ?? selected.partOf)}
            </>
          )}
        </p>
        <div className="panel-title">
          <h2>{selected.name}</h2>
          <button
            type="button"
            className="panel-focus"
            aria-label={`Look at ${selected.name}`}
            title={`Look at ${selected.name}`}
            onClick={() => focusBody(selected.id)}
          >
            <Crosshair size={16} strokeWidth={2.2} />
          </button>
        </div>
        {selected.translation && <p className="panel-translation">“{selected.translation}”</p>}
        {selected.western && <p>{selected.western}</p>}
        {selected.instruction && (
          <div className="panel-instruction">
            <em>{selected.instruction}</em>
            {selected.instructionTranslation && <span>{selected.instructionTranslation}</span>}
          </div>
        )}
        {selected.note && <span className="panel-note">{selected.note}</span>}
        {relatedBodies.map(({ label, bodies }) => (
          <p key={label} className="panel-links">
            <span>{label}</span>
            {bodies.map((body) => (
              <button key={body.id} type="button" onClick={() => focusBody(body.id)}>{body.name}</button>
            ))}
          </p>
        ))}
      </aside>

      <nav className="tool-dock" aria-label="Viewer controls">
        <IconToggle
          active={playing}
          icon={playing ? Pause : Play}
          label={playing ? 'Pause star motion' : 'Play star motion'}
          onClick={() => setPlaying((value) => !value)}
        />
        <IconToggle
          active={showLabels}
          icon={Tags}
          label="Toggle local labels"
          onClick={() => setShowLabels((value) => !value)}
        />
        <IconToggle
          active={showPaths}
          icon={Route}
          label="Toggle star paths"
          onClick={() => setShowPaths((value) => !value)}
        />
        <IconToggle
          active={showGrid}
          icon={Grid2X2}
          label="Toggle horizon grid"
          onClick={() => setShowGrid((value) => !value)}
        />
        <IconToggle
          active={showCompass}
          icon={Compass}
          label="Toggle wind compass"
          onClick={() => setShowCompass((value) => !value)}
        />
        <IconToggle
          active={showFieldStars}
          icon={Sparkles}
          label="Toggle field stars"
          onClick={() => setShowFieldStars((value) => !value)}
        />
        <IconToggle
          active={showMilkyWay}
          icon={Orbit}
          label="Toggle Milky Way"
          onClick={() => setShowMilkyWay((value) => !value)}
        />
        <IconToggle
          active={showSunMoon}
          icon={SunMoon}
          label="Toggle sun and moon"
          onClick={() => setShowSunMoon((value) => !value)}
        />
        <IconToggle
          active={stellariumMode}
          icon={Telescope}
          label={stellariumMode ? 'Use globe camera control' : 'Use sky camera control'}
          onClick={() => engineRef.current?.toggleMode()}
        />
        <IconToggle
          active={wideFov}
          icon={Aperture}
          label={wideFov ? 'Use regular FOV' : 'Use wide FOV'}
          onClick={() => engineRef.current?.toggleWide()}
        />
        <IconToggle
          active={settingsOpen}
          icon={Settings}
          label="Settings"
          onClick={() => setSettingsOpen((value) => !value)}
        />
        <button
          className="tool-button reset-camera-button"
          type="button"
          aria-label="Reset camera"
          title="Reset camera"
          onClick={resetView}
        >
          <LocateFixed size={18} strokeWidth={2.2} />
          <span>Reset camera</span>
        </button>
        <label className="phase-control" title="Local time of day (UTC+11)">
          <span>Time {formatSkyHour(phase / DEGREES_PER_HOUR)}</span>
          <LoopingRange
            min={0}
            max={24}
            step={0.1}
            value={phase / DEGREES_PER_HOUR}
            onDragStart={() => setPlaying(false)}
            onChange={(hours) => setPhase(hours * DEGREES_PER_HOUR)}
          />
        </label>
        <label className="phase-control" title="Day of year">
          <span>{formatSkyDay(dayOfYear)}</span>
          <LoopingRange
            min={1}
            max={SKY_YEAR_DAYS}
            period={SKY_YEAR_DAYS}
            step={1}
            round={Math.floor}
            value={dayOfYear}
            onChange={setDayOfYear}
          />
        </label>
        <label className="phase-control" title={`Compass rotation: ${compassRotation} degrees`}>
          <span>Compass rotation</span>
          <input
            type="range"
            min="-180"
            max="180"
            step="1"
            value={compassRotation}
            onChange={(event) => setCompassRotation(Number(event.target.value))}
          />
        </label>
      </nav>

      <footer className="attribution">
        Map ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>
        {' '}contributors · Sky:{' '}
        <a href="https://noirlab.edu/public/images/noirlab2430b/" target="_blank" rel="noopener noreferrer">
          NOIRLab/NSF/AURA/E. Slawik/M. Zamani
        </a>
      </footer>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={updateSetting}
          onReset={() => setSettings({ ...DEFAULT_SETTINGS })}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </main>
  );
}
