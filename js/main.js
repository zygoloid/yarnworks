// Yarnworks application: wires the pattern editor, settings, knitter,
// simulation and renderer together.

import { parsePattern } from './pattern/parser.js';
import { Knitter } from './knit/knitter.js';
import { Relaxer } from './sim/relax.js';
import { YarnPathBuilder } from './render/yarnpath.js';
import { KnitScene } from './render/scene.js';
import { WEIGHTS, NEEDLE_SIZES, weightById, needleLabel, YarnColors, CM_PER_IN, YD_PER_M } from './yarn.js';
import { EXAMPLES } from './examples.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_COLORS = { A: '#b5443c', B: '#3b6ea5', C: '#d9a441', D: '#4e8a5a', E: '#7a5aa6', MC: '#b5443c', CC: '#3b6ea5' };

const state = {
  text: EXAMPLES[0].text,
  weight: 'dk',
  needle: 4.0,
  sts: 22,
  rows: 30,
  sizeIndex: 0,
  roundMode: 'auto',
  tension: 'normal',
  plies: 4,
  units: 'metric',
  yarns: { A: { kind: 'solid', color: DEFAULT_COLORS.A, stripes: [{ color: '#b5443c', length: 60 }, { color: '#e8d9b5', length: 40 }] } },
  stop: null, // null = finished piece; else {row, stitch}
  lifelines: [],
  markers: [],
  showNeedles: true,
};

let scene;
let full = null;      // knitter result for the whole pattern
let view = null;      // knitter result up to the stop point
let parsed = null;
let prevPositions = null; // Map id -> [x,y,z] for warm starts
let prevKey = null;       // what the warm start positions belong to
let pathBuilder = null;
let lastPositions = null;
let appliedGauge = null;
let debounceTimer = null;

// ---------------------------------------------------------------------------
// Persistence

