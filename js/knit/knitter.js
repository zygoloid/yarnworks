// The virtual knitter: executes a parsed pattern and produces a stitch graph.
//
// Every loop of yarn that ever sits on a needle becomes a Node. Nodes know
// their parents (the loops they were pulled through), and the knitter records
// the order in which nodes were created, which row they belong to, and how
// much yarn each consumed. Errors are reported with source locations.

import { OPS, isSized } from '../pattern/parser.js';
import { PatternError } from '../pattern/lexer.js';

export class KnitError extends PatternError {}

/** Yarn used per stitch, as a multiple of the stitch width. */
const YARN_FACTOR = { k: 2.5, p: 2.5, yo: 1.4, sl: 1.0, m1: 2.0, co: 2.0, bo: 2.5 };

let nextRowId = 0;

export class Knitter {
  /**
   * @param {object} pattern parsed pattern ({statements, sizes})
   * @param {object} opts {sizeIndex, stitchWidth, rowHeight, inRound}
   */
  constructor(pattern, opts = {}) {
    this.pattern = pattern;
    this.sizeIndex = opts.sizeIndex || 0;
    this.stitchWidth = opts.stitchWidth || 4.5;
    this.rowHeight = opts.rowHeight || 3.3;
    this.inRoundOverride = opts.inRound === undefined ? null : opts.inRound;

    this.nodes = [];
    this.rows = [];
    this.messages = []; // {severity: 'error'|'problem'|'warning', message, loc}
    this.left = [];   // loops (node ids) and markers ({marker:true,name}) still to be worked
    this.right = [];  // worked this row
    this.inRound = false;
    this.joined = false;
    this.castOn = false;
    this.side = 'rs';
    this.sideKnown = false;
    this.yarnLength = 0;
    this.yarnName = null;
    this.rowDefs = new Map(); // label -> statement
    this.rowHistory = []; // executed row statements
    this.stopped = false;
    this.currentRow = null;
    this.turnedMidRow = false;
  }

  // -- Utilities --------------------------------------------------------------

  num(v, loc) {
    if (isSized(v)) {
      if (this.sizeIndex >= v.sizes.length) {
        throw new KnitError(`This value only has ${v.sizes.length} size${v.sizes.length === 1 ? '' : 's'} but size ${this.sizeIndex + 1} was selected`, v.loc || loc);
      }
      return v.sizes[this.sizeIndex];
    }
    return v;
  }

  loopsOn(needle) { let n = 0; for (const e of needle) if (typeof e === 'number') n++; return n; }
  remaining() { return this.loopsOn(this.left); }

  message(severity, message, loc) { this.messages.push({ severity, message, loc }); }

  rowLabel() { return this.currentRow ? this.currentRow.label : 'Before the first row'; }

  err(msg, loc) {
    return new KnitError(`${this.rowLabel()}: ${msg}`, loc);
  }

  // -- Node creation ----------------------------------------------------------

  newNode(props) {
    const id = this.nodes.length;
    const yarn = (YARN_FACTOR[props.kind] || 2.5) * this.stitchWidth;
    const node = {
      id,
      row: this.currentRow ? this.currentRow.index : -1,
      pos: this.currentRow ? this.currentRow.nodes.length : id,
      kind: props.kind,          // 'k' | 'p' | 'yo' | 'sl' | 'm1' | 'co' | 'bo'
      face: props.face || 'k',   // as seen from the right side: 'k' | 'p'
      parents: props.parents || [],
      children: [],
      op: props.op || props.kind,
      mods: props.mods || [],
      lean: props.lean || null,  // 'left' | 'right' | 'center' for decreases
      bar: props.bar || null,    // [a, b] loops that an m1 was lifted between
      passedOver: null,          // id of node this loop was passed over (bind off / psso)
      wrapped: false,
      yarnStart: this.yarnLength,
      yarnLength: yarn,
      yarn: this.yarnName,
      loc: props.loc || null,
    };
    this.yarnLength += yarn;
    this.nodes.push(node);
    for (const p of node.parents) this.nodes[p].children.push(id);
    if (this.currentRow) this.currentRow.nodes.push(id);
    return node;
  }

  /** Take `n` loops from the left needle. Errors if there are not enough. */
  take(n, what, loc) {
    const out = [];
    // Markers before the first stitch are slipped implicitly, as a knitter would.
    while (this.left.length > 0 && typeof this.left[0] !== 'number') this.right.push(this.left.shift());
    while (out.length < n) {
      if (this.left.length === 0 || typeof this.left[0] !== 'number') {
        if (this.left.length > 0 && this.left[0].marker) {
          throw this.err(`"${what}" needs ${n} stitch${n === 1 ? '' : 'es'} but there is a stitch marker between them (move or remove the marker first)`, loc);
        }
        const have = out.length;
        throw this.err(`"${what}" needs ${n} stitch${n === 1 ? '' : 'es'} but only ${have} ${have === 1 ? 'is' : 'are'} left on the needle`, loc);
      }
      out.push(this.left.shift());
    }
    return out;
  }

