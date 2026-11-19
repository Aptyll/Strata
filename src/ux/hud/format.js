// Number formatting helpers for the HUD. Pure functions, no DOM.

const UNITS = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

/**
 * Compact count: 1048576 -> "1.05M", 999 -> "999".
 * Keeps three significant digits so the text width stays stable while counting.
 * @param {number} n
 */
export function formatCount(n) {
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  for (const [size, suffix] of UNITS) {
    if (abs >= size) {
      const v = n / size;
      const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
      return v.toFixed(digits) + suffix;
    }
  }
  return String(Math.round(n));
}

/** Full count with thin-space grouping: 1048576 -> "1 048 576". */
export function formatExact(n) {
  if (!Number.isFinite(n)) return '-';
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Decimal places implied by a step value: 0.05 -> 2, 1 -> 0. */
export function decimalsFor(step) {
  if (!step || !Number.isFinite(step)) return 2;
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Default readout for a range param. */
export function formatValue(value, step) {
  if (typeof value !== 'number') return String(value);
  if (Math.abs(value) >= 1e5) return formatCount(value);
  return value.toFixed(Math.min(decimalsFor(step), 4));
}

/** Elapsed seconds as m:ss, or h:mm:ss past the hour. */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
