import * as Astronomy from 'astronomy-engine';
import { VOYAGE_POSITION } from './taumakoData.js';

// Sky time is local clock time in the Solomon Islands (UTC+11) during the current year.
export const SKY_YEAR = new Date().getFullYear();
export const LOCAL_UTC_OFFSET_HOURS = 11;

const MS_PER_HOUR = 3600 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const observer = new Astronomy.Observer(VOYAGE_POSITION.lat, VOYAGE_POSITION.lng, 0);
const epochTime = Astronomy.MakeTime(new Date(Date.UTC(SKY_YEAR, 6, 1)));
const j2000ToDate = Astronomy.Rotation_EQJ_EQD(epochTime);
const dateToJ2000 = Astronomy.Rotation_EQD_EQJ(epochTime);

// J2000 equatorial -> galactic (IAU 1958, Hipparcos rotation).
const GALACTIC_FROM_J2000 = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
];

export function daysInSkyYear() {
  return (Date.UTC(SKY_YEAR + 1, 0, 1) - Date.UTC(SKY_YEAR, 0, 1)) / MS_PER_DAY;
}

export function skyDate(dayOfYear, localHour) {
  return new Date(
    Date.UTC(SKY_YEAR, 0, 1)
      + (dayOfYear - 1) * MS_PER_DAY
      + (localHour - LOCAL_UTC_OFFSET_HOURS) * MS_PER_HOUR,
  );
}

export function formatSkyDay(dayOfYear) {
  const date = new Date(Date.UTC(SKY_YEAR, 0, dayOfYear));
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function formatSkyHour(localHour) {
  const minutes = Math.round((((localHour % 24) + 24) % 24) * 60) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function localSiderealHours(date) {
  const hours = Astronomy.SiderealTime(date) + VOYAGE_POSITION.lng / 15;
  return ((hours % 24) + 24) % 24;
}

export function precessToSkyYear({ ra, dec }) {
  const raRad = (ra * Math.PI) / 12;
  const decRad = (dec * Math.PI) / 180;
  const vector = new Astronomy.Vector(
    Math.cos(decRad) * Math.cos(raRad),
    Math.cos(decRad) * Math.sin(raRad),
    Math.sin(decRad),
    epochTime,
  );
  const precessed = Astronomy.EquatorFromVector(Astronomy.RotateVector(j2000ToDate, vector));
  return { ra: precessed.ra, dec: precessed.dec };
}

// Converts a direction in equator-of-date coordinates to galactic coordinates.
export function equatorOfDateToGalactic([x, y, z]) {
  const j2000 = Astronomy.RotateVector(dateToJ2000, new Astronomy.Vector(x, y, z, epochTime));
  return GALACTIC_FROM_J2000.map((row) => row[0] * j2000.x + row[1] * j2000.y + row[2] * j2000.z);
}

// Topocentric apparent positions (equator of date) of the sun and moon.
export function sunAndMoon(date) {
  const sun = Astronomy.Equator(Astronomy.Body.Sun, date, observer, true, true);
  const moon = Astronomy.Equator(Astronomy.Body.Moon, date, observer, true, true);
  return {
    sun: { ra: sun.ra, dec: sun.dec },
    moon: { ra: moon.ra, dec: moon.dec },
  };
}

export function dayOfSkyYear(month, day) {
  return Math.round((Date.UTC(SKY_YEAR, month - 1, day) - Date.UTC(SKY_YEAR, 0, 1)) / MS_PER_DAY) + 1;
}

// Local clock hour of sunset at the voyage position on the given day.
export function sunsetLocalHour(dayOfYear) {
  const sunset = Astronomy.SearchRiseSet(Astronomy.Body.Sun, observer, -1, skyDate(dayOfYear, 12), 1);
  if (!sunset) {
    return 18;
  }
  const dayStart = skyDate(dayOfYear, 0).getTime();
  return (sunset.date.getTime() - dayStart) / MS_PER_HOUR;
}