  put(node) { this.right.push(node.id); }
  lastWorked() { for (let i = this.right.length - 1; i >= 0; i--) if (typeof this.right[i] === 'number') return this.right[i]; return null; }
  nextLoop() { for (const e of this.left) if (typeof e === 'number') return e; return null; }

  /** The face this stitch shows on the RS, given it was worked as `op` ('k' or 'p'). */
  faceFor(op) {
    const knitFace = op === 'k';
    return (this.side === 'rs') === knitFace ? 'k' : 'p';
  }

  // -- Running ----------------------------------------------------------------

  run() {
    try {
      this.executeStatements(this.pattern.statements);
      if (!this.castOn && this.nodes.length === 0) {
        this.message('error', 'The pattern does not cast on any stitches. Start with e.g. "Cast on 20 sts".', null);
      }
    } catch (e) {
      if (e instanceof PatternError) {
        this.message('error', e.message, e.loc);
        this.stopped = true;
        if (this.currentRow && !this.currentRow.complete) this.finishRow(true);
      } else {
        throw e;
      }
    }
    return this.result();
  }

  result() {
    return {
      nodes: this.nodes,
      rows: this.rows,
      messages: this.messages,
      inRound: this.inRound,
      yarnLength: this.yarnLength,
      stopped: this.stopped,
      stitchWidth: this.stitchWidth,
      rowHeight: this.rowHeight,
      // Final needle state, for rendering when the piece is shown complete.
      left: this.left.slice(),
      right: this.right.slice(),
    };
  }

  executeStatements(stmts) {
    let i = 0;
    while (i < stmts.length) {
      const s = stmts[i];
      const isRowLike = (x) => x.type === 'row' || (x.type === 'repeatRows' && x.labels);
      if (isRowLike(s)) {
        let j = i;
        while (j < stmts.length && isRowLike(stmts[j])) j++;
        this.executeRowBlock(stmts.slice(i, j));
        i = j;
      } else {
        this.executeStatement(s);
        i++;
      }
    }
  }

  executeStatement(s) {
    switch (s.type) {
      case 'sizes': return;
      case 'castOn': return this.doCastOn(s);
      case 'join': return this.doJoin(s);
      case 'bindOff': return this.doBindOffAll(s);
      case 'repeatRows': return this.doRepeatRows(s, null);
      case 'plainRows': return this.doPlainRows(s);
      case 'yarn': this.yarnName = s.name; return;
      default: throw new KnitError(`Unsupported statement type ${s.type}`, s.loc);
    }
  }

  doCastOn(s) {
    const n = this.num(s.count, s.loc);
    if (this.castOn && this.nodes.length > 0 && (this.left.length || this.right.length)) {
      // Casting on more stitches at the start of a row (e.g. for a sleeve): add to the right needle.
      this.beginRow({ label: 'Cast on', loc: s.loc, isRound: this.inRound, castOn: true });
      for (let i = 0; i < n; i++) this.put(this.newNode({ kind: 'co', loc: s.loc }));
      // These sit on the needle with the unworked stitches; move them onto the left needle in order.
      this.finishRow(false);
      return;
    }
    this.castOn = true;
    this.side = 'ws';
    const row = this.startRow('Cast on', s.loc, false, true);
    row.castOn = true;
    for (let i = 0; i < n; i++) this.put(this.newNode({ kind: 'co', loc: s.loc }));
    this.finishRow(false);
    if (this.inRoundOverride === true) { this.inRound = true; this.joined = true; this.side = 'rs'; }
  }

  doJoin(s) {
    if (!this.castOn) throw new KnitError('Cast on before joining in the round', s.loc);
    if (this.inRoundOverride === false) {
      this.message('warning', 'The pattern joins in the round, but "knit flat" is selected in the settings', s.loc);
      return;
    }
    this.inRound = true;
    this.joined = true;
    this.side = 'rs';
  }

  // -- Rows -------------------------------------------------------------------

  startRow(label, loc, isRound, isCastOn = false) {
    if (!this.castOn) throw new KnitError(`${label}: cast on some stitches first (e.g. "Cast on 20 sts")`, loc);
    if (this.currentRow) this.finishRow(false);
    // Turn the work (or continue around) so the stitches to work are on the left needle.
    if (!isCastOn) this.beginRowNeedles();
    const row = {
      index: this.rows.length,
      label,
      side: this.side,
      isRound: this.inRound,
      loc,
      nodes: [],
      complete: false,
      short: false,
      stitchesBefore: this.remaining(),
      stitchesAfter: 0,
      markersBefore: this.markerPositions(this.left),
    };
    this.rows.push(row);
    this.currentRow = row;
    return row;
  }

