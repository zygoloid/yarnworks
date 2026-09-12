// Tokenizer for knitting pattern text.
//
// Produces a flat list of tokens per line. Words are lower-cased; the
// original text is preserved for error messages.

export class PatternError extends Error {
  constructor(message, loc) {
    super(message);
    this.name = 'PatternError';
    this.loc = loc || null;
  }
}

/** @typedef {{type: 'num'|'word'|'punct'|'eol', value: string|number, text: string, line: number, col: number, end: number}} Token */

const PUNCT = new Set(['(', ')', '[', ']', '*', ',', ';', ':', '.', '-', '–', '—', '/', '&', '+', '=']);

/**
 * Tokenize a line of pattern text.
 * @param {string} text
 * @param {number} line 1-based line number
 * @returns {Token[]}
 */
export function tokenizeLine(text, line) {
  const tokens = [];
  let i = 0;
  // Strip comments.
  const hash = text.indexOf('#');
  const slashes = text.indexOf('//');
  let end = text.length;
  if (hash >= 0) end = Math.min(end, hash);
  if (slashes >= 0) end = Math.min(end, slashes);
  while (i < end) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    const start = i;
    if (/[0-9]/.test(ch)) {
      while (i < end && /[0-9]/.test(text[i])) i++;
      // Allow decimals like 10.5 (for measurements).
      if (text[i] === '.' && /[0-9]/.test(text[i + 1] || '')) {
        i++;
        while (i < end && /[0-9]/.test(text[i])) i++;
      }
      const raw = text.slice(start, i);
      tokens.push({ type: 'num', value: parseFloat(raw), text: raw, line, col: start + 1, end: i + 1 });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      // Words may contain digits and '&' (w&t) and apostrophes.
      while (i < end && /[A-Za-z0-9_&']/.test(text[i])) i++;
      const raw = text.slice(start, i);
      tokens.push({ type: 'word', value: raw.toLowerCase(), text: raw, line, col: start + 1, end: i + 1 });
      continue;
    }
    if (PUNCT.has(ch)) {
      let value = ch;
      if (ch === '–' || ch === '—') value = '-';
      tokens.push({ type: 'punct', value, text: ch, line, col: start + 1, end: i + 2 });
      i++;
      continue;
    }
    if (ch === '"' || ch === '“' || ch === '”' || ch === '″') {
      tokens.push({ type: 'word', value: 'inches', text: ch, line, col: start + 1, end: i + 2 });
      i++;
      continue;
    }
    throw new PatternError(`Unexpected character "${ch}"`, { line, col: start + 1, end: start + 2 });
  }
  tokens.push({ type: 'eol', value: '', text: '', line, col: end + 1, end: end + 1 });
  return tokens;
}

/**
 * Tokenize a whole pattern. Returns an array of lines, each an array of tokens.
 * Lines that contain only whitespace/comments are omitted (but line numbers are preserved).
 */
export function tokenize(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const toks = tokenizeLine(lines[i], i + 1);
    if (toks.length > 1) out.push(toks);
  }
  return out;
}
