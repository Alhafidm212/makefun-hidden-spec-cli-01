// main.ts is mend, the CLI SPEC.md specifies: it reads a patch in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at
// the first of three matching tiers, and writes every change or none, printing what it
// changed or why it failed. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they
// are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Moves a successful move edit recorded, original path -> current path, for the R lines. */
const movePairs = new Map<string, string>();
function recordMove(oldP: string, newP: string): void {
  let orig = oldP;
  for (const [k, v] of movePairs) {
    if (v === oldP) {
      orig = k;
      break;
    }
  }
  movePairs.delete(orig);
  movePairs.set(orig, newP);
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Lines of a file (SPEC.md section 3) and matching at three tiers (section 5)
// ---------------------------------------------------------------------------

interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(fs: FileState): string {
  if (fs.lines.length === 0) return '';
  return fs.lines.join(fs.br) + (fs.final ? fs.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in lines at one tier, at or after `from`; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const pos: number[] = [];
  const on = o.map((l) => normLine(l, tier));
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier at which O occurs at least once (at or after `from`), with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrences(lines, o, t, from);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

/** A new line at tier 2: the patch's leading whitespace P replaced by the file's F. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/**
 * One old/new line pair, where a line of N that is a context line is written as the
 * file's own matched line, and any other line of N is written as given (re-indented
 * at tier 2). `nCtx` holds, per line of N, its index in O when it is a context line,
 * else -1.
 */
interface LinePair {
  o: string[];
  n: string[];
  nCtx: number[];
}

function buildReplacement(fs: FileState, pos: number, pair: LinePair, tier: number): string[] {
  const f = leadingWs(fs.lines[pos] ?? '');
  const p = pair.o.length > 0 ? leadingWs(pair.o[0]!) : '';
  return pair.n.map((ln, k) => {
    const ci = pair.nCtx[k]!;
    if (ci >= 0) return fs.lines[pos + ci]!;
    return tier === 2 ? reindent(ln, p, f) : ln;
  });
}

function applyPairToFile(tree: Tree, path: string, apply: (fs: FileState) => void): void {
  const cur = tree.get(path);
  if (cur === null) throw new Fail('missing', path);
  const fs = parseFile(cur);
  apply(fs);
  tree.now.set(path, renderFile(fs));
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

type BodyLine = { t: ' ' | '-' | '+' | '\\'; text: string };

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function hunkPair(h: Hunk): LinePair {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  for (const b of h.body) {
    if (b.t === ' ') {
      nCtx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.t === '-') {
      o.push(b.text);
    } else if (b.t === '+') {
      nCtx.push(-1);
      n.push(b.text);
    }
  }
  return { o, n, nCtx };
}

/** True when a `\` line follows the hunk's last context or `+` line (or its last `+` line). */
function backslashAfterLast(h: Hunk, plusOnly: boolean): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i++) {
    const t = h.body[i]!.t;
    if (t === '+' || (!plusOnly && t === ' ')) last = i;
  }
  if (last < 0) return false;
  return h.body[last + 1] !== undefined && h.body[last + 1]!.t === '\\';
}

function applyHunks(fs: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const pair = hunkPair(h);
    if (pair.o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), fs.lines.length);
      const atEnd = pos === fs.lines.length;
      fs.lines.splice(pos, 0, ...pair.n);
      if (atEnd) fs.final = !backslashAfterLast(h, true);
      d += pair.n.length;
      continue;
    }
    const found = findTier(fs.lines, pair.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0]!;
    let best = Math.abs(pos - target);
    for (const q of found.positions) {
      const dist = Math.abs(q - target);
      if (dist < best) {
        best = dist;
        pos = q;
      }
    }
    const atEnd = pos + pair.o.length === fs.lines.length;
    const rep = buildReplacement(fs, pos, pair, found.tier);
    fs.lines.splice(pos, pair.o.length, ...rep);
    if (atEnd) fs.final = !backslashAfterLast(h, false);
    d += pair.n.length - pair.o.length;
  }
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  while (i < lines.length) {
    const l = lines[i]!;
    let diffOld: string | null = null;
    let diffNew: string | null = null;
    let started = false;
    const dm = diffRe.exec(l);
    if (dm !== null) {
      diffOld = dm[1]!;
      diffNew = dm[2]!;
      started = true;
      i += 1;
    } else if (l.startsWith('diff --git ')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      started = true;
    } else {
      i += 1;
      continue;
    }
    // Section header: paths, rename, creation/deletion, then hunks.
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let creation = false;
    let deletion = false;
    const hunks: Hunk[] = [];
    let headerDone = false;
    while (i < lines.length && !headerDone) {
      const h = lines[i]!;
      if (h.startsWith('diff --git ')) {
        headerDone = true;
        break;
      }
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && hunks.length > 0) {
        headerDone = true;
        break;
      }
      if (h.startsWith('@@')) {
        const hm = hunkRe.exec(h);
        if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
        const a = Number(hm[1]);
        i += 1;
        const body: BodyLine[] = [];
        while (i < lines.length) {
          const b = lines[i]!;
          if (b.startsWith('diff --git ')) break;
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '') {
            body.push({ t: ' ', text: '' });
            i += 1;
          } else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
            body.push({ t: b[0] as BodyLine['t'], text: b.slice(1) });
            i += 1;
          } else break;
        }
        while (body.length > 0 && body[body.length - 1]!.t === ' ' && body[body.length - 1]!.text === '') body.pop();
        hunks.push({ a, body });
        continue;
      }
      if (h.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        const raw = h.slice(4).split('\t')[0]!.trim();
        oldPath = raw === '/dev/null' ? null : raw.replace(/^[ab]\//, '');
        const nraw = lines[i + 1]!.slice(4).split('\t')[0]!.trim();
        newPath = nraw === '/dev/null' ? null : nraw.replace(/^[ab]\//, '');
        i += 2;
        continue;
      }
      if (h.startsWith('rename from ')) {
        renameFrom = h.slice(12).trim();
        i += 1;
        continue;
      }
      if (h.startsWith('rename to ')) {
        renameTo = h.slice(10).trim();
        i += 1;
        continue;
      }
      if (h.startsWith('new file mode')) {
        creation = true;
        i += 1;
        continue;
      }
      if (h.startsWith('deleted file mode')) {
        deletion = true;
        i += 1;
        continue;
      }
      i += 1;
    }
    const oldP = oldPath !== null || newPath !== null ? oldPath : (renameFrom ?? diffOld);
    const newP = oldPath !== null || newPath !== null ? newPath : (renameTo ?? diffNew);
    sections.push({ oldPath: oldP, newPath: newP, creation: creation || oldP === null, deletion: deletion || newP === null, hunks });
    void started;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (sec.creation && newP !== null) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.t === '+') plus.push(b.text);
      let final = true;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        const h = sec.hunks[k]!;
        if (h.body.some((b) => b.t === '+')) {
          final = !backslashAfterLast(h, true);
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (sec.deletion && oldP !== null) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null && newP === null) return;
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const fs = parseFile(cur);
      applyHunks(fs, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, renderFile(fs));
      recordMove(oldP, newP);
      return;
    }
    const p = (oldP ?? newP)!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    applyPairToFile(tree, p, (fs) => applyHunks(fs, sec.hunks, strict, p));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const fs = parseFile(cur);
    const found = findTier(fs.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const pair: LinePair = { o: oldLines, n: newLines, nCtx: newLines.map(() => -1) };
    const rep = buildReplacement(fs, pos, pair, found.tier);
    fs.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, renderFile(fs));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function chunkPair(c: V4aChunk): LinePair {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  for (const b of c.body) {
    if (b.t === ' ') {
      nCtx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.t === '-') {
      o.push(b.text);
    } else if (b.t === '+') {
      nCtx.push(-1);
      n.push(b.text);
    }
  }
  return { o, n, nCtx };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const path = l.slice(l.indexOf(': ') + 2).trim();
    const sectionLine = i;
    i += 1;
    const raw: string[] = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      raw.push(lines[i]!);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const r = raw[k]!;
        if (r === '') fileLines.push('');
        else if (r.startsWith('+')) fileLines.push(r.slice(1));
        else throw new Exit2(`error: parse ${sectionLine + 2 + k}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${sectionLine + 2}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    // Update: optional Move to first, then chunks.
    let moveTo: string | null = null;
    let at = 0;
    if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
      moveTo = raw[0]!.slice('*** Move to: '.length).trim();
      at = 1;
    }
    const chunks: V4aChunk[] = [];
    let cur: V4aChunk | null = null;
    for (let k = at; k < raw.length; k++) {
      const r = raw[k]!;
      const lineNo = sectionLine + 2 + k;
      if (r.startsWith('@@')) {
        if (cur !== null) chunks.push(cur);
        cur = { anchor: r.slice(2).trim(), eof: false, body: [] };
      } else if (r === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
        cur.eof = true;
        chunks.push(cur);
        cur = null;
      } else if (r === '' || r[0] === ' ' || r[0] === '-' || r[0] === '+') {
        if (cur === null) cur = { anchor: null, eof: false, body: [] };
        cur.body.push(r === '' ? { t: ' ', text: '' } : { t: r[0] as BodyLine['t'], text: r.slice(1) });
      } else {
        throw new Exit2(`error: parse ${lineNo}`);
      }
    }
    if (cur !== null) chunks.push(cur);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const fs = parseFile(cur);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null && c.anchor !== '') {
        let idx = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const want = normLine(c.anchor, t);
          for (let k = cursor; k < fs.lines.length; k++) {
            if (normLine(fs.lines[k]!, t) === want) {
              idx = k;
              break;
            }
          }
          if (idx >= 0) break;
        }
        if (idx < 0) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      const pair = chunkPair(c);
      if (pair.o.length === 0) {
        const pos = c.eof ? fs.lines.length : cursor;
        fs.lines.splice(pos, 0, ...pair.n);
        cursor = pos + pair.n.length;
        continue;
      }
      let found: { tier: number; positions: number[] } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        let p = occurrences(fs.lines, pair.o, t, cursor);
        if (c.eof) p = p.filter((q) => q + pair.o.length === fs.lines.length);
        if (p.length > 0) {
          found = { tier: t, positions: p };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      const rep = buildReplacement(fs, pos, pair, found.tier);
      fs.lines.splice(pos, pair.o.length, ...rep);
      cursor = pos + rep.length;
    }
    const text = renderFile(fs);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      recordMove(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Command line, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  movePairs.clear();
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of movePairs) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    const dels: string[] = [];
    const writes: [string, string][] = [];
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (now === null) dels.push(p);
      else if (tree.original(p) !== now) writes.push([p, now]);
    }
    for (const p of dels.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) rmSync(p, { force: true });
    for (const [p, content] of writes.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])))) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