  beginRow(opts) { return this.startRow(opts.label, opts.loc, opts.isRound); }

  beginRowNeedles() {
    // After a mid-row turn the work has already been turned.
    if (this.turnedMidRow) { this.turnedMidRow = false; return; }
    this.turn();
  }

  turn() {
    if (this.inRound) {
      // Continue around: the right needle's stitches become the left needle's, in the same order.
      this.left = this.right.concat(this.left);
      this.right = [];
    } else {
      const newLeft = this.right.slice().reverse();
      const newRight = this.left.slice().reverse();
      this.left = newLeft;
      this.right = newRight;
      this.side = this.side === 'rs' ? 'ws' : 'rs';
    }
  }

  markerPositions(needle) {
    const out = [];
    let n = 0;
    for (const e of needle) {
      if (typeof e === 'number') n++;
      else out.push({ after: n, name: e.name });
    }
    return out;
  }

  finishRow(aborted) {
    const row = this.currentRow;
    if (!row) return;
    row.complete = !aborted;
    row.stitchesAfter = this.loopsOn(this.right) + this.loopsOn(this.left);
    row.markersAfter = this.markerPositions(this.right.concat(this.left));
    this.currentRow = null;
    if (!aborted && !row.castOn) this.rowHistory.push(row.stmt || null);
  }

  /** Execute a block of consecutive row statements, honouring row labels. */
  executeRowBlock(block) {
    const labelled = block.every((s) => s.labels);
    if (!labelled) {
      for (const s of block) this.executeRowStatement(s);
      return;
    }
    // Build the label map.
    const map = new Map();
    let min = Infinity, max = -Infinity;
    const claim = (label, s) => {
      if (map.has(label)) throw new KnitError(`${rowWord(s)} ${label} is defined twice`, s.loc);
      map.set(label, s);
      min = Math.min(min, label); max = Math.max(max, label);
    };
    for (const s of block) {
      if (s.labels.list) for (const l of s.labels.list) claim(l, s);
      else for (let l = s.labels.from; l <= s.labels.to; l++) claim(l, s);
    }
    // "and all WS rows" fill-ins.
    for (const s of block) {
      if (!s.andAll) continue;
      const first = s.labels.list ? s.labels.list[0] : s.labels.from;
      for (let l = min; l <= max; l++) {
        if (map.has(l)) continue;
        let match;
        if (s.andAll === 'even') match = l % 2 === 0;
        else if (s.andAll === 'odd') match = l % 2 === 1;
        else match = (l - first) % 2 === 0; // same side as the defining row
        if (match) map.set(l, s);
      }
    }
    for (let l = min; l <= max; l++) {
      const s = map.get(l);
      if (!s) {
        const near = map.get(l - 1) || block[0];
        throw new KnitError(`${rowWord(near)} ${l} is missing (rows ${min}-${max} are defined here, but not ${l})`, near.loc);
      }
      if (s.type === 'repeatRows') {
        this.rowDefs.set(l, s);
        if (s.labels.from !== undefined && l !== s.labels.from) continue; // covered by the repeat
        if (s.labels.list && l !== s.labels.list[0]) continue;
        this.doRepeatRows(s, s);
        continue;
      }
      this.rowDefs.set(l, s);
      this.executeRowStatement(s, l);
    }
  }

  /** Execute one row statement as one row. */
  executeRowStatement(s, label) {
    if (s.isRound && !this.inRound) {
      if (this.inRoundOverride === false) {
        this.message('warning', 'This is a round but "knit flat" is selected; working it as a row', s.loc);
      } else if (!this.joined) {
        this.inRound = true;
        this.joined = true;
        this.side = 'rs';
        this.message('warning', 'The pattern uses rounds without saying "Join in the round"; assuming the work is joined after the cast on', s.loc);
      }
    }
    if (!s.isRound && this.inRound && s.labels !== null && this.inRoundOverride !== true) {
      this.message('warning', 'This is written as a row but the work is joined in the round; working it as a round', s.loc);
    }
    const labelText = label !== undefined ? `${s.isRound ? 'Rnd' : 'Row'} ${label}` : (s.isRound ? 'Next rnd' : 'Next row');
    // Side handling: adopt the declared side on the first row, warn on contradictions later.
    if (s.side && !this.inRound) {
      if (!this.sideKnown) {
        // The side of the row about to be worked is the opposite of the current side (we turn first).
        this.side = s.side === 'rs' ? 'ws' : 'rs';
        this.sideKnown = true;
      } else if (this.upcomingSide() !== s.side) {
        this.message('warning', `${labelText} is labelled ${s.side.toUpperCase()} but it will be worked as a ${this.upcomingSide().toUpperCase()} row`, s.loc);
      }
    }
    this.sideKnown = true;
    const row = this.startRow(labelText, s.loc, s.isRound);
    row.stmt = s;
    row.patternLabel = label !== undefined ? label : null;
    this.executeItems(s.instructions);
    this.endOfRow(s);
  }

