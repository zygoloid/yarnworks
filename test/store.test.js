import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSaveFile, serialize, parseSaveFile, VERSION } from '../js/store.js';

const state = {
  text: 'Cast on 4 sts.\nRow 1: k.',
  weight: 'dk', needle: 4, sts: 22, rows: 30, sizeIndex: 0, roundMode: 'auto', tension: 'normal', plies: 4, units: 'metric',
  yarns: { A: { kind: 'solid', color: '#b5443c', stripes: [] } },
  stop: { row: 1, stitch: 2 }, lifelines: [1], markers: [{ row: 1, stitch: 2 }], showNeedles: true,
  moveMode: true, // transient: must not be saved
};
const camera = { position: [1, 2, 300], target: [0, 0, 0], up: [0, 1, 0], near: 1, far: 5000 };

test('a save file round-trips the settings, camera and positions', () => {
  const positions = Float64Array.from([0, 0, 0, 4.5, 0.004, 0, 9, 0, -0.006, 1, 1, 1]);
  const doc = buildSaveFile({ state, camera, positions, positionCount: 3 });
  assert.equal(doc.format, 'yarnworks');
  assert.equal(doc.version, VERSION);
  assert.equal(doc.state.moveMode, undefined);
  const text = serialize(doc);
  // Coordinates sit on one line rather than one per number.
  assert.match(text, /"xyz": \[0,0,0,4.5,0,0,9,0,-0.01\]/);
  const back = parseSaveFile(text);
  const { moveMode, ...saved } = state;
  assert.deepEqual(back.state, saved);
  assert.deepEqual(back.camera, camera);
  assert.equal(back.positions.count, 3);
  assert.deepEqual(Array.from(back.positions.xyz), [0, 0, 0, 4.5, 0, 0, 9, 0, -0.01]);
});

test('a file with only a pattern loads, and other files are refused', () => {
  const back = parseSaveFile(serialize(buildSaveFile({ state: { text: 'Cast on 4 sts.' } })));
  assert.deepEqual(back, { state: { text: 'Cast on 4 sts.' }, camera: null, positions: null });
  assert.throws(() => parseSaveFile('not json'), /not a JSON file/);
  assert.throws(() => parseSaveFile('{"hello": 1}'), /not a Yarnworks save file/);
  assert.throws(() => parseSaveFile(`{"format": "yarnworks", "version": ${VERSION + 1}, "state": {"text": ""}}`), /newer version/);
  assert.throws(() => parseSaveFile('{"format": "yarnworks", "version": 1, "state": {}}'), /no pattern/);
});

test('malformed optional parts are dropped rather than failing the load', () => {
  const doc = {
    format: 'yarnworks', version: 1,
    state: { text: 'x', needle: -1, sts: 'ten', sizeIndex: 1.5, stop: { row: 'a' }, lifelines: 'no', yarns: 3 },
    camera: { position: [1, 2], target: [0, 0, 0], up: [0, 1, 0] },
    positions: { count: 2, xyz: [1, 2, 3] },
  };
  const back = parseSaveFile(JSON.stringify(doc));
  assert.deepEqual(back, { state: { text: 'x' }, camera: null, positions: null });
});
