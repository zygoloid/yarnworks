// Yarn weights, gauge defaults, and colour models.

export const WEIGHTS = [
  { id: 'lace', name: 'Lace', sts: 32, rows: 44, needle: 2.5 },
  { id: 'fingering', name: 'Fingering / 4 ply', sts: 28, rows: 36, needle: 3.0 },
  { id: 'sport', name: 'Sport / 5 ply', sts: 24, rows: 32, needle: 3.5 },
  { id: 'dk', name: 'DK / 8 ply', sts: 22, rows: 30, needle: 4.0 },
  { id: 'worsted', name: 'Worsted / Aran', sts: 18, rows: 24, needle: 5.0 },
  { id: 'bulky', name: 'Bulky / Chunky', sts: 14, rows: 19, needle: 6.5 },
  { id: 'super', name: 'Super bulky', sts: 10, rows: 14, needle: 9.0 },
];

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
 *  - {kind:'stripes', segments:[{color, length}], unit: 'cm'} — self-striping: colour by length along the yarn.
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
  if (model.kind === 'stripes' && model.segments && model.segments.length) {
    const segs = model.segments.map((s) => ({ rgb: hexToRgb(s.color), len: Math.max(1, (s.length || 0) * 10) }));
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