  upcomingSide() {
    if (this.inRound) return 'rs';
    if (this.turnedMidRow) return this.side;
    return this.side === 'rs' ? 'ws' : 'rs';
  }

  endOfRow(s) {
    const row = this.currentRow;
    if (row.turned) {
      // Short row: the row ended at a turn.
    } else {
      const rem = this.remaining();
      if (rem > 0) {
        throw this.err(`${rem} stitch${rem === 1 ? ' is' : 'es are'} left unworked at the end of the row (the instructions only use ${row.stitchesBefore - rem} of ${row.stitchesBefore})`, s.loc);
      }
    }
    if (s.expectedCount !== null && s.expectedCount !== undefined) {
      const expected = this.num(s.expectedCount, s.loc);
      const actual = this.loopsOn(this.right) + this.loopsOn(this.left);
      if (expected !== actual) {
        this.message('problem', `${row.label}: the pattern says there should be ${expected} sts but there are ${actual}`, s.loc);
      }
    }
    this.finishRow(false);
  }

  // -- Repeats of rows ----------------------------------------------------------

  /** Resolve a row reference to the list of statements it names. */
  resolveRowRef(ref, loc) {
    if (ref.last !== undefined) {
      const n = ref.last;
      const hist = this.rowHistory.filter((x) => x);
      if (hist.length < n) throw new KnitError(`"the last ${n} rows" but only ${hist.length} rows have been worked`, loc);
      return hist.slice(hist.length - n);
    }
    const labels = ref.list ? ref.list : [];
    if (ref.from !== undefined) for (let l = ref.from; l <= ref.to; l++) labels.push(l);
    const out = [];
    for (const l of labels) {
      const s = this.rowDefs.get(l);
      if (!s) throw new KnitError(`Row ${l} has not been defined yet, so it cannot be repeated`, loc);
      if (s.type === 'repeatRows' && s.labels) {
        // A labelled repeat ("Rows 3-6: rep rows 1-2"): label l is one row of its expansion.
        const inner = this.resolveRowRef(s.ref, s.loc);
        const from = s.labels.from !== undefined ? s.labels.from : s.labels.list[0];
        out.push(inner[(l - from) % inner.length]);
      } else {
        out.push(s);
      }
    }
    return out;
  }

  /** Execute a "repeat rows" statement. `labelled` is the statement when it carries row labels. */
  doRepeatRows(s, labelled) {
    const stmts = this.resolveRowRef(s.ref, s.loc);
    let nextLabel = labelled && labelled.labels && labelled.labels.from !== undefined ? labelled.labels.from : null;
    const runOnce = () => {
      for (const st of stmts) {
        if (st.type === 'repeatRows') this.doRepeatRows(st, st);
        else {
          let label = st.labels && st.labels.list ? st.labels.list[0] : st.labels && st.labels.from !== undefined ? st.labels.from : undefined;
          if (nextLabel !== null) label = nextLabel++;
          this.executeRowStatement(st, label);
        }
      }
    };
    const t = s.times;
    let count;
    if (t.kind === 'derived') {
      const span = labelled.labels.to - labelled.labels.from + 1;
      if (span % stmts.length !== 0) {
        this.message('problem', `Rows ${labelled.labels.from}-${labelled.labels.to} cover ${span} rows, which is not a whole number of repeats of ${stmts.length} row${stmts.length === 1 ? '' : 's'}`, s.loc);
      }
      count = Math.max(1, Math.round(span / stmts.length));
      for (let i = 0; i < count; i++) runOnce();
      return;
    }
    if (t.kind === 'count') {
      count = this.num(t.count, s.loc);
      if (labelled && labelled.labels && labelled.labels.from !== undefined) {
        const span = labelled.labels.to - labelled.labels.from + 1;
        if (span !== count * stmts.length) {
          this.message('problem', `Rows ${labelled.labels.from}-${labelled.labels.to} cover ${span} rows, but repeating ${stmts.length} row${stmts.length === 1 ? '' : 's'} ${count} times gives ${count * stmts.length}`, s.loc);
        }
      }
      for (let i = 0; i < count; i++) runOnce();
      if (t.endingWith) this.workUntilSide(t.endingWith, stmts, s.loc);
      return;
    }
    if (t.kind === 'measure') {
      const targetMm = t.unit === 'cm' ? this.num(t.length, s.loc) * 10 : t.unit === 'in' ? this.num(t.length, s.loc) * 25.4 : this.num(t.length, s.loc);
      let guard = 0;
      while (this.heightMm() < targetMm - 1e-6) {
        runOnce();
        if (++guard > 5000) throw new KnitError('Too many rows (is the gauge sensible?)', s.loc);
      }
      if (t.endingWith) this.workUntilSide(t.endingWith, stmts, s.loc);
      return;
    }
    if (t.kind === 'stitches') {
      const target = this.num(t.count, s.loc);
      let guard = 0;
      let last = this.stitchCount();
      while (this.stitchCount() !== target) {
        runOnce();
        const now = this.stitchCount();
        if (now === last) throw new KnitError(`Repeating these rows does not change the stitch count (${now}), so "until there are ${target} sts" would never finish`, s.loc);
        if ((last < target && now > target) || (last > target && now < target)) {
          this.message('problem', `Repeating these rows went from ${last} to ${now} sts, skipping over the ${target} sts the pattern asks for`, s.loc);
          break;
        }
        last = now;
        if (++guard > 5000) throw new KnitError('Too many rows', s.loc);
      }
      return;
    }
    if (t.kind === 'rows') {
      const target = this.num(t.count, s.loc);
      let guard = 0;
      while (this.rowsWorked() < target) {
        runOnce();
        if (++guard > 5000) throw new KnitError('Too many rows', s.loc);
      }
      return;
    }
    throw new KnitError(`Unsupported repeat kind ${t.kind}`, s.loc);
  }

