// Save files: the pattern and its settings, the camera, and the relaxed stitch positions,
// as one JSON document that can be written to disk and read back later.

export const FORMAT = 'yarnworks';
export const VERSION = 1;

/** Settings that go in the file, in this order; anything else in the app state is transient. */
const STATE_KEYS = ['text', 'weight', 'needle', 'sts', 'rows', 'sizeIndex', 'roundMode', 'tension', 'plies', 'units', 'yarns', 'needles', 'stop', 'lifelines', 'markers', 'showNeedles'];

/**
 * Build the document to save.
 *   state     the app state (only the keys above are kept)
 *   camera    {position, target, up, near, far} from the scene, or null
 *   positions flat xyz array of every stitch shown, or null
 * Positions are rounded to a hundredth of a millimetre, which is far below anything visible
 * and keeps the file a manageable size.
 */
export function buildSaveFile({ state, camera = null, positions = null, positionCount = 0 }) {
  const out = { format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), state: {} };
  for (const k of STATE_KEYS) if (state[k] !== undefined) out.state[k] = state[k];
  if (camera) out.camera = { position: vec(camera.position), target: vec(camera.target), up: vec(camera.up), near: camera.near, far: camera.far };
  if (positions && positionCount > 0 && positions.length >= 3 * positionCount) {
    const xyz = new Array(3 * positionCount);
    for (let i = 0; i < 3 * positionCount; i++) xyz[i] = Math.round(positions[i] * 100) / 100;
    out.positions = { count: positionCount, xyz };
  }
  return out;
}

/** JSON text for the document, with the position list kept compact. */
export function serialize(doc) {
  const positions = doc.positions;
  const text = JSON.stringify({ ...doc, positions: positions ? '@@POSITIONS@@' : undefined }, null, 2);
  if (!positions) return text + '\n';
  // One long line for the coordinates rather than one per number.
  const compact = `{"count": ${positions.count}, "xyz": [${positions.xyz.join(',')}]}`;
  return text.replace('"@@POSITIONS@@"', compact) + '\n';
}

/**
 * Parse a save file. Returns {state, camera, positions} with anything malformed dropped
 * (a bad camera or position list just falls back to fitting and relaxing afresh), or
 * throws an Error describing why the file cannot be used at all.
 */
export function parseSaveFile(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error('This is not a JSON file'); }
  if (!doc || typeof doc !== 'object' || doc.format !== FORMAT) throw new Error('This is not a Yarnworks save file');
  if (!Number.isInteger(doc.version) || doc.version > VERSION) throw new Error(`This file was saved by a newer version of Yarnworks (format ${doc.version})`);
  if (!doc.state || typeof doc.state !== 'object' || typeof doc.state.text !== 'string') throw new Error('The file has no pattern in it');
  const state = {};
  for (const k of STATE_KEYS) if (doc.state[k] !== undefined) state[k] = doc.state[k];
  // Light sanitising: the file may have been edited by hand.
  for (const k of ['needle', 'sts', 'rows']) if (state[k] !== undefined && !(Number.isFinite(state[k]) && state[k] > 0)) delete state[k];
  for (const k of ['sizeIndex', 'plies']) if (state[k] !== undefined && !(Number.isInteger(state[k]) && state[k] >= 0)) delete state[k];
  if (state.stop !== undefined && state.stop !== null && !(Number.isInteger(state.stop.row) && (state.stop.stitch === null || Number.isInteger(state.stop.stitch)))) delete state.stop;
  for (const k of ['lifelines', 'markers']) if (state[k] !== undefined && !Array.isArray(state[k])) delete state[k];
  if (state.yarns !== undefined && (typeof state.yarns !== 'object' || state.yarns === null)) delete state.yarns;

  let camera = null;
  const c = doc.camera;
  if (c && isVec(c.position) && isVec(c.target) && isVec(c.up)) {
    camera = { position: c.position, target: c.target, up: c.up };
    if (Number.isFinite(c.near) && c.near > 0 && Number.isFinite(c.far) && c.far > c.near) { camera.near = c.near; camera.far = c.far; }
  }

  let positions = null;
  const p = doc.positions;
  if (p && Number.isInteger(p.count) && p.count > 0 && Array.isArray(p.xyz) && p.xyz.length === 3 * p.count && p.xyz.every(Number.isFinite)) {
    positions = { count: p.count, xyz: Float64Array.from(p.xyz) };
  }
  return { state, camera, positions };
}

function vec(v) { return [v[0], v[1], v[2]]; }
function isVec(v) { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite); }
