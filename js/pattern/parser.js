// Parser for knitting patterns written in common semi-formal notation.
//
// The output is an AST of statements. Counts may be size-dependent, in
// which case they are represented as {sizes: [n1, n2, ...]} objects.

import { tokenize, PatternError } from './lexer.js';

// ---------------------------------------------------------------------------
// Vocabulary

// Canonical stitch operations. Each entry: canonical name -> description.
// 'consumes' is how many loops are taken from the left needle,
// 'produces' how many loops are put on the right needle.
export const OPS = {
  k:     { consumes: 1, produces: 1, name: 'knit' },
  p:     { consumes: 1, produces: 1, name: 'purl' },
  yo:    { consumes: 0, produces: 1, name: 'yarn over' },
  k2tog: { consumes: 2, produces: 1, name: 'knit two together' },
  p2tog: { consumes: 2, produces: 1, name: 'purl two together' },
  k3tog: { consumes: 3, produces: 1, name: 'knit three together' },
  p3tog: { consumes: 3, produces: 1, name: 'purl three together' },
  ssk:   { consumes: 2, produces: 1, name: 'slip, slip, knit' },
  ssp:   { consumes: 2, produces: 1, name: 'slip, slip, purl' },
  sssk:  { consumes: 3, produces: 1, name: 'slip, slip, slip, knit' },
  skp:   { consumes: 2, produces: 1, name: 'slip, knit, pass over' },
  sk2p:  { consumes: 3, produces: 1, name: 'slip 1, k2tog, pass over' },
  s2kp:  { consumes: 3, produces: 1, name: 'central double decrease' },
  kfb:   { consumes: 1, produces: 2, name: 'knit front and back' },
  pfb:   { consumes: 1, produces: 2, name: 'purl front and back' },
  kfbf:  { consumes: 1, produces: 3, name: 'knit front, back and front' },
  m1:    { consumes: 0, produces: 1, name: 'make one' },
  m1l:   { consumes: 0, produces: 1, name: 'make one left' },
  m1r:   { consumes: 0, produces: 1, name: 'make one right' },
  m1p:   { consumes: 0, produces: 1, name: 'make one purlwise' },
  sl:    { consumes: 1, produces: 1, name: 'slip' },
  psso:  { consumes: 0, produces: 0, name: 'pass slipped stitch over' },
  pm:    { consumes: 0, produces: 0, name: 'place marker' },
  sm:    { consumes: 0, produces: 0, name: 'slip marker' },
  rm:    { consumes: 0, produces: 0, name: 'remove marker' },
  bo:    { consumes: 1, produces: 0, name: 'bind off' },
  co:    { consumes: 0, produces: 1, name: 'cast on' },
  turn:  { consumes: 0, produces: 0, name: 'turn' },
  wt:    { consumes: 0, produces: 0, name: 'wrap and turn' },
  cable: { consumes: 0, produces: 0, name: 'cable' }, // consumes/produces come from the cable's own counts
};

// Aliases: word -> canonical op (plus optional implied modifiers/count).
const ALIASES = {
  k: 'k', knit: 'k', p: 'p', purl: 'p',
  yo: 'yo', yon: 'yo', yfwd: 'yo', yrn: 'yo', yfrn: 'yo', yof: 'yo',
  k2tog: 'k2tog', p2tog: 'p2tog', k3tog: 'k3tog', p3tog: 'p3tog',
  ssk: 'ssk', ssp: 'ssp', sssk: 'sssk',
  skp: 'skp', skpo: 'skp', sk2p: 'sk2p', s2kp: 's2kp', s2kpo: 's2kp', cdd: 's2kp',
  kfb: 'kfb', pfb: 'pfb', kfbf: 'kfbf', inc: 'kfb', dec: 'k2tog',
  m1: 'm1', m1l: 'm1l', m1r: 'm1r', m1p: 'm1p', m1pl: 'm1p', m1pr: 'm1p',
  sl: 'sl', slip: 'sl', psso: 'psso',
  pm: 'pm', sm: 'sm', rm: 'rm',
  bo: 'bo', co: 'co',
  turn: 'turn', 'w&t': 'wt', wt: 'wt',
  ktbl: 'k', ptbl: 'p',
};
const IMPLIED_MODS = { ktbl: ['tbl'], ptbl: ['tbl'] };

// Multi-word phrases, tried longest first.
const PHRASES = [
  ['pass', 'slipped', 'stitch', 'over', 'psso'],
  ['pass', 'slipped', 'st', 'over', 'psso'],
  ['knit', 'into', 'front', 'and', 'back', 'kfb'],
  ['purl', 'into', 'front', 'and', 'back', 'pfb'],
  ['wrap', 'and', 'turn', 'w&t'],
  ['place', 'marker', 'pm'],
  ['slip', 'marker', 'sm'],
  ['remove', 'marker', 'rm'],
  ['cast', 'on', 'co'],
  ['bind', 'off', 'bo'],
  ['cast', 'off', 'bo'],
  ['yarn', 'over', 'yo'],
  ['make', 'one', 'left', 'm1l'],
  ['make', 'one', 'right', 'm1r'],
  ['make', 'one', 'm1'],
  ['make', '1', 'm1'],
  ['sl1', 'k1', 'psso', 'skp'],
];

const MODIFIERS = new Set(['tbl', 'wyif', 'wyib', 'pwise', 'kwise', 'purlwise', 'knitwise']);
const NOISE = new Set(['st', 'sts', 'stitch', 'stitches', 'the', 'of', 'row', 'rnd', 'round', 'on', 'needle', 'needles', 'total', 'remain', 'remaining', 'rem', 'each', 'all']);