  workUntilSide(side, stmts, loc) {
    // Keep working rows from the repeat, one at a time, until the last row worked was `side`.
    let i = 0;
    let guard = 0;
    while (this.lastRowSide() !== side) {
      const st = stmts[i % stmts.length];
      if (st.type === 'repeatRows') this.doRepeatRows(st, st);
      else this.executeRowStatement(st, st.labels && st.labels.list ? st.labels.list[0] : undefined);
      i++;
      if (++guard > 4) throw new KnitError(`Could not end with a ${side.toUpperCase()} row`, loc);
    }
  }

  lastRowSide() {
    for (let i = this.rows.length - 1; i >= 0; i--) if (!this.rows[i].castOn) return this.rows[i].side;
    return null;
  }

  heightMm() { return this.rowsWorked() * this.rowHeight; }
  rowsWorked() { return this.rows.filter((r) => !r.castOn && r.complete).length; }
  stitchCount() { return this.loopsOn(this.left) + this.loopsOn(this.right); }

  doPlainRows(s) {
    const mk = (op, isRound) => ({ type: 'row', isRound, labels: null, andAll: null, side: null, instructions: [{ type: 'toTarget', op, mods: [], target: { kind: 'toEnd', leave: 0 }, loc: s.loc }], expectedCount: null, loc: s.loc });
    const inRound = this.inRound;
    let rowsFor;
    switch (s.stitch) {
      case 'knit': rowsFor = [mk('k', inRound)]; break;
      case 'purl': rowsFor = [mk('p', inRound)]; break;
      case 'garter': rowsFor = inRound ? [mk('k', true), mk('p', true)] : [mk('k', false)]; break;
      case 'reverse garter': rowsFor = inRound ? [mk('p', true), mk('k', true)] : [mk('p', false)]; break;
      case 'stockinette': rowsFor = inRound ? [mk('k', true)] : [mk('k', false), mk('p', false)]; break;
      case 'reverse stockinette': rowsFor = inRound ? [mk('p', true)] : [mk('p', false), mk('k', false)]; break;
      case 'pattern': {
        // Continue in the established pattern: repeat the last block of rows. Use the last two distinct statements.
        const hist = this.rowHistory.filter((x) => x);
        if (hist.length === 0) throw new KnitError('"Work in pattern" but no pattern rows have been worked yet', s.loc);
        // Find the smallest period of the recent history.
        rowsFor = null;
        for (let period = 1; period <= Math.min(hist.length, 16); period++) {
          let ok = hist.length >= period;
          for (let i = hist.length - period - 1; ok && i >= hist.length - 2 * period && i >= 0; i--) if (hist[i] !== hist[i + period]) ok = false;
          if (ok && hist.length >= period) { rowsFor = hist.slice(hist.length - period); break; }
        }
        if (!rowsFor) rowsFor = hist.slice(-1);
        break;
      }
      default: throw new KnitError(`Unknown stitch pattern ${s.stitch}`, s.loc);
    }
    // For stockinette starting on the wrong side, begin with whichever row keeps the RS knit.
    if (!inRound && (s.stitch === 'stockinette' || s.stitch === 'reverse stockinette') && this.upcomingSide() === 'ws') rowsFor.reverse();
    const fake = { ref: { list: [] }, times: s.count, loc: s.loc };
    const saved = this.resolveRowRef;
    this.resolveRowRef = () => rowsFor;
    try { this.doRepeatRows(fake, null); } finally { this.resolveRowRef = saved; }
  }