function save() {
  try { localStorage.setItem('yarnworks', JSON.stringify(state)); } catch (e) { /* ignore */ }
}
function load() {
  try {
    const raw = localStorage.getItem('yarnworks');
    if (!raw) return;
    const s = JSON.parse(raw);
    Object.assign(state, s);
    if (!state.yarns || !state.yarns.A) state.yarns = { A: { kind: 'solid', color: DEFAULT_COLORS.A, stripes: [] } };
    if (!s.plies) state.plies = weightById(state.weight).plies;
    if (!s.units) state.units = 'metric';
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Settings UI

function initSettings() {
  const weight = $('weight');
  for (const w of WEIGHTS) {
    const o = document.createElement('option');
    o.value = w.id; o.textContent = w.name;
    weight.appendChild(o);
  }
  weight.value = state.weight;
  fillNeedleSelect();
  $('gauge-sts').value = state.sts;
  $('gauge-rows').value = state.rows;
  $('round').value = state.roundMode;
  applyUnits();
  for (const b of $('units').querySelectorAll('button')) {
    b.addEventListener('click', () => { state.units = b.dataset.units; applyUnits(); renderYarnControls(); updatePositionUI(); save(); });
  }
  $('tension').value = state.tension;
  $('plies').value = String(state.plies || 3);
  $('plies').addEventListener('change', () => { state.plies = parseInt($('plies').value, 10) || 3; scheduleUpdate(true, true); });
  $('tension').addEventListener('change', () => { state.tension = $('tension').value; scheduleUpdate(true); });

  weight.addEventListener('change', () => {
    const w = weightById(weight.value);
    state.weight = w.id; state.needle = w.needle; state.sts = w.sts; state.rows = w.rows; state.plies = w.plies;
    fillNeedleSelect(); $('gauge-sts').value = w.sts; $('gauge-rows').value = w.rows; $('plies').value = String(w.plies);
    scheduleUpdate(true);
  });
  $('needle').addEventListener('change', () => {
    const v = parseFloat($('needle').value);
    if (Number.isFinite(v) && v > 0) { state.needle = v; scheduleUpdate(true); }
  });
  for (const [id, key] of [['gauge-sts', 'sts'], ['gauge-rows', 'rows']]) {
    $(id).addEventListener('change', () => {
      const v = parseFloat($(id).value);
      if (Number.isFinite(v) && v > 0) { state[key] = v; scheduleUpdate(true); }
    });
  }
  $('size').addEventListener('change', () => { state.sizeIndex = parseInt($('size').value, 10) || 0; scheduleUpdate(true); });
  $('round').addEventListener('change', () => { state.roundMode = $('round').value; scheduleUpdate(true); });

  const example = $('example');
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = '—';
  example.appendChild(blank);
  EXAMPLES.forEach((ex, i) => {
    const o = document.createElement('option');
    o.value = String(i); o.textContent = ex.name;
    example.appendChild(o);
  });
  example.addEventListener('change', () => {
    if (example.value === '') return;
    state.text = EXAMPLES[parseInt(example.value, 10)].text;
    $('pattern').value = state.text;
    state.stop = null; state.lifelines = []; state.markers = [];
    scene.fitted = false;
    scheduleUpdate(true);
  });

  const pattern = $('pattern');
  pattern.value = state.text;
  pattern.addEventListener('input', () => {
    state.text = pattern.value;
    example.value = '';
    if ($('auto').checked) scheduleUpdate(false);
  });
  $('knit').addEventListener('click', () => scheduleUpdate(true));

  $('show-needles').checked = state.showNeedles;
  $('show-needles').addEventListener('change', () => { state.showNeedles = $('show-needles').checked; scene.setNeedlesVisible(state.showNeedles); save(); });
  $('fit').addEventListener('click', () => scene.fit(true));
  $('flip').addEventListener('click', () => scene.flip());
  $('upside').addEventListener('click', () => scene.turnOver());

  // Position controls.
  $('row-slider').addEventListener('input', () => { setStop(parseInt($('row-slider').value, 10), null); });
  $('st-slider').addEventListener('input', () => { setStop(currentRowIndex(), parseInt($('st-slider').value, 10)); });
  $('row-minus').addEventListener('click', () => stepRow(-1));
  $('row-plus').addEventListener('click', () => stepRow(1));
  $('st-minus').addEventListener('click', () => stepStitch(-1));
  $('st-plus').addEventListener('click', () => stepStitch(1));
  $('to-start').addEventListener('click', () => setStop(0, null));
  $('to-end').addEventListener('click', () => setStop(null, null));

  $('add-lifeline').addEventListener('click', () => {
    const r = currentRowIndex();
    if (!state.lifelines.includes(r)) state.lifelines.push(r);
    state.lifelines.sort((a, b) => a - b);
    renderHelpers();
    scheduleUpdate(true);
  });
  $('add-marker').addEventListener('click', () => {
    const r = currentRowIndex();
    const s = currentStitch();
    if (s === 0 && r === 0) return;
    if (!state.markers.some((m) => m.row === r && m.stitch === s)) state.markers.push({ row: r, stitch: s });
    renderHelpers();
    scheduleUpdate(true);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'ArrowRight') { stepStitch(1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { stepStitch(-1); e.preventDefault(); }
    if (e.key === 'ArrowUp') { stepRow(1); e.preventDefault(); }
    if (e.key === 'ArrowDown') { stepRow(-1); e.preventDefault(); }
  });
}

/** Needle sizes as a list, labelled for the current units; keeps a custom size if set. */
function fillNeedleSelect() {
  const sel = $('needle');
  sel.innerHTML = '';
  const sizes = NEEDLE_SIZES.map((r) => r[0]);
  if (!sizes.some((mm) => Math.abs(mm - state.needle) < 0.01)) sizes.push(state.needle);
  sizes.sort((a, b) => a - b);
  for (const mm of sizes) {
    const o = document.createElement('option');
    o.value = String(mm);
    o.textContent = needleLabel(mm, state.units);
    sel.appendChild(o);
  }
  sel.value = String(state.needle);
}

/** Update unit-dependent labels. Gauge numbers follow knitting convention: per 10 cm and per 4 in are the same figure. */
function applyUnits() {
  const us = state.units === 'us';
  $('gauge-sts-label').textContent = us ? 'Sts / 4 in' : 'Sts / 10 cm';
  $('gauge-rows-label').textContent = us ? 'Rows / 4 in' : 'Rows / 10 cm';
  for (const b of $('units').querySelectorAll('button')) b.classList.toggle('on', b.dataset.units === state.units);
  fillNeedleSelect();
}

function lengthText(mm) {
  return state.units === 'us' ? `${(mm / 1000 * YD_PER_M).toFixed(1)} yd` : `${(mm / 1000).toFixed(1)} m`;
}

function renderYarnControls() {
  const box = $('yarns');
  box.innerHTML = '';
  const names = new Set(['A']);
  if (full) for (const n of full.nodes) if (n.yarn) names.add(n.yarn);
  for (const name of names) {
    if (!state.yarns[name]) state.yarns[name] = { kind: 'solid', color: DEFAULT_COLORS[name] || '#888888', stripes: [] };
    const y = state.yarns[name];
    const div = document.createElement('div');
    div.className = 'yarn';
    const head = document.createElement('div');
    head.className = 'head';
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = name === 'A' ? (names.size > 1 ? 'Yarn A (main)' : 'Yarn') : `Yarn ${name}`;
    const color = document.createElement('input');
    color.type = 'color'; color.value = y.color; color.title = 'Yarn colour';
    color.addEventListener('input', () => { y.color = color.value; scheduleUpdate(true, true); });
    const stripeLabel = document.createElement('label');
    stripeLabel.className = 'inline';
    const stripe = document.createElement('input');
    stripe.type = 'checkbox'; stripe.checked = y.kind === 'stripes';
    stripe.addEventListener('change', () => {
      y.kind = stripe.checked ? 'stripes' : 'solid';
      if (stripe.checked && (!y.stripes || y.stripes.length === 0)) y.stripes = [{ color: y.color, length: 60 }, { color: '#e8d9b5', length: 40 }];
      renderYarnControls();
      scheduleUpdate(true, true);
    });
    stripeLabel.append(stripe, 'Self-striping');
    head.append(label, color, stripeLabel);
    div.appendChild(head);
    if (y.kind === 'stripes') {
      const list = document.createElement('div');
      list.className = 'stripes';
      y.stripes.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'stripe';
        const c = document.createElement('input');
        c.type = 'color'; c.value = s.color;
        c.addEventListener('input', () => { s.color = c.value; scheduleUpdate(true, true); });
        const l = document.createElement('input');
        const us = state.units === 'us';
        l.type = 'number'; l.min = '0.5'; l.step = us ? '1' : '5';
        l.value = us ? (s.length / CM_PER_IN).toFixed(1).replace(/\.0$/, '') : s.length;
        l.addEventListener('change', () => {
          const v = Math.max(0.5, parseFloat(l.value) || 1);
          s.length = us ? v * CM_PER_IN : v;
          scheduleUpdate(true, true);
        });
        const unit = document.createElement('span');
        unit.className = 'unit'; unit.textContent = us ? 'in of yarn' : 'cm of yarn';
        const del = document.createElement('button');
        del.className = 'small'; del.textContent = '×'; del.title = 'Remove this colour';
        del.addEventListener('click', () => { y.stripes.splice(i, 1); renderYarnControls(); scheduleUpdate(true, true); });
        row.append(c, l, unit, del);
        list.appendChild(row);
      });
      const add = document.createElement('button');
      add.className = 'small'; add.textContent = '+ colour';
      add.addEventListener('click', () => { y.stripes.push({ color: '#888888', length: 50 }); renderYarnControls(); scheduleUpdate(true, true); });
      list.appendChild(add);
      div.appendChild(list);
    }
    box.appendChild(div);
  }
}

function renderHelpers() {
  const ul = $('helpers');
  ul.innerHTML = '';
  for (const r of state.lifelines) {
    const li = document.createElement('li');
    const sw = document.createElement('span'); sw.className = 'swatch lifeline';
    const label = document.createElement('span'); label.className = 'grow';
    label.textContent = `Lifeline after ${rowName(r)}`;
    const del = document.createElement('button'); del.className = 'small'; del.textContent = 'Remove';
    del.addEventListener('click', () => { state.lifelines = state.lifelines.filter((x) => x !== r); renderHelpers(); scheduleUpdate(true); });
    li.append(sw, label, del);
    ul.appendChild(li);
  }
  for (const m of state.markers) {
    const li = document.createElement('li');
    const sw = document.createElement('span'); sw.className = 'swatch marker';
    const label = document.createElement('span'); label.className = 'grow';
    label.textContent = `Marker after stitch ${m.stitch} of ${rowName(m.row)}`;
    const del = document.createElement('button'); del.className = 'small'; del.textContent = 'Remove';
    del.addEventListener('click', () => { state.markers = state.markers.filter((x) => x !== m); renderHelpers(); scheduleUpdate(true); });
    li.append(sw, label, del);
    ul.appendChild(li);
  }
}

function rowName(r) {
  if (!full || !full.rows[r]) return `row ${r}`;
  const row = full.rows[r];
  return row.castOn ? 'the cast on' : row.label.toLowerCase().startsWith('row') || row.label.toLowerCase().startsWith('rnd') ? `${row.label} (work row ${r})` : `${row.label} (row ${r})`;
}

// ---------------------------------------------------------------------------
// Position

function currentRowIndex() {
  if (!full) return 0;
  if (state.stop === null) return full.rows.length - 1;
  return Math.min(state.stop.row, full.rows.length - 1);
}
function currentStitch() {
  if (!full) return 0;
  const r = currentRowIndex();
  const count = full.rows[r] ? full.rows[r].nodes.length : 0;
  if (state.stop === null || state.stop.stitch === null) return count;
  return Math.min(state.stop.stitch, count);
}

function setStop(row, stitch) {
  if (!full) return;
  const last = full.rows.length - 1;
  if (row === null || (row >= last && (stitch === null || stitch >= full.rows[last].nodes.length))) {
    state.stop = null;
  } else {
    row = Math.max(0, Math.min(last, row));
    const count = full.rows[row].nodes.length;
    if (stitch !== null) stitch = Math.max(0, Math.min(count, stitch));
    state.stop = { row, stitch: stitch === null || stitch >= count ? null : stitch };
  }
  scheduleUpdate(true);
}

function stepRow(delta) {
  if (!full) return;
  const r = currentRowIndex() + delta;
  setStop(r, null);
}

function stepStitch(delta) {
  if (!full) return;
  let r = currentRowIndex();
  let s = currentStitch();
  const count = (row) => full.rows[row].nodes.length;
  if (delta > 0) {
    if (s < count(r)) s++;
    else if (r < full.rows.length - 1) { r++; s = Math.min(1, count(r)); }
    else return;
  } else {
    if (s > 1) s--;
    else if (s === 1 && r === 0) s = 0;
    else if (r > 0) { r--; s = count(r); }
    else return;
  }
  setStop(r, s);
}

function updatePositionUI() {
  const rowSlider = $('row-slider'), stSlider = $('st-slider');
  if (!full || full.rows.length === 0) {
    rowSlider.max = 0; stSlider.max = 0;
    $('row-readout').textContent = 'No rows yet';
    $('stitch-readout').textContent = '';
    $('yarn-readout').textContent = '';
    return;
  }
  const r = currentRowIndex();
  const s = currentStitch();
  const row = full.rows[r];
  rowSlider.max = full.rows.length - 1; rowSlider.value = r;
  stSlider.max = row.nodes.length; stSlider.value = s;
  const workRows = full.rows.length - 1;
  const side = row.isRound ? 'round' : row.side.toUpperCase();
  let text;
  if (row.castOn) text = `Cast on · ${row.stitchesAfter} sts`;
  else {
    const label = row.label === `Row ${r}` || row.label === `Rnd ${r}` ? '' : ` · ${row.label}`;
    const sts = row.stitchesBefore === row.stitchesAfter ? `${row.stitchesAfter} sts` : `${row.stitchesBefore} → ${row.stitchesAfter} sts`;
    const section = row.section ? `${row.section} · ` : '';
    text = `${section}${row.isRound ? 'Round' : 'Row'} ${r} of ${workRows}${label} (${side}) · ${sts}`;
  }
  $('row-readout').textContent = text;
  // The pattern line this row comes from.
  const src = $('row-source');
  if (row.loc && !row.castOn) {
    const line = (state.text.split('\n')[row.loc.line - 1] || '').trim();
    src.textContent = line;
    src.hidden = false;
  } else {
    src.hidden = true;
  }
  const total = row.nodes.length;
  let st;
  if (s >= total && !row.complete && full.stopped) {
    st = `Knitting stopped here after ${total} stitch${total === 1 ? '' : 'es'} because of the error above.`;
  } else if (s >= total) {
    st = state.stop === null && full.finished ? 'Finished and bound off.' : `Row complete (${total} stitch${total === 1 ? '' : 'es'} worked).`;
    if (r < full.rows.length - 1 && state.stop !== null) st += ` Next: ${full.rows[r + 1].label}.`;
  } else {
    const next = full.nodes[row.nodes[s]];
    st = `Stitch ${s} of ${total} worked. Next: `;
    $('stitch-readout').textContent = st;
    const code = document.createElement('span');
    code.className = 'next';
    code.textContent = describeOp(next, row, s);
    $('stitch-readout').appendChild(code);
  }
  if (s >= total) $('stitch-readout').textContent = st;
  // Yarn used so far.
  let used;
  if (state.stop === null) used = full.yarnLength;
  else if (s < total) used = full.nodes[row.nodes[s]].yarnStart;
  else used = r + 1 < full.rows.length && full.rows[r + 1].nodes.length ? full.nodes[full.rows[r + 1].nodes[0]].yarnStart : full.yarnLength;
  $('yarn-readout').textContent = `Yarn used: ${lengthText(used)}`;
}

function describeOp(node, row, s) {
  // Group consecutive identical ops for a friendlier readout (k5 rather than k).
  let n = 0;
  for (let i = s; i < row.nodes.length; i++) {
    const m = full.nodes[row.nodes[i]];
    if (m.op === node.op && m.mods.join() === node.mods.join()) n++; else break;
  }
  const mods = node.mods.length ? ' ' + node.mods.join(' ') : '';
  if ((node.op === 'k' || node.op === 'p' || node.op === 'sl') && n > 1) return `${node.op}${n}${mods}`;
  return node.op + mods;
}

// ---------------------------------------------------------------------------
// Knitting pipeline

function scheduleUpdate(immediate, colorsOnly = false) {
  clearTimeout(debounceTimer);
  if (immediate) { update(colorsOnly); return; }
  debounceTimer = setTimeout(() => update(false), 350);
}

function showMessages(list) {
  const ul = $('messages');
  ul.innerHTML = '';
  for (const m of list) {
    const li = document.createElement('li');
    li.className = m.severity;
    if (m.loc) {
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = `Line ${m.loc.line}:`;
      li.appendChild(where);
      li.addEventListener('click', () => selectLine(m.loc));
      li.title = 'Click to jump to this line';
    }
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = m.severity === 'problem' ? 'check' : m.severity;
    li.appendChild(kind);
    li.appendChild(document.createTextNode(m.message));
    ul.appendChild(li);
  }
}

function selectLine(loc) {
  const ta = $('pattern');
  const lines = ta.value.split('\n');
  let start = 0;
  for (let i = 0; i < loc.line - 1 && i < lines.length; i++) start += lines[i].length + 1;
  const lineText = lines[loc.line - 1] || '';
  const from = start + Math.max(0, (loc.col || 1) - 1);
  const to = loc.end ? start + Math.min(lineText.length, loc.end - 1) : start + lineText.length;
  ta.focus();
  ta.setSelectionRange(from, Math.max(from + 1, to));
}

function knitOpts(stopAt) {
  const w = weightById(state.weight);
  return {
    sizeIndex: state.sizeIndex,
    stitchWidth: 100 / state.sts,
    rowHeight: 100 / state.rows,
    inRound: state.roundMode === 'auto' ? undefined : state.roundMode === 'round',
    stopAt,
    markers: state.markers,
    needleMm: state.needle || w.needle,
  };
}

function update(colorsOnly) {
  save();
  const t0 = performance.now();
  const status = $('status');
  parsed = parsePattern(state.text);
  const messages = parsed.errors.map((e) => ({ severity: 'error', message: e.message, loc: e.loc }));

  // Sizes.
  const sizeSel = $('size');
  const nSizes = parsed.sizes.count;
  sizeSel.innerHTML = '';
  for (let i = 0; i < nSizes; i++) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = parsed.sizes.names ? parsed.sizes.names[i] : nSizes > 1 ? `Size ${i + 1}` : '—';
    sizeSel.appendChild(o);
  }
  if (state.sizeIndex >= nSizes) state.sizeIndex = 0;
  sizeSel.value = String(state.sizeIndex);
  sizeSel.disabled = nSizes <= 1;

  // A gauge stated in the pattern sets the gauge inputs (once per pattern text).
  const gaugeStmt = parsed.statements.find((st) => st.type === 'gauge');
  if (gaugeStmt) {
    const key = `${gaugeStmt.sts}/${gaugeStmt.rows}`;
    if (appliedGauge !== key) {
      appliedGauge = key;
      state.sts = gaugeStmt.sts;
      state.rows = gaugeStmt.rows || Math.round(gaugeStmt.sts * 1.4);
      $('gauge-sts').value = state.sts; $('gauge-rows').value = state.rows;
    }
  } else {
    appliedGauge = null;
  }
  full = new Knitter(parsed, knitOpts(null)).run();
  messages.push(...full.messages);
  if (messages.length === 0) {
    const rows = full.rows.length - 1;
    messages.push({ severity: 'ok', message: `${rows} row${rows === 1 ? '' : 's'} knit, ${full.nodes.length} stitches, ${lengthText(full.yarnLength)} of yarn.${full.finished ? '' : ' The piece has not been bound off.'}`, loc: null });
  }
  messages.sort((a, b) => (a.loc ? a.loc.line : 1e9) - (b.loc ? b.loc.line : 1e9) || (a.severity === 'error' ? -1 : 1));
  showMessages(messages);
  renderYarnControls();

  // Clamp the stop point to the rows that exist.
  if (state.stop !== null) {
    if (state.stop.row >= full.rows.length) state.stop = null;
    else if (state.stop.stitch !== null && state.stop.stitch >= full.rows[state.stop.row].nodes.length) state.stop.stitch = null;
  }
  view = state.stop === null ? full : new Knitter(parsed, knitOpts(state.stop)).run();

  updatePositionUI();
  renderHelpers();
  rebuildScene();
  const ms = performance.now() - t0;
  status.textContent = `${view.nodes.length} stitches shown · ${ms.toFixed(0)} ms`;
}