const NUMBER_WORDS = {
  once: 1, twice: 2, thrice: 3,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

const ROW_WORDS = new Set(['row', 'rows', 'round', 'rounds', 'rnd', 'rnds']);
const ROUND_WORDS = new Set(['round', 'rounds', 'rnd', 'rnds']);

// ---------------------------------------------------------------------------
// Helpers for size-dependent values

/** A count is either a number or {sizes: number[]}. */
export function isSized(v) { return v !== null && typeof v === 'object' && Array.isArray(v.sizes); }
export function sizeCount(v) { return isSized(v) ? v.sizes.length : 1; }

// ---------------------------------------------------------------------------
// Token cursor

class Cursor {
  constructor(tokens) { this.toks = tokens; this.i = 0; }
  peek(n = 0) { return this.toks[Math.min(this.i + n, this.toks.length - 1)]; }
  next() { const t = this.toks[this.i]; if (this.i < this.toks.length - 1) this.i++; return t; }
  atEnd() { return this.peek().type === 'eol'; }
  isWord(w, n = 0) { const t = this.peek(n); return t.type === 'word' && (Array.isArray(w) ? w.includes(t.value) : t.value === w); }
  isPunct(p, n = 0) { const t = this.peek(n); return t.type === 'punct' && (Array.isArray(p) ? p.includes(t.value) : t.value === p); }
  isNum(n = 0) { return this.peek(n).type === 'num'; }
  acceptWord(w) { if (this.isWord(w)) return this.next(); return null; }
  acceptPunct(p) { if (this.isPunct(p)) return this.next(); return null; }
  expectWord(w, what) {
    if (this.isWord(w)) return this.next();
    throw this.error(`Expected "${what || w}"`);
  }
  expectPunct(p, what) {
    if (this.isPunct(p)) return this.next();
    throw this.error(`Expected "${what || p}"`);
  }
  loc(from = this.peek(), to = from) { return { line: from.line, col: from.col, end: to.end }; }
  error(msg, tok = this.peek()) {
    const what = tok.type === 'eol' ? ' at end of line' : ` at "${tok.text}"`;
    return new PatternError(msg + what, this.loc(tok));
  }
  skipNoise() { while (this.peek().type === 'word' && NOISE.has(this.peek().value)) this.next(); }
  /** Number, possibly written as a word (twice, three). Returns null if none. */
  acceptNumberWord() {
    const t = this.peek();
    if (t.type === 'num') { this.next(); return t.value; }
    if (t.type === 'word' && NUMBER_WORDS[t.value] !== undefined) { this.next(); return NUMBER_WORDS[t.value]; }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parser

export class Parser {
  constructor() {
    this.errors = [];
    this.statements = [];
    this.sizeNames = null;
    this.maxSizes = 1;
  }

  parse(text) {
    let lines;
    try {
      lines = tokenize(text);
    } catch (e) {
      if (e instanceof PatternError) { this.errors.push(e); return this.result(); }
      throw e;
    }
    for (const toks of lines) {
      const cur = new Cursor(toks);
      try {
        const stmt = this.parseStatement(cur);
        for (const st of Array.isArray(stmt) ? stmt : [stmt]) {
          if (!st) continue;
          st.loc = st.loc || { line: toks[0].line, col: toks[0].col, end: toks[toks.length - 1].end };
          this.statements.push(st);
        }
      } catch (e) {
        if (e instanceof PatternError) this.errors.push(e);
        else throw e;
      }
    }
    return this.result();
  }

  result() {
    return {
      statements: this.statements,
      sizes: { names: this.sizeNames, count: this.sizeNames ? this.sizeNames.length : this.maxSizes },
      errors: this.errors,
    };
  }

  // -- Statements -----------------------------------------------------------

  parseStatement(cur) {
    const first = cur.peek();
    if (first.type !== 'word') throw cur.error('Expected an instruction');
    const w = first.value;

    if (w === 'sizes' || w === 'size') return this.parseSizes(cur);
    if (w === 'gauge' || w === 'tension') return this.parseGauge(cur);
    // A section heading: a few words and a colon, nothing else ("Heel flap:").
    if (this.looksLikeHeading(cur)) return this.parseHeading(cur);
    if ((w === 'graft' || w === 'kitchener') || (w === 'close' && cur.isWord('the', 1))) return this.parseGraft(cur);
    if ((w === 'resume' || w === 'rejoin' || w === 'return') || (w === 'continue' && cur.isWord(['in', 'working'], 1) && (cur.isWord('the', 2) || cur.isWord('in', 2)) && (cur.isWord('round', 3) || cur.isWord('the', 3)))) {
      const r = this.tryResumeRound(cur);
      if (r) return r;
    }
    if (w === 'cast' && cur.isWord('on', 1)) return this.parseCastOn(cur);
    if (w === 'co' && (cur.isNum(1) || cur.isWord(['all'], 1))) return this.parseCastOn(cur);
    if ((w === 'bind' || w === 'cast') && cur.isWord('off', 1)) { cur.next(); cur.next(); return this.parseBindOffStatement(cur); }
    if (w === 'bo') { cur.next(); return this.parseBindOffStatement(cur); }
    if (w === 'join') return this.parseJoin(cur);
    if (w === 'knit' && cur.isWord('in', 1) && cur.isWord('the', 2) && cur.isWord('round', 3)) {
      return { type: 'join', loc: cur.loc(first) };
    }
    if (ROW_WORDS.has(w) || (w === 'next' && ROW_WORDS.has(cur.peek(1).value))) return this.parseRowStatement(cur);
    if (w === 'repeat' || w === 'rep') { cur.next(); return this.parseRepeatRows(cur, null); }
    if (w === 'work') {
      cur.next();
      if (cur.isWord(ROW_WORDS_ARR)) return this.parseRepeatRows(cur, null);
      const flat = this.tryWorkFlat(cur, first);
      if (flat) return flat;
      return this.parsePlainRows(cur, first);
    }
    if ((w === 'knit' || w === 'purl' || w === 'k' || w === 'p') && (cur.isNum(1) || NUMBER_WORDS[cur.peek(1).value] !== undefined) && cur.isWord(['rows', 'row', 'rnds', 'rnd', 'rounds', 'round'], 2)) {
      return this.parsePlainRows(cur, first);
    }
    if (w === 'continue' || w === 'cont') {
      cur.next();
      return this.parsePlainRows(cur, first);
    }
    if (w === 'change' || w === 'with' || w === 'using' || w === 'switch') return this.parseColorChange(cur);
    // Anything else: unrecognised.
    throw new PatternError(`I don't understand this line (it should start with "Row", "Round", "Cast on", "Bind off", "Repeat", etc.)`, cur.loc(first, cur.toks[cur.toks.length - 1]));
  }

  parseSizes(cur) {
    const first = cur.next();
    cur.acceptPunct(':');
    const names = [];
    while (!cur.atEnd()) {
      const t = cur.next();
      if (t.type === 'punct') continue; // commas/parens
      names.push(t.text);
    }
    if (names.length === 0) throw cur.error('Expected a list of size names', first);
    this.sizeNames = names;
    return { type: 'sizes', names, loc: cur.loc(first) };
  }

  parseCastOn(cur) {
    const first = cur.next();
    if (first.value === 'cast') cur.next(); // 'on'
    const count = this.parseCountValue(cur);
    if (count === null) throw cur.error('Expected a number of stitches to cast on');
    cur.skipNoise();
    // Ignore any trailing description ("using the long-tail method").
    const rest = [];
    while (!cur.atEnd()) { const t = cur.next(); if (t.type !== 'punct') rest.push(t.text); }
    return { type: 'castOn', count, note: rest.join(' ') || null, loc: cur.loc(first) };
  }

  parseBindOffStatement(cur) {
    // "Bind off", "Bind off all sts", "BO all sts loosely", "Bind off in pattern".
    const first = cur.peek(-1) || cur.peek();
    let method = null;
    cur.acceptWord(['all', 'rem', 'remaining']);
    cur.skipNoise();
    cur.acceptWord(['loosely', 'firmly']);
    if (cur.isWord('in')) {
      cur.next();
      if (cur.isWord(['pattern', 'patt', 'rib'])) method = cur.next().value;
    }
    // Skip everything else on the line.
    while (!cur.atEnd()) cur.next();
    return { type: 'bindOff', method, loc: cur.loc(first) };
  }

  parseJoin(cur) {
    const first = cur.next();
    // Accept "Join in the round", "Join to work in the round, being careful not to twist", "Join, pm".
    while (!cur.atEnd()) cur.next();
    return { type: 'join', loc: cur.loc(first) };
  }

  parseColorChange(cur) {
    const first = cur.next();
    cur.acceptWord('to');
    cur.acceptWord(['color', 'colour', 'yarn']);
    const t = cur.next();
    if (t.type !== 'word') throw cur.error('Expected a yarn name (e.g. "A" or "MC")', t);
    const yarn = { type: 'yarn', name: t.text.toUpperCase(), loc: cur.loc(first) };
    cur.acceptWord(['yarn', 'color', 'colour']);
    // "With CC, cast on 57 sts": the rest of the line is a statement of its own.
    if (cur.acceptPunct(',') && !cur.atEnd() && cur.peek().type === 'word') {
      const rest = this.parseStatement(cur);
      return [yarn, ...(Array.isArray(rest) ? rest : [rest])];
    }
    while (!cur.atEnd()) cur.next();
    return yarn;
  }

  /** "Gauge: 40 sts and 56 rows = 10 cm" (rows optional; the unit is assumed to be 10 cm / 4 in). */
  parseGauge(cur) {
    const first = cur.next();
    cur.acceptPunct(':');
    let sts = null, rows = null;
    while (!cur.atEnd()) {
      if (cur.isNum()) {
        const n = cur.next().value;
        if (cur.isWord(['sts', 'st', 'stitches'])) { cur.next(); sts = n; continue; }
        if (cur.isWord(['rows', 'rnds', 'rounds'])) { cur.next(); rows = n; continue; }
        continue;
      }
      cur.next();
    }
    if (sts === null) throw cur.error('Expected a stitch count in the gauge (e.g. "22 sts and 30 rows = 10 cm")', first);
    return { type: 'gauge', sts, rows, loc: cur.loc(first) };
  }

  looksLikeHeading(cur) {
    let j = 0;
    while (cur.peek(j).type === 'word' && j < 4) j++;
    return j >= 1 && j <= 4 && cur.isPunct(':', j) && cur.peek(j + 1).type === 'eol' && !ROW_WORDS.has(cur.peek(0).value) && cur.peek(0).value !== 'next';
  }

  parseHeading(cur) {
    const first = cur.peek();
    const words = [];
    while (cur.peek().type === 'word') words.push(cur.next().text);
    cur.acceptPunct(':');
    return { type: 'section', name: words.join(' '), loc: cur.loc(first) };
  }

  /** "Graft the remaining sts together", "Kitchener stitch the toe closed", "Close the toe with kitchener stitch". */
  parseGraft(cur) {
    const first = cur.next();
    let toCastOn = false, flip = false;
    while (!cur.atEnd()) {
      const t = cur.next();
      if (t.type !== 'word') continue;
      if (t.value === 'cast' && (cur.isWord('on') || (cur.isPunct('-') && cur.isWord('on', 1)))) toCastOn = true;
      if (['beginning', 'start', 'first'].includes(t.value)) toCastOn = true;
      if (['twist', 'twisted', 'inside', 'flipped', 'flip', 'reversed', 'mobius', 'möbius', 'moebius'].includes(t.value)) flip = true;
    }
    return { type: 'graft', toCastOn, flip, loc: cur.loc(first) };
  }

  /** "Resume working in the round", "Rejoin in the round", "Continue in the round". */
  tryResumeRound(cur) {
    const first = cur.peek();
    let j = 0, found = false;
    while (cur.peek(j).type !== 'eol' && j < 8) { if (cur.isWord(['round', 'rnd', 'rounds'], j)) found = true; j++; }
    if (!found) return null;
    while (!cur.atEnd()) cur.next();
    return { type: 'resumeRound', loc: cur.loc(first) };
  }

  /** After "work": "the next 28 sts back and forth", "back and forth over the next 28 sts", "flat over the next 28 sts". */
  tryWorkFlat(cur, first) {
    const save = cur.i;
    let count = null, flat = false;
    let guard = 0;
    while (!cur.atEnd() && guard++ < 20) {
      if (cur.isWord('back') && cur.isWord('and', 1) && cur.isWord('forth', 2)) { cur.next(); cur.next(); cur.next(); flat = true; continue; }
      if (cur.isWord('flat')) { cur.next(); flat = true; continue; }
      if (cur.isNum() && count === null) {
        const n = this.parseCountValue(cur);
        if (cur.isWord(['sts', 'st', 'stitches'])) { cur.next(); count = n; continue; }
        continue;
      }
      if (cur.isWord(['in', 'until', 'for']) && !flat) break;
      cur.next();
    }
    if (!flat || count === null) { cur.i = save; return null; }
    while (!cur.atEnd()) cur.next();
    return { type: 'workFlat', count, loc: cur.loc(first) };
  }

  /** Row/round header and body. */
  parseRowStatement(cur) {
    const first = cur.peek();
    let isRound = false;
    let labels = null; // {list:[n...]} or {from, to} or null for "next"
    let andAll = null; // 'ws' | 'rs' | 'even' | 'odd'
    if (cur.acceptWord('next')) {
      const rw = cur.next();
      isRound = ROUND_WORDS.has(rw.value);
    } else {
      const rw = cur.next();
      isRound = ROUND_WORDS.has(rw.value);
      labels = this.parseLabels(cur);
      if (cur.isWord(['and', '&']) || cur.isPunct('&')) {
        // "and all WS rows", "and all following even rows"
        cur.next();
        if (cur.acceptWord(['all', 'every'])) {
          cur.acceptWord(['following', 'foll', 'subsequent', 'other', 'alternate', 'alt']);
          const kind = cur.next();
          if (['ws', 'rs', 'even', 'odd'].includes(kind.value)) andAll = kind.value;
          else if (kind.value === 'wrong' || kind.value === 'right') { andAll = kind.value === 'wrong' ? 'ws' : 'rs'; cur.acceptWord('side'); }
          else throw cur.error('Expected "WS", "RS", "even" or "odd"', kind);
          cur.acceptWord(['rows', 'rnds', 'rounds', 'row']);
          if (cur.isWord(['numbered', 'through', 'to', 'thru'])) { while (!cur.isPunct(':') && !cur.atEnd()) cur.next(); }
        } else {
          throw cur.error('Expected "all" after "and"');
        }
      }
    }
    let side = null;
    if (cur.acceptPunct('(')) {
      const t = cur.next();
      if (t.value === 'rs' || t.value === 'ws') side = t.value;
      else if (t.value === 'right' || t.value === 'wrong') { side = t.value === 'right' ? 'rs' : 'ws'; cur.acceptWord('side'); }
      else throw cur.error('Expected "RS" or "WS"', t);
      cur.expectPunct(')');
    } else if (cur.isWord(['rs', 'ws'])) {
      side = cur.next().value;
    }
    if (!cur.acceptPunct(':')) {
      // Allow "Row 1 k2, p2" without a colon only if what follows looks like instructions.
      if (cur.isPunct('-') || cur.isPunct('.')) cur.next();
      else if (cur.atEnd()) throw cur.error('Expected ":" and the row instructions');
      else throw cur.error('Expected ":" after the row number');
    }
    const stmt = { type: 'row', isRound, labels, andAll, side, loc: cur.loc(first) };

    // Body may be a reference: "as row 2", "rep rows 1-2 3 times", "repeat row 1".
    if (cur.isWord(['as', 'same']) || (cur.isWord(['rep', 'repeat', 'work']) && (cur.isWord(ROW_WORDS_ARR, 1) || cur.isWord(['as', 'the', 'last'], 1)))) {
      if (cur.acceptWord('same')) cur.acceptWord('as');
      else if (cur.acceptWord('as')) { /* as row N */ }
      else { cur.next(); cur.acceptWord('as'); }
      const ref = this.parseRepeatRows(cur, stmt);
      return ref;
    }
    const body = this.parseSequence(cur, 'row');
    stmt.instructions = body.items;
    stmt.expectedCount = body.expectedCount;
    return stmt;
  }

  /** Parse "1", "1-4", "1 and 3", "1, 3, 5", "1 to 4". */
  parseLabels(cur) {
    if (!cur.isNum()) throw cur.error('Expected a row number');
    const first = cur.next().value;
    if (cur.isPunct('-') || cur.isWord(['to', 'through', 'thru'])) {
      cur.next();
      if (!cur.isNum()) throw cur.error('Expected a row number after "-"');
      const last = cur.next().value;
      if (last < first) throw cur.error(`Row range ${first}-${last} is backwards`);
      return { from: first, to: last };
    }
    const list = [first];
    while (cur.isPunct(',') || (cur.isWord(['and', '&']) && cur.isNum(1)) || (cur.isPunct('&') && cur.isNum(1))) {
      cur.next();
      if (!cur.isNum()) { cur.i--; break; }
      list.push(cur.next().value);
    }
    return { list };
  }

  /**
   * "Repeat rows 1-4 3 times", "Rep rnds 1 and 2 until piece measures 10 cm",
   * "Repeat the last 2 rows twice more", "as row 2", "Work rows 1-4 twice".
   * `stmt` is the enclosing row statement when the repeat appears as a row body.
   */
  parseRepeatRows(cur, stmt) {
    const first = cur.peek();
    cur.acceptWord('the');
    let ref;
    if (cur.acceptWord('last')) {
      const n = cur.acceptNumberWord();
      cur.expectWord(ROW_WORDS_ARR, 'rows');
      ref = { last: n === null ? 1 : n };
    } else {
      if (!cur.isWord(ROW_WORDS_ARR)) throw cur.error('Expected "rows" or "rounds"');
      cur.next();
      ref = this.parseLabels(cur);
    }
    const times = this.parseTimes(cur, stmt);
    // Trailing notes, possibly including a stitch count: "(16 sts)", "— 16 sts".
    let expectedCount = null;
    while (!cur.atEnd()) {
      if (cur.isPunct(['(', '[']) && this.looksLikeStitchCount(cur, 1, null)) { cur.next(); expectedCount = this.tryStitchCount(cur); continue; }
      if (this.looksLikeStitchCount(cur, 0, null)) { expectedCount = this.tryStitchCount(cur); continue; }
      cur.next();
    }
    const out = { type: 'repeatRows', ref, times, expectedCount, loc: cur.loc(first) };
    if (stmt) { out.labels = stmt.labels; out.isRound = stmt.isRound; out.loc = stmt.loc; }
    return out;
  }

  /** Repeat count for a repeat-rows statement. */
  parseTimes(cur, stmt) {
    cur.acceptPunct(',');
    cur.acceptWord('for');
    cur.acceptWord('a');
    cur.acceptWord('total');
    cur.acceptWord('of');
    if (cur.acceptWord('until')) {
      cur.acceptWord(['the', 'your']);
      // "until piece measures" (from the cast on) or "until heel flap measures" (from that section).
      let j = 0;
      while (cur.peek(j).type === 'word' && !cur.isWord(['measures', 'is', 'reaches', 'there'], j) && j < 4) j++;
      if (cur.isWord(['measures', 'is', 'reaches'], j) && j >= 1) {
        const words = [];
        for (let k = 0; k < j; k++) words.push(cur.next().value);
        const from = ['piece', 'work', 'it'].includes(words[0]) && words.length === 1 ? null : words.join(' ');
        cur.acceptWord(['measures', 'is', 'reaches']);
        cur.acceptWord(['approximately', 'approx', 'about']);
        const n = this.parseCountValue(cur, true);
        if (n === null) throw cur.error('Expected a length (e.g. "10 cm")');
        const unitTok = cur.next();
        let unit = unitTok.value;
        if (['cm', 'cms', 'centimetres', 'centimeters'].includes(unit)) unit = 'cm';
        else if (['in', 'inch', 'inches', 'ins'].includes(unit)) unit = 'in';
        else if (['mm'].includes(unit)) unit = 'mm';
        else throw cur.error('Expected a unit ("cm" or "inches")', unitTok);
        const endingWith = this.parseEndingWith(cur);
        return { kind: 'measure', length: n, unit, endingWith, from };
      }
      if (cur.acceptWord('there')) {
        cur.acceptWord(['are', 'remain']);
        const n = this.parseCountValue(cur);
        if (n === null) throw cur.error('Expected a stitch count');
        cur.skipNoise();
        return { kind: 'stitches', count: n };
      }
      // "until 40 rows have been worked"
      const n = this.parseCountValue(cur);
      if (n !== null && cur.isWord(ROW_WORDS_ARR)) {
        cur.next();
        return { kind: 'rows', count: n };
      }
      throw cur.error('Expected "until piece measures ..." or "until there are N sts"');
    }
    let n = this.parseCountValue(cur);
    if (n === null) {
      // "once more", "twice", "twice more"
      if (cur.isWord(['once', 'twice', 'thrice'])) n = NUMBER_WORDS[cur.next().value];
    }
    if (n === null) {
      // No count. If the statement has a label range, the count is derived.
      if (stmt && stmt.labels && stmt.labels.from !== undefined) return { kind: 'derived' };
      if (stmt && stmt.labels) return { kind: 'count', count: 1 };
      if (cur.atEnd() || cur.isPunct('.')) return { kind: 'count', count: 1 };
      throw cur.error('Expected a number of times to repeat');
    }
    cur.acceptWord('more');
    cur.acceptWord(['times', 'time']);
    cur.acceptWord('more');
    cur.acceptWord('in');
    cur.acceptWord('total');
    const endingWith = this.parseEndingWith(cur);
    return { kind: 'count', count: n, endingWith };
  }

  parseEndingWith(cur) {
    // Skip descriptive text ("from cast-on edge") up to an "ending with" clause.
    let j = 0;
    while (!cur.isWord('ending', j) && cur.peek(j).type !== 'eol') j++;
    if (cur.peek(j).type === 'eol') return null;
    for (let k = 0; k < j; k++) cur.next();
    if (cur.acceptWord('ending')) {
      cur.acceptWord(['with', 'after', 'on']);
      cur.acceptWord(['a', 'an']);
      const t = cur.next();
      if (t.value === 'ws' || t.value === 'rs') { cur.acceptWord(ROW_WORDS_ARR); return t.value; }
      if (t.value === 'wrong' || t.value === 'right') { cur.acceptWord('side'); cur.acceptWord(ROW_WORDS_ARR); return t.value === 'wrong' ? 'ws' : 'rs'; }
      // "ending with a purl row" / "a knit row": in stockinette-based fabric, purl rows are WS rows.
      if (t.value === 'purl' || t.value === 'p') { cur.acceptWord(ROW_WORDS_ARR); return 'ws'; }
      if (t.value === 'knit' || t.value === 'k') { cur.acceptWord(ROW_WORDS_ARR); return 'rs'; }
      throw cur.error('Expected "RS row" or "WS row"', t);
    }
    return null;
  }

  /** "Knit 4 rows", "Work 6 rows in stockinette", "Work in garter st until piece measures 5 cm". */
  parsePlainRows(cur, first) {
    let stitch = null;
    let count = null;
    if (first.value === 'knit' || first.value === 'k') { stitch = 'knit'; cur.next(); }
    else if (first.value === 'purl' || first.value === 'p') { stitch = 'purl'; cur.next(); }
    if (cur.acceptWord('even')) { stitch = stitch || 'pattern'; }
    const n = this.parseCountValue(cur);
    if (n !== null) {
      count = { kind: 'count', count: n };
      if (!cur.isWord(ROW_WORDS_ARR)) throw cur.error('Expected "rows"');
      cur.next();
      cur.acceptWord(['even', 'straight']);
    }
    if (cur.acceptWord('in')) {
      const words = [];
      while (!cur.atEnd() && !cur.isWord(['until', 'for']) && !cur.isPunct(['.', ','])) words.push(cur.next().value);
      const phrase = words.join(' ');
      if (/garter/.test(phrase)) stitch = 'garter';
      else if (/rev(erse)? (st|stocking|stockinette)/.test(phrase)) stitch = 'reverse stockinette';
      else if (/(st st|stockinette|stocking|stst)/.test(phrase)) stitch = 'stockinette';
      else if (/(patt|pattern|established|rib)/.test(phrase)) stitch = 'pattern';
      else throw cur.error(`I don't know the stitch pattern "${phrase}"`);
    }
    if (count === null) {
      if (cur.acceptWord('for')) {
        const n2 = this.parseCountValue(cur);
        if (n2 === null) throw cur.error('Expected a number of rows');
        cur.expectWord(ROW_WORDS_ARR, 'rows');
        count = { kind: 'count', count: n2 };
      } else if (cur.isWord('until')) {
        count = this.parseTimes(cur, null);
      } else if (cur.atEnd()) {
        throw cur.error('Expected a number of rows, or "until piece measures ..."');
      } else {
        throw cur.error('Expected a number of rows, or "until piece measures ..."');
      }
    }
    if (!stitch) stitch = 'pattern';
    while (!cur.atEnd()) cur.next();
    return { type: 'plainRows', stitch, count, loc: cur.loc(first) };
  }

  // -- Counts ---------------------------------------------------------------

  /**
   * A number, optionally followed by a size list: "12 (14, 16)", "12 [14, 16]", "12/14/16".
   * Returns number | {sizes} | null.
   */
  parseCountValue(cur, allowDecimal = false) {
    const t = cur.peek();
    let first;
    if (t.type === 'num') first = cur.next().value;
    else if (t.type === 'word' && NUMBER_WORDS[t.value] !== undefined && t.value !== 'once' && t.value !== 'twice' && t.value !== 'thrice') first = NUMBER_WORDS[cur.next().value];
    else return null;
    const sizes = [first];
    let sized = false;
    const open = cur.isPunct('(') ? ')' : cur.isPunct('[') ? ']' : null;
    if (open && cur.isNum(1)) {
      // Look ahead: parens containing only numbers and separators.
      let j = 1;
      const vals = [];
      let ok = false;
      while (true) {
        const tk = cur.peek(j);
        if (tk.type === 'num') { vals.push(tk.value); j++; }
        else if (tk.type === 'punct' && (tk.value === ',' || tk.value === '/' || tk.value === '-')) { j++; }
        else if (tk.type === 'punct' && tk.value === open) { ok = vals.length > 0; break; }
        else break;
      }
      if (ok) {
        for (let k = 0; k <= j; k++) cur.next();
        sizes.push(...vals);
        sized = true;
      }
    } else if (cur.isPunct('/') && cur.isNum(1)) {
      while (cur.isPunct('/') && cur.isNum(1)) { cur.next(); sizes.push(cur.next().value); }
      sized = true;
    }
    if (sized) {
      this.maxSizes = Math.max(this.maxSizes, sizes.length);
      return { sizes, loc: cur.loc(t) };
    }
    return first;
  }

  // -- Instruction sequences ---------------------------------------------------

  /**
   * Parse a sequence of instructions until end of line, a closing bracket,
   * or a "rep from *" phrase. `context` is 'row' | 'group' | 'star'.
   */
  parseSequence(cur, context) {
    const items = [];
    let expectedCount = null;
    for (;;) {
      // Separators.
      while (cur.isPunct([',', ';']) || cur.isWord(['then', 'and'])) cur.next();
      if (cur.atEnd()) break;
      if (cur.isPunct('.')) {
        cur.next();
        if (cur.atEnd()) break;
        // Might be a stitch-count note after the period.
        const ec = this.tryStitchCount(cur);
        if (ec !== null) { expectedCount = ec; continue; }
        continue;
      }
      if (cur.isPunct('-')) {
        // "— 20 sts" trailer, or stray dash.
        cur.next();
        const ec = this.tryStitchCount(cur);
        if (ec !== null) { expectedCount = ec; continue; }
        continue;
      }
      if (context !== 'row' && cur.isPunct([')', ']'])) break;
      if (cur.isPunct(['(', '['])) {
        // Either a stitch-count note "(20 sts)" or a group.
        const close = cur.isPunct('(') ? ')' : ']';
        if (context === 'row' && (cur.isNum(1)) && this.looksLikeStitchCount(cur, 1, close)) {
          cur.next();
          expectedCount = this.tryStitchCount(cur);
          cur.expectPunct(close);
          continue;
        }
        items.push(this.parseGroup(cur));
        continue;
      }
      if (cur.isPunct('*')) {
        if (context === 'star') break; // closing "*...*" form
        items.push(this.parseStar(cur));
        continue;
      }
      if (cur.isWord(['rep', 'repeat']) && (cur.isWord('from', 1) || cur.isPunct('*', 1))) {
        if (context === 'star') break;
        throw cur.error('"rep from *" without a matching "*" earlier in the row');
      }
      if (cur.isWord(['rep', 'repeat']) && cur.isWord(ROW_WORDS_ARR, 1)) {
        throw cur.error('A row repeat must be on its own line (e.g. "Repeat rows 1-2 three times")');
      }
      // A bare stitch count at the end: "k2, p2 to end. 20 sts" or "... 20 sts"
      if (context === 'row' && this.looksLikeStitchCount(cur, 0, null)) {
        expectedCount = this.tryStitchCount(cur);
        continue;
      }
      const cable = this.tryCable(cur);
      if (cable) { items.push(cable); continue; }
      const pickup = this.tryPickUp(cur);
      if (pickup) { items.push(pickup); continue; }
      const item = this.parseItem(cur, context);
      if (item) items.push(item);
    }
    return { items, expectedCount };
  }

  /**
   * "pick up and knit 14 (16, 18, 20) sts along the left edge of the heel flap", "pu 14 sts".
   * The edge is whichever one the working yarn is at, so the words after the count are ignored.
   */
  tryPickUp(cur) {
    const first = cur.peek();
    if (cur.isWord('pick') && cur.isWord('up', 1)) { cur.next(); cur.next(); }
    else if (cur.isWord(['pu', 'puk'])) cur.next();
    else return null;
    cur.acceptWord('and');
    cur.acceptWord(['knit', 'k']);
    const n = this.parseCountValue(cur);
    if (n === null) throw cur.error('Expected a number of stitches to pick up');
    cur.skipNoise();
    // Skip "along the left edge of the heel flap" up to the next separator.
    while (!cur.atEnd() && !cur.isPunct([',', ';', '.', ')', ']']) && !cur.isWord(['pm', 'sm', 'k', 'p', 'knit', 'purl'])) cur.next();
    return { type: 'pickup', count: n, loc: cur.loc(first) };
  }

  /**
   * Cable crosses: "c4f", "c6b", "cable 4 front", "2/2 RC", "2/1 LPC", "LT", "RT".
   * Returns {type:'cable', top, under, front, purlUnder} — `top` stitches lie on top
   * of `under` stitches; `front` says whether the held stitches sit in front.
   */
  tryCable(cur) {
    const first = cur.peek();
    const make = (top, under, dir, purlUnder) => {
      // Left cross: hold `top` in front, work `under`, then the held. Right cross: hold `under` in back, work `top`, then held.
      return { type: 'cable', top, under, dir, purlUnder, loc: cur.loc(first) };
    };
    if (first.type === 'num' && cur.isPunct('/', 1) && cur.isNum(2) && cur.peek(3).type === 'word' && /^[lr]p?c$/.test(cur.peek(3).value)) {
      const a = cur.next().value; cur.next(); const b = cur.next().value; const kind = cur.next().value;
      const dir = kind[0] === 'l' ? 'left' : 'right';
      return make(a, b, dir, kind.length === 3);
    }
    if (first.type === 'word') {
      let m = /^c(\d+)([fb])$/.exec(first.value);
      if (m) {
        cur.next();
        const n = parseInt(m[1], 10);
        if (n % 2 !== 0 || n < 2) throw cur.error(`Cable "${first.text}" should cross an even number of stitches`, first);
        return make(n / 2, n / 2, m[2] === 'f' ? 'left' : 'right', false);
      }
      if (first.value === 'cable' && cur.isNum(1) && cur.isWord(['front', 'back', 'f', 'b'], 2)) {
        cur.next(); const n = cur.next().value; const side = cur.next().value;
        if (n % 2 !== 0 || n < 2) throw cur.error(`A cable should cross an even number of stitches`, first);
        return make(n / 2, n / 2, side[0] === 'f' ? 'left' : 'right', false);
      }
      if (first.value === 'lt' || first.value === 'rt') { cur.next(); return make(1, 1, first.value === 'lt' ? 'left' : 'right', false); }
    }
    return null;
  }

  looksLikeStitchCount(cur, offset, close) {
    // number [sizes] ("st"|"sts"|"stitches") ...
    let j = offset;
    if (!cur.isNum(j)) return false;
    j++;
    if (cur.isPunct(['(', '['], j)) {
      const c = cur.isPunct('(', j) ? ')' : ']';
      j++;
      while (cur.isNum(j) || cur.isPunct([',', '/'], j)) j++;
      if (!cur.isPunct(c, j)) return false;
      j++;
    } else {
      while (cur.isPunct('/', j) && cur.isNum(j + 1)) j += 2;
    }
    return cur.isWord(['st', 'sts', 'stitch', 'stitches'], j);
  }

  /** Parse "20 sts", "20 (22, 24) sts remain" and return the count, or null. */
  tryStitchCount(cur) {
    if (!this.looksLikeStitchCount(cur, 0, null)) return null;
    const n = this.parseCountValue(cur);
    cur.next(); // sts
    // Skip trailing words like "remain", "on needle", "total", "in each section".
    while (!cur.atEnd() && !cur.isPunct([')', ']'])) {
      const t = cur.peek();
      if (t.type === 'word' || t.type === 'punct' && (t.value === '.' || t.value === ',')) cur.next();
      else break;
    }
    return n;
  }

  parseGroup(cur) {
    const open = cur.next();
    const close = open.value === '(' ? ')' : ']';
    const body = this.parseSequence(cur, 'group');
    if (!cur.isPunct(close)) throw cur.error(`Expected "${close}" to close the group started at column ${open.col}`);
    cur.next();
    const times = this.parseRepeatTerminator(cur, false);
    if (times === null) {
      if (body.items.length === 0) throw cur.error('Empty group', open);
      throw cur.error(`Expected a repeat count after "${close}", such as "3 times", "twice" or "to end"`);
    }
    return { type: 'group', body: body.items, times, loc: cur.loc(open) };
  }

  parseStar(cur) {
    const star = cur.next();
    const body = this.parseSequence(cur, 'star');
    if (cur.isPunct('*')) {
      // "*k1, p1* to end" form. Optional "rep".
      cur.next();
      cur.acceptPunct(',');
      cur.acceptPunct(';');
      if (cur.acceptWord(['rep', 'repeat'])) { cur.acceptWord('from'); cur.acceptPunct('*'); }
      const times = this.parseRepeatTerminator(cur, true);
      if (times === null) throw cur.error('Expected "to end", "to last N sts" or "N times" after the repeat');
      return { type: 'star', body: body.items, times, loc: cur.loc(star) };
    }
    if (cur.isWord(['rep', 'repeat'])) {
      cur.next();
      cur.expectWord('from', 'from');
      cur.expectPunct('*', '*');
      const times = this.parseRepeatTerminator(cur, true);
      if (times === null) throw cur.error('Expected "to end", "to last N sts" or "N times" after "rep from *"');
      return { type: 'star', body: body.items, times, loc: cur.loc(star) };
    }
    throw cur.error('Expected "rep from *" to close the repeat started with "*"', star);
  }

  /**
   * How many times to repeat a group/star. Returns
   * {kind:'times', count} | {kind:'toEnd', leave} | {kind:'toMarker', before} | null.
   */
  parseRepeatTerminator(cur, isStar) {
    cur.acceptPunct(',');
    let n = this.parseCountValue(cur);
    if (n === null && cur.isWord(['once', 'twice', 'thrice'])) n = NUMBER_WORDS[cur.next().value];
    if (n !== null) {
      cur.acceptWord('more');
      cur.acceptWord(['times', 'time', 'x']);
      cur.acceptWord('more');
      cur.acceptWord('in');
      cur.acceptWord('total');
      return { kind: 'times', count: n };
    }
    if (cur.isWord(['x']) && cur.isNum(1)) { cur.next(); return { kind: 'times', count: cur.next().value }; }
    if (cur.acceptWord(['across', 'around'])) { cur.acceptWord(ROW_WORDS_ARR); return { kind: 'toEnd', leave: 0 }; }
    if (cur.acceptWord(['to', 'until', 'till'])) return this.parseToTarget(cur);
    if (cur.acceptWord('once')) { cur.acceptWord('more'); return { kind: 'times', count: 1 }; }
    return null;
  }

  /** After "to": "end", "end of row", "last N sts", "marker", "N sts before marker/end". */
  parseToTarget(cur) {
    cur.acceptWord('the');
    if (cur.acceptWord('end')) {
      cur.acceptWord('of');
      cur.acceptWord(ROW_WORDS_ARR);
      return { kind: 'toEnd', leave: 0 };
    }
    if (cur.acceptWord('last')) {
      let n = this.parseCountValue(cur);
      if (n === null) n = 1;
      cur.skipNoise();
      return { kind: 'toEnd', leave: n };
    }
    if (cur.acceptWord(['marker', 'm', 'mark'])) return { kind: 'toMarker', before: 0 };
    if (cur.acceptWord('gap')) return { kind: 'toGap', before: 0 };
    if (cur.acceptWord('next')) { cur.acceptWord(['marker', 'm']); return { kind: 'toMarker', before: 0 }; }
    const n = this.parseCountValue(cur);
    if (n !== null) {
      cur.skipNoise();
      cur.acceptWord('before');
      cur.acceptWord('the');
      if (cur.acceptWord(['marker', 'm', 'next'])) { cur.acceptWord(['marker', 'm']); return { kind: 'toMarker', before: n }; }
      if (cur.acceptWord('gap')) return { kind: 'toGap', before: n };
      if (cur.acceptWord('end')) { cur.acceptWord('of'); cur.acceptWord(ROW_WORDS_ARR); return { kind: 'toEnd', leave: n }; }
      throw cur.error('Expected "before marker", "before gap" or "before end"');
    }
    throw cur.error('Expected "end", "last N sts", "marker" or "gap"');
  }

  /** A single instruction: stitch (with count / modifiers / "to end"), marker, etc. */
  parseItem(cur, context) {
    const first = cur.peek();
    if (first.type !== 'word') throw cur.error('Expected a stitch instruction');

    // Multi-word phrases.
    let op = null;
    let mods = [];
    for (const phrase of PHRASES) {
      const words = phrase.slice(0, -1);
      let match = true;
      for (let i = 0; i < words.length; i++) {
        const t = cur.peek(i);
        if (!(t.type === 'word' && t.value === words[i]) && !(t.type === 'num' && String(t.value) === words[i])) { match = false; break; }
      }
      if (match) {
        for (let i = 0; i < words.length; i++) cur.next();
        op = ALIASES[phrase[phrase.length - 1]];
        break;
      }
    }
    let count = null;
    if (op === null) {
      const w = first.value;
      if (ALIASES[w]) {
        op = ALIASES[w];
        mods = (IMPLIED_MODS[w] || []).slice();
        cur.next();
      } else {
        // Split "k5", "p12", "sl1", "co3", "bo4", "kfb2".
        const m = /^([a-z&]+?)(\d+)$/.exec(w);
        if (m && ALIASES[m[1]]) {
          op = ALIASES[m[1]];
          mods = (IMPLIED_MODS[m[1]] || []).slice();
          count = parseInt(m[2], 10);
          cur.next();
          // "k5 (7, 9)" — the size list may follow.
          const sized = this.parseSizeListAfterNumber(cur, count);
          if (sized) count = sized;
        } else if (/^m1[lrp]?$/.test(w)) {
          op = w; cur.next();
        } else if (w === 'k2togtbl' || w === 'p2togtbl') {
          op = w.slice(0, 5); mods = ['tbl']; cur.next();
        } else if (w === 'yo2') {
          op = 'yo'; count = 2; cur.next();
        } else {
          throw new PatternError(`I don't understand the instruction "${first.text}"`, cur.loc(first));
        }
      }
    }

    // Count.
    if (count === null) {
      const n = this.parseCountValue(cur);
      if (n !== null) count = n;
    }
    // Modifiers, possibly interleaved with noise: "sl 1 st purlwise wyib", "k1 tbl".
    for (;;) {
      if (cur.isWord(['st', 'sts', 'stitch', 'stitches'])) { cur.next(); continue; }
      if (cur.peek().type === 'word' && MODIFIERS.has(cur.peek().value)) {
        const m = cur.next().value;
        mods.push(m === 'purlwise' ? 'pwise' : m === 'knitwise' ? 'kwise' : m);
        continue;
      }
      if (cur.isWord('with') && cur.isWord('yarn', 1) && cur.isWord(['in', 'at'], 2) && cur.isWord(['front', 'back'], 3)) {
        cur.next(); cur.next(); cur.next();
        mods.push(cur.next().value === 'front' ? 'wyif' : 'wyib');
        continue;
      }
      if (cur.isWord('through') && cur.isWord(['back', 'the'], 1)) {
        cur.next(); cur.acceptWord('the'); cur.acceptWord('back'); cur.acceptWord('loop'); cur.acceptWord('loops');
        mods.push('tbl');
        continue;
      }
      break;
    }

    // "to end", "to last 3 sts", "to marker", "across".
    if ((op === 'k' || op === 'p' || op === 'sl') && (cur.isWord(['to', 'until', 'till', 'across', 'around']))) {
      if (count !== null) throw cur.error(`Unexpected "to" after a stitch count`);
      let target;
      if (cur.acceptWord(['across', 'around'])) { cur.acceptWord(ROW_WORDS_ARR); target = { kind: 'toEnd', leave: 0 }; }
      else { cur.next(); target = this.parseToTarget(cur); }
      return { type: 'toTarget', op, mods, target, loc: cur.loc(first) };
    }
    if ((op === 'k' || op === 'p') && cur.acceptWord('all')) {
      cur.skipNoise();
      return { type: 'toTarget', op, mods, target: { kind: 'toEnd', leave: 0 }, loc: cur.loc(first) };
    }

    // Bare "knit"/"purl" at top level meaning the whole row.
    if (count === null && (op === 'k' || op === 'p') && context === 'row' && (cur.atEnd() || cur.isPunct('.') || cur.isPunct(['(', '-']) && this.looksLikeStitchCount(cur, cur.isPunct('(') ? 1 : 1, null))) {
      return { type: 'toTarget', op, mods, target: { kind: 'toEnd', leave: 0 }, loc: cur.loc(first) };
    }
    if (count === null && (op === 'k' || op === 'p') && context === 'row' && (cur.isWord(['every', 'all']) )) {
      while (!cur.atEnd() && !cur.isPunct('.')) cur.next();
      return { type: 'toTarget', op, mods, target: { kind: 'toEnd', leave: 0 }, loc: cur.loc(first) };
    }

    // "k2tog 3 times", "yo twice", "kfb twice".
    let times = null;
    if (cur.isWord(['twice', 'thrice'])) times = NUMBER_WORDS[cur.next().value];
    else if ((cur.isNum() || NUMBER_WORDS[cur.peek().value] !== undefined) && cur.isWord(['times', 'time', 'x'], 1)) { times = this.parseCountValue(cur); cur.next(); }
    if (times !== null) {
      if (count === null && (op === 'yo' || OPS[op].consumes !== 1 || OPS[op].produces !== 1)) {
        // Repeat the whole op.
        return { type: 'group', body: [{ type: 'stitch', op, count: null, mods, loc: cur.loc(first) }], times: { kind: 'times', count: times }, loc: cur.loc(first) };
      }
      return { type: 'group', body: [{ type: 'stitch', op, count, mods, loc: cur.loc(first) }], times: { kind: 'times', count: times }, loc: cur.loc(first) };
    }

    if (op === 'psso') return { type: 'stitch', op, count: null, mods, loc: cur.loc(first) };
    if (op === 'turn' || op === 'wt') { cur.acceptWord('the'); cur.acceptWord('work'); }
    if (op === 'bo' && count === null) {
      // "bind off remaining sts" / "bo all"
      if (cur.acceptWord(['all', 'rem', 'remaining'])) { cur.skipNoise(); return { type: 'stitch', op, count: 'all', mods, loc: cur.loc(first) }; }
      if (cur.atEnd() || cur.isPunct('.')) return { type: 'stitch', op, count: 'all', mods, loc: cur.loc(first) };
    }
    return { type: 'stitch', op, count, mods, loc: cur.loc(first) };
  }

  parseSizeListAfterNumber(cur, first) {
    const open = cur.isPunct('(') ? ')' : cur.isPunct('[') ? ']' : null;
    if (open && cur.isNum(1)) {
      let j = 1;
      const vals = [];
      let ok = false;
      for (;;) {
        const tk = cur.peek(j);
        if (tk.type === 'num') { vals.push(tk.value); j++; }
        else if (tk.type === 'punct' && (tk.value === ',' || tk.value === '/')) j++;
        else if (tk.type === 'punct' && tk.value === open) { ok = vals.length > 0; break; }
        else break;
      }
      if (ok) {
        for (let k = 0; k <= j; k++) cur.next();
        const sizes = [first, ...vals];
        this.maxSizes = Math.max(this.maxSizes, sizes.length);
        return { sizes };
      }
    }
    if (cur.isPunct('/') && cur.isNum(1)) {
      const sizes = [first];
      while (cur.isPunct('/') && cur.isNum(1)) { cur.next(); sizes.push(cur.next().value); }
      this.maxSizes = Math.max(this.maxSizes, sizes.length);
      return { sizes };
    }
    return null;
  }
}

const ROW_WORDS_ARR = [...ROW_WORDS];

/** Convenience: parse pattern text. */
export function parsePattern(text) {
  return new Parser().parse(text);
}