  // -- Instructions within a row --------------------------------------------------

  executeItems(items) {
    for (const item of items) {
      if (this.currentRow.turned) throw this.err('Instructions continue after "turn" in the same row', item.loc);
      this.executeItem(item);
    }
  }

  executeItem(item) {
    switch (item.type) {
      case 'stitch': return this.doStitch(item);
      case 'toTarget': return this.doToTarget(item);
      case 'group': return this.doRepeat(item.body, item.times, item.loc, 'group');
      case 'star': return this.doRepeat(item.body, item.times, item.loc, 'repeat');
      default: throw this.err(`Unsupported instruction ${item.type}`, item.loc);
    }
  }

  /** Static stitch consumption of a sequence, or null if it depends on the needle state. */
  staticConsumption(items) {
    let total = 0;
    for (const it of items) {
      if (it.type === 'stitch') {
        const op = OPS[it.op];
        if (it.op === 'bo') return null;
        const c = it.count === null ? 1 : this.num(it.count, it.loc);
        total += op.consumes * (it.op === 'yo' || it.op === 'co' ? 0 : c);
        if (it.op === 'psso') { /* consumes from the right needle */ }
      } else if (it.type === 'group' || it.type === 'star') {
        if (it.times.kind !== 'times') return null;
        const inner = this.staticConsumption(it.body);
        if (inner === null) return null;
        total += inner * this.num(it.times.count, it.loc);
      } else {
        return null;
      }
    }
    return total;
  }

  describeItems(items) {
    return items.map((it) => {
      if (it.type === 'stitch') return it.op + (it.count === null || it.count === 'all' ? '' : this.num(it.count, it.loc));
      if (it.type === 'toTarget') return `${it.op} to ...`;
      return '(...)';
    }).join(', ');
  }

  doRepeat(body, times, loc, what) {
    if (times.kind === 'times') {
      const n = this.num(times.count, loc);
      for (let i = 0; i < n; i++) this.executeItems(body);
      return;
    }
    if (times.kind === 'toEnd') {
      const leave = this.num(times.leave, loc);
      const use = this.staticConsumption(body);
      const avail = this.remaining() - leave;
      if (avail < 0) throw this.err(`"to last ${leave} sts" but only ${this.remaining()} sts remain`, loc);
      if (use !== null) {
        if (use === 0) throw this.err(`The ${what} "${this.describeItems(body)}" does not use any stitches, so repeating it "to end" would never finish`, loc);
        if (avail % use !== 0) {
          throw this.err(`The ${what} "${this.describeItems(body)}" uses ${use} sts, but ${avail} sts are available${leave ? ` (after leaving ${leave})` : ''}: ${avail % use} would be left over`, loc);
        }
        for (let i = 0; i < avail / use; i++) this.executeItems(body);
        return;
      }
      let guard = 0;
      while (this.remaining() > leave) {
        const before = this.remaining();
        this.executeItems(body);
        if (this.remaining() === before) throw this.err(`The ${what} "${this.describeItems(body)}" does not use any stitches, so repeating it "to end" would never finish`, loc);
        if (this.currentRow.turned) return;
        if (++guard > 100000) throw this.err('Repeat did not finish', loc);
      }
      if (this.remaining() < leave) throw this.err(`The repeat overshot: ${leave} sts should have been left but only ${this.remaining()} remain`, loc);
      return;
    }
    if (times.kind === 'toMarker') {
      const before = this.num(times.before, loc);
      let guard = 0;
      while (!this.atMarker(before)) {
        if (this.remaining() <= before) throw this.err(`"to marker" but there is no marker ahead on the needle`, loc);
        const rem = this.remaining();
        this.executeItems(body);
        if (this.remaining() === rem) throw this.err(`The ${what} "${this.describeItems(body)}" does not use any stitches`, loc);
        if (this.remaining() < before) throw this.err(`The repeat went past the marker`, loc);
        if (++guard > 100000) throw this.err('Repeat did not finish', loc);
      }
      return;
    }
    throw this.err(`Unsupported repeat`, loc);
  }