function rebuildScene() {
  scene.clear();
  if (!view || view.nodes.length === 0) return;
  const w = 100 / state.sts, h = 100 / state.rows;
  // Tension: at a fixed gauge, tighter knitting means the yarn fills more of each stitch.
  const yarnRadius = w * ({ loose: 0.18, normal: 0.21, tight: 0.24 }[state.tension] || 0.21);

  // Relax positions (warm start from the previous layout so knitting along feels stable,
  // but only if the pattern and settings are unchanged so node ids still mean the same thing).
  const key = JSON.stringify([state.text, state.sts, state.rows, state.sizeIndex, state.roundMode, state.markers]);
  if (key !== prevKey) { prevPositions = null; prevKey = key; }
  const relaxer = new Relaxer(view, { stitchWidth: w, rowHeight: h, yarnRadius, prev: prevPositions });
  const iters = Math.min(500, 100 + Math.round(Math.sqrt(view.nodes.length) * 5));
  relaxer.relax(iters);
  const pos = relaxer.finish();
  prevPositions = new Map();
  for (let i = 0; i < view.nodes.length; i++) prevPositions.set(i, [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
  lastPositions = pos;

  pathBuilder = new YarnPathBuilder(view, pos, { stitchWidth: w, rowHeight: h, yarnRadius });
  const path = pathBuilder.build();
  const colors = new YarnColors(state.yarns);
  const n = view.nodes.length;
  const quality = n < 3000 ? { subdivisions: 7 } : n < 8000 ? { subdivisions: 5 } : n < 20000 ? { subdivisions: 3 } : { subdivisions: 2 };
  scene.setYarn(path, { radius: yarnRadius, plies: state.plies || 3, ...quality, colorAt: (len, id) => colors.colorAt(len, view.nodes[id].yarn) });

  // Needles.
  const needleRadius = (state.needle || 4) / 2;
  const heads = (ids) => ids.filter((e) => typeof e === 'number').map((id) => pathBuilder.headCentre(id));
  const showNeedles = !(state.stop === null && view.finished);
  if (showNeedles) {
    if (view.inRound) {
      const seq = view.right.concat(view.left);
      const pts = heads(seq);
      scene.addNeedle(pts, { circular: true, radius: needleRadius });
      addMarkers(seq, pathBuilder, needleRadius, w);
    } else {
      const rightPts = heads(view.right).reverse(); // tip first
      const leftPts = heads(view.left);
      const dirR = rowDirection(view, true), dirL = rowDirection(view, false);
      if (rightPts.length) scene.addNeedle(rightPts, { radius: needleRadius, gap: 0.6 * w, tail: 14 * w, direction: dirR });
      if (leftPts.length) scene.addNeedle(leftPts, { radius: needleRadius, gap: 0.6 * w, tail: 14 * w, direction: dirL });
      addMarkers(view.right.slice().reverse(), pathBuilder, needleRadius, w);
      addMarkers(view.left, pathBuilder, needleRadius, w);
    }
  }
  // Lifelines.
  for (const r of state.lifelines) {
    const row = view.rows[r];
    if (!row || !row.complete) continue;
    const ids = row.nodes.filter((id) => view.nodes[id].passedOver === null);
    scene.addLifeline(ids.map((id) => pathBuilder.headCentre(id)), yarnRadius * 0.4);
  }
  scene.setNeedlesVisible(state.showNeedles);
  if (!scene.fitted) { scene.fit(true); scene.fitted = true; }
  else scene.needsRender = true;
}

/** Direction the needle tail should extend, for a needle with a single stitch. */
function rowDirection(view, isRight) {
  const rs = view.side === 'rs';
  const knitDir = rs ? -1 : 1;
  // The right needle's tail extends in the knitting direction; the left needle's the other way.
  return [(isRight ? knitDir : -knitDir), 0, 0];
}

function addMarkers(seq, pb, needleRadius, w) {
  for (let i = 0; i < seq.length; i++) {
    const e = seq[i];
    if (typeof e === 'number') continue;
    let prev = null, next = null;
    for (let j = i - 1; j >= 0; j--) if (typeof seq[j] === 'number') { prev = pb.headCentre(seq[j]); break; }
    for (let j = i + 1; j < seq.length; j++) if (typeof seq[j] === 'number') { next = pb.headCentre(seq[j]); break; }
    let p, axis;
    if (prev && next) { p = [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2, (prev[2] + next[2]) / 2]; axis = [next[0] - prev[0], next[1] - prev[1], next[2] - prev[2]]; }
    else if (prev || next) {
      const q = prev || next;
      const f = view.side === 'rs' ? -1 : 1;
      const d = [f * (prev ? 1 : -1) * 0.5 * w, 0, 0];
      p = [q[0] + d[0], q[1], q[2]]; axis = d;
    } else continue;
    scene.addMarker(p, axis, needleRadius * 1.7);
  }
}

// ---------------------------------------------------------------------------
// Boot

load();
scene = new KnitScene($('canvas'));
initSettings();
renderHelpers();
update(false);

// Debug handle (used by tools/shot.mjs and handy in the console).
window.yarnworks = { scene, state, update, get full() { return full; }, get view() { return view; }, get positions() { return lastPositions; }, setStop };
