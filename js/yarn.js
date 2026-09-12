// Yarn weights, gauge defaults, and colour models.

// Typical gauge (per 10 cm / 4 in), needle size and ply construction for each weight.
export const WEIGHTS = [
  { id: 'lace', name: 'Lace', sts: 32, rows: 44, needle: 2.5, plies: 2 },
  { id: 'fingering', name: 'Fingering / sock', sts: 28, rows: 36, needle: 3.0, plies: 3 },
  { id: 'sport', name: 'Sport', sts: 24, rows: 32, needle: 3.5, plies: 3 },
  { id: 'dk', name: 'DK / light worsted', sts: 22, rows: 30, needle: 4.0, plies: 4 },
  { id: 'worsted', name: 'Worsted / aran', sts: 18, rows: 24, needle: 5.0, plies: 4 },
  { id: 'bulky', name: 'Bulky / chunky', sts: 14, rows: 19, needle: 6.5, plies: 3 },
  { id: 'super', name: 'Super bulky', sts: 10, rows: 14, needle: 9.0, plies: 1 },
];

// Standard needle sizes: millimetres and the US size name.
export const NEEDLE_SIZES = [
  [2.0, '0'], [2.25, '1'], [2.5, '1.5'], [2.75, '2'], [3.0, '2.5'], [3.25, '3'], [3.5, '4'], [3.75, '5'],
  [4.0, '6'], [4.5, '7'], [5.0, '8'], [5.5, '9'], [6.0, '10'], [6.5, '10.5'], [7.0, '10.75'], [8.0, '11'],
  [9.0, '13'], [10.0, '15'], [12.0, '17'], [15.0, '19'], [19.0, '35'], [25.0, '50'],
];

export function needleLabel(mm, units) {
  const row = NEEDLE_SIZES.find((r) => Math.abs(r[0] - mm) < 0.01);
  if (units === 'us') return row ? `US ${row[1]} (${mm} mm)` : `${mm} mm`;
  return row ? `${mm} mm (US ${row[1]})` : `${mm} mm`;
}

export const CM_PER_IN = 2.54;
export const YD_PER_M = 1.0936;

export function weightById(id) { return WEIGHTS.find((w) => w.id === id) || WEIGHTS[3]; }

/** Parse a CSS hex colour into linear [r,g,b] in 0..1 (vertex colours are linear). */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.2, 0.2, 0.2];
  const v = parseInt(m[1], 16);
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [toLinear(((v >> 16) & 255) / 255), toLinear(((v >> 8) & 255) / 255), toLinear((v & 255) / 255)];
}

/**
 * A yarn colour model.
 *  - {kind:'solid', color}
 *  - {kind:'stripes', stripes:[{color, length in cm}]} — self-striping: colour by length along the yarn.
 */
export class YarnColors {
  /**
   * @param {object} yarns map of yarn name -> model; key 'A' is the main yarn (used when a node has no yarn name).
   */
  constructor(yarns) {
    this.yarns = {};
    for (const [name, model] of Object.entries(yarns)) this.yarns[name] = compile(model);
  }

  /** Colour for a point `lengthMm` along the yarn named `name` (null = main yarn). */
  colorAt(lengthMm, name) {
    const y = this.yarns[name || 'A'] || this.yarns.A || Object.values(this.yarns)[0];
    if (!y) return [0.6, 0.6, 0.6];
    return y(lengthMm);
  }
}

function compile(model) {
  if (model.kind === 'stripes' && model.stripes && model.stripes.length) {
    const segs = model.stripes.map((s) => ({ rgb: hexToRgb(s.color), len: Math.max(1, (s.length || 0) * 10) }));
    const total = segs.reduce((a, s) => a + s.len, 0);
    return (l) => {
      let t = ((l % total) + total) % total;
      for (const s of segs) { if (t < s.len) return s.rgb; t -= s.len; }
      return segs[segs.length - 1].rgb;
    };
  }
  const rgb = hexToRgb(model.color || '#888888');
  return () => rgb;
}