  /** True if a marker sits `before` loops ahead on the left needle. */
  atMarker(before) {
    let n = 0;
    for (const e of this.left) {
      if (typeof e === 'number') { n++; if (n > before) return false; }
      else if (n === before) return true;
    }
    return false;
  }

  hasMarkerAhead() { return this.left.some((e) => typeof e !== 'number'); }

  doToTarget(item) {
    const t = item.target;
    const one = { type: 'stitch', op: item.op, count: 1, mods: item.mods, loc: item.loc };
    if (t.kind === 'toEnd') {
      const leave = this.num(t.leave, item.loc);
      const n = this.remaining() - leave;
      if (n < 0) throw this.err(`"${item.op} to last ${leave} sts" but only ${this.remaining()} sts remain`, item.loc);
      for (let i = 0; i < n; i++) this.doStitch(one);
      return;
    }
    if (t.kind === 'toMarker') {
      const before = this.num(t.before, item.loc);
      if (!this.hasMarkerAhead()) throw this.err(`"${item.op} to marker" but there is no marker on the needle ahead`, item.loc);
      let guard = 0;
      while (!this.atMarker(before)) {
        if (this.remaining() <= before) throw this.err(`"${item.op} to ${before} sts before marker" but the marker is closer than that`, item.loc);
        this.doStitch(one);
        if (++guard > 100000) break;
      }
      return;
    }
    throw this.err('Unsupported target', item.loc);
  }

  doStitch(item) {
    const op = item.op;
    const loc = item.loc;
    const mods = item.mods || [];
    let count = item.count === null ? 1 : item.count === 'all' ? 'all' : this.num(item.count, loc);
    switch (op) {
      case 'k':
      case 'p': {
        for (let i = 0; i < count; i++) {
          const [a] = this.take(1, op + (mods.includes('tbl') ? ' tbl' : ''), loc);
          this.put(this.newNode({ kind: op, op, face: this.faceFor(op), parents: [a], mods, loc }));
        }
        return;
      }
      case 'yo': {
        for (let i = 0; i < count; i++) this.put(this.newNode({ kind: 'yo', op, face: 'k', parents: [], loc }));
        return;
      }
      case 'k2tog': case 'p2tog': case 'k3tog': case 'p3tog': case 'ssk': case 'ssp': case 'sssk': case 'skp': case 'sk2p': case 's2kp': {
        const base = op[0] === 'p' || op === 'ssp' ? 'p' : 'k';
        const lean = { k2tog: 'right', p2tog: 'right', k3tog: 'right', p3tog: 'right', ssk: 'left', ssp: 'left', sssk: 'left', skp: 'left', sk2p: 'left', s2kp: 'center' }[op];
        for (let i = 0; i < count; i++) {
          const parents = this.take(OPS[op].consumes, op, loc);
          this.put(this.newNode({ kind: base, op, face: this.faceFor(base), parents, lean, mods, loc }));
        }
        return;
      }
      case 'kfb': case 'pfb': case 'kfbf': {
        const base = op === 'pfb' ? 'p' : 'k';
        for (let i = 0; i < count; i++) {
          const [a] = this.take(1, op, loc);
          this.put(this.newNode({ kind: base, op, face: this.faceFor(base), parents: [a], mods, loc }));
          this.put(this.newNode({ kind: base, op, face: this.faceFor(base === 'k' ? 'p' : 'k'), parents: [a], mods, loc }));
          if (op === 'kfbf') this.put(this.newNode({ kind: base, op, face: this.faceFor(base), parents: [a], mods, loc }));
        }
        return;
      }
      case 'm1': case 'm1l': case 'm1r': case 'm1p': {
        for (let i = 0; i < count; i++) {
          const prev = this.lastWorked();
          const next = this.nextLoop();
          const a = prev !== null ? (this.nodes[prev].parents[0] ?? null) : null;
          const b = next;
          const base = op === 'm1p' ? 'p' : 'k';
          this.put(this.newNode({ kind: 'm1', op, face: this.faceFor(base), parents: [], bar: [a, b], lean: op === 'm1r' ? 'right' : op === 'm1l' ? 'left' : null, loc }));
        }
        return;
      }
      case 'sl': {
        for (let i = 0; i < count; i++) {
          const [a] = this.take(1, 'sl', loc);
          const wyif = mods.includes('wyif');
          // A slipped stitch shows its float on the near side if wyif; record which face the float is on.
          const floatFace = (this.side === 'rs') === wyif ? 'k' : 'p';
          this.put(this.newNode({ kind: 'sl', op, face: floatFace, parents: [a], mods, loc }));
        }
        return;
      }
      case 'psso': {
        // Pass the second stitch on the right needle over the first.
        const idx = [];
        for (let i = this.right.length - 1; i >= 0 && idx.length < 2; i--) if (typeof this.right[i] === 'number') idx.push(i);
        if (idx.length < 2) throw this.err('"psso" needs two stitches on the right needle (a slipped stitch and a knit stitch)', loc);
        const over = this.right[idx[1]];
        const onto = this.right[idx[0]];
        this.right.splice(idx[1], 1);
        this.nodes[over].passedOver = onto;
        return;
      }
      case 'pm': {
        this.right.push({ marker: true, name: null });
        return;
      }
      case 'sm': {
        for (let i = 0; i < count; i++) {
          if (this.left.length === 0 || typeof this.left[0] === 'number') {
            throw this.err(`"sm" (slip marker) but there is no marker here on the needle${this.hasMarkerAhead() ? ` (the next marker is ${this.stitchesToMarker()} sts ahead)` : ''}`, loc);
          }
          this.right.push(this.left.shift());
        }
        return;
      }
      case 'rm': {
        if (this.left.length > 0 && typeof this.left[0] !== 'number') { this.left.shift(); return; }
        const top = this.right[this.right.length - 1];
        if (top && typeof top !== 'number') { this.right.pop(); return; }
        throw this.err('"rm" (remove marker) but there is no marker here', loc);
      }
      case 'co': {
        for (let i = 0; i < count; i++) this.put(this.newNode({ kind: 'co', op, face: 'k', parents: [], loc }));
        return;
      }
      case 'bo': {
        this.doBindOff(count, mods, loc, false);
        return;
      }
      case 'turn': case 'wt': {
        if (op === 'wt') {
          const next = this.nextLoop();
          if (next === null) throw this.err('"w&t" but there is no stitch left to wrap', loc);
          this.nodes[next].wrapped = true;
        }
        this.currentRow.turned = true;
        this.currentRow.short = true;
        this.turn();
        this.turnedMidRow = true;
        return;
      }
      default:
        throw this.err(`The instruction "${op}" is not supported yet`, loc);
    }
  }

  stitchesToMarker() {
    let n = 0;
    for (const e of this.left) { if (typeof e === 'number') n++; else return n; }
    return n;
  }

  /**
   * Bind off `count` stitches ('all' for the rest). Standard method: knit the
   * next stitch and pass the previous stitch over it.
   */
  doBindOff(count, mods, loc, whole) {
    const inPattern = mods.includes('pattern');
    const workOne = () => {
      const [a] = this.take(1, 'bind off', loc);
      let op = 'k';
      if (inPattern) {
        const parentFace = this.nodes[a].face;
        op = (this.side === 'rs') === (parentFace === 'k') ? 'k' : 'p';
      }
      const node = this.newNode({ kind: op, op: 'bo', face: this.faceFor(op), parents: [a], loc });
      this.put(node);
      return node;
    };
    if (count === 'all') count = Math.max(0, this.remaining() - (this.lastWorked() === null ? 1 : 0));
    if (count === 0) return;
    if (this.lastWorked() === null) {
      if (this.remaining() < 2 && count > 0) {
        if (this.remaining() === 1 && whole) { const n = workOne(); n.finished = true; return; }
        throw this.err(`"bind off" needs at least 2 stitches`, loc);
      }
      workOne();
    }
    for (let i = 0; i < count; i++) {
      if (this.remaining() === 0) throw this.err(`"bind off ${count}" but only ${i} stitch${i === 1 ? '' : 'es'} could be bound off before running out`, loc);
      const prev = this.lastWorked();
      const node = workOne();
      // Pass prev over node.
      const idx = this.right.lastIndexOf(prev);
      this.right.splice(idx, 1);
      this.nodes[prev].passedOver = node.id;
      this.nodes[prev].chain = true;
    }
  }

  doBindOffAll(s) {
    if (!this.castOn) throw new KnitError('Bind off: nothing has been cast on yet', s.loc);
    const row = this.startRow('Bind off', s.loc, this.inRound);
    row.stmt = null;
    row.bindOff = true;
    const n = this.remaining();
    if (n === 0) throw new KnitError('Bind off: there are no stitches on the needle', s.loc);
    const mods = s.method === 'pattern' || s.method === 'rib' ? ['pattern'] : [];
    this.doBindOff(n - 1, mods, s.loc, true);
    // Fasten off the last loop.
    const last = this.lastWorked();
    if (last !== null) { this.nodes[last].finished = true; this.nodes[last].chain = true; }
    this.finishRow(false);
    this.finished = true;
  }
}

function rowWord(s) { return s.isRound ? 'Round' : 'Row'; }

/**
 * Convenience: run a pattern and return the result.
 */
export function knit(pattern, opts) {
  return new Knitter(pattern, opts).run();
}
