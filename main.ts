// mend: one patch tool for every AI edit format.
//
// `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`
// Applies an AI-written edit in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to the tree of
// text files in the working directory, exactly as SPEC.md says.
// Node 22, standard library only. No network, no model calls.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below):
// keep that hand-over and runner.ts as they are.

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

// ---- Section 3: files, lines and paths ----

interface FileModel {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// ---- Section 5: matching lines ----

// Normalise one line at a tier: 0 exact, 1 trailing spaces/tabs removed,
// 2 leading and trailing spaces/tabs removed.
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (norm(lines[i + j]!, tier) !== norm(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  positions: number[];
}

// First tier at which O occurs at least once, at or after `from`.
function findTier(lines: string[], o: string[], from: number, strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAt(lines, o, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

// First line at or after `from` equal to a single-line anchor, at the
// first tier where one is.
function findSingleLine(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (norm(lines[i]!, t) === norm(anchor, t)) return i;
    }
  }
  return null;
}

interface NLine {
  text: string;
  // Index into O for a context line, -1 for an added line.
  ctx: number;
}

// Replace the k matched lines at `pos` by N, per section 5: a context
// line is written as the file's own matched line; at tier 2 every other
// line of N is re-indented from O's first line's leading whitespace to
// the file's first matched line's.
function applyReplacement(lines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const matched = lines.slice(pos, pos + o.length);
  const out: string[] = [];
  if (o.length > 0) {
    const f = leadingWs(matched[0]!);
    const p = leadingWs(o[0]!);
    for (const nl of n) {
      if (nl.ctx >= 0) {
        out.push(matched[nl.ctx]!);
        continue;
      }
      if (tier === 2) {
        const t = nl.text;
        if (t !== '' && /[^ \t]/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
        else out.push(t);
      } else {
        out.push(nl.text);
      }
    }
  } else {
    for (const nl of n) out.push(nl.text);
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

// Build O and N from body lines: ' ' or '' is context, '-' is old,
// '+' is new.
function buildON(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const t = l === '' ? '' : l.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: -1 });
    }
  }
  return { o, n };
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
interface MovePair {
  old: string;
  new: string;
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

// ---- Section 9: JSON edits ----

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

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  body: string[];
  hasCtxOrPlus: boolean;
  backslashAfterLastCtxOrPlus: boolean;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  hasHeaderPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function parseDiffGit(line: string, idx: number): { old: string; next: string } {
  const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return { old: m[1]!, next: m[2]! };
}

function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Parse one hunk at lines[idx] (a line starting with @@). Returns the
// hunk and the index of the first line after its body.
function parseHunk(lines: string[], idx: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[idx]!);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  const a = parseInt(m[1]!, 10);
  const body: string[] = [];
  let j = idx + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (isDiffGitLine(l)) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const { o, n } = buildON(body.filter((l) => !l.startsWith('\\')));
  let hasCtxOrPlus = false;
  let backslashAfterLastCtxOrPlus = false;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith(' ') || l === '' || l.startsWith('+')) {
      hasCtxOrPlus = true;
      backslashAfterLastCtxOrPlus = k + 1 < body.length && body[k + 1]!.startsWith('\\');
    }
  }
  return { hunk: { a, o, n, body, hasCtxOrPlus, backslashAfterLastCtxOrPlus }, next: j };
}

// Apply one hunk to a file model. `d` is the net line delta of this
// section's hunks applied so far. Throws Fail('no-match', path).
function applyHunk(model: FileModel, hunk: Hunk, d: number, strict: boolean, path: string): FileModel {
  if (hunk.o.length === 0) {
    const at = Math.max(0, Math.min(hunk.a + d, model.lines.length));
    const inserted = hunk.n.map((nl) => nl.text);
    const lines = [...model.lines.slice(0, at), ...inserted, ...model.lines.slice(at)];
    const touchesEnd = at === model.lines.length;
    const finalBreak = touchesEnd ? (hunk.hasCtxOrPlus ? !hunk.backslashAfterLastCtxOrPlus : true) : model.finalBreak;
    return { lines, br: model.br, finalBreak };
  }
  const found = findTier(model.lines, hunk.o, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = found.positions[0]!;
  let best = Math.abs(pos - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      pos = p;
    }
  }
  const newLines = applyReplacement(model.lines, pos, hunk.o, hunk.n, found.tier);
  const touchesEnd = pos + hunk.o.length === model.lines.length;
  const finalBreak = touchesEnd ? (hunk.hasCtxOrPlus ? !hunk.backslashAfterLastCtxOrPlus : true) : model.finalBreak;
  return { lines: newLines, br: model.br, finalBreak };
}

function resolveSectionPaths(s: Section): { oldPath: string | null; newPath: string | null } {
  const oldPath = s.hasHeaderPair ? s.oldPath : s.renameFrom !== null ? s.renameFrom : s.gitOld;
  const newPath = s.hasHeaderPair ? s.newPath : s.renameTo !== null ? s.renameTo : s.gitNew;
  return { oldPath, newPath };
}

function makeUnifiedEdit(sec: Section, strict: boolean, moves: MovePair[]): Edit {
  const { oldPath, newPath } = resolveSectionPaths(sec);
  let kind: string;
  if (oldPath === null && newPath === null) kind = 'noop';
  else if (oldPath === null || sec.newFile) kind = 'create';
  else if (newPath === null || sec.deleted) kind = 'delete';
  else if (oldPath !== newPath) kind = 'move';
  else kind = 'change';
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (kind === 'noop') return;
    if (kind === 'create') {
      const np = newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let hasPlus = false;
      let backslashAfterLastPlus = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.startsWith('+')) {
            plus.push(h.body[k]!.slice(1));
            hasPlus = true;
            backslashAfterLastPlus = k + 1 < h.body.length && h.body[k + 1]!.startsWith('\\');
          }
        }
      }
      tree.now.set(np, !hasPlus ? '' : plus.join('\n') + (backslashAfterLastPlus ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (kind === 'move' && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    let model = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      model = applyHunk(model, h, d, strict, op);
      d += h.n.length - h.o.length;
    }
    const out = serializeFile(model);
    if (kind === 'move') {
      tree.now.set(newPath!, out);
      tree.now.set(op, null);
      moves.push({ old: op, new: newPath! });
    } else {
      tree.now.set(op, out);
    }
  };
}

function parseUnified(lines: string[], strict: boolean, moves: MovePair[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (gitOld: string | null, gitNew: string | null): Section => {
    const s: Section = {
      gitOld,
      gitNew,
      oldPath: null,
      newPath: null,
      hasHeaderPair: false,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      deleted: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (isDiffGitLine(line)) {
      const g = parseDiffGit(line, i);
      cur = newSection(g.old, g.next);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.hasHeaderPair = true;
        i += 2;
        continue;
      }
      cur = newSection(null, null);
      inHeader = true;
      cur.oldPath = headerPath(line);
      cur.newPath = headerPath(lines[i + 1]!);
      cur.hasHeaderPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const r = parseHunk(lines, i);
      cur.hunks.push(r.hunk);
      inHeader = false;
      i = r.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deleted = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => makeUnifiedEdit(s, strict, moves));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findTier(model.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length !== 1) throw new Fail('ambiguous', path);
    const nLines: NLine[] = newLines.map((t) => ({ text: t, ctx: -1 }));
    const newModelLines = applyReplacement(model.lines, found.positions[0]!, oldLines, nLines, found.tier);
    tree.now.set(path, serializeFile({ lines: newModelLines, br: model.br, finalBreak: model.finalBreak }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eqIdx = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eqIdx === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let repIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (repIdx === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(makeSREdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = repIdx;
    i = repIdx + 1;
  }
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
  // True when the chunk was started by an @@ line (it counts as a chunk
  // even with an empty body); false when it started at a body line.
  explicit: boolean;
}

function makeAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function makeUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: MovePair[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let model = parseFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const at = findSingleLine(model.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = buildON(chunk.body);
      if (o.length === 0) {
        const inserted = n.map((nl) => nl.text);
        if (chunk.eof) {
          model = { lines: [...model.lines, ...inserted], br: model.br, finalBreak: model.finalBreak };
          cursor = model.lines.length;
        } else {
          model = {
            lines: [...model.lines.slice(0, cursor), ...inserted, ...model.lines.slice(cursor)],
            br: model.br,
            finalBreak: model.finalBreak,
          };
          cursor = cursor + inserted.length;
        }
        continue;
      }
      const found = findTier(model.lines, o, cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      let pos: number | undefined;
      if (chunk.eof) {
        pos = found.positions.find((p) => p + o.length === model.lines.length);
        if (pos === undefined) throw new Fail('no-match', path);
      } else {
        pos = found.positions[0]!;
      }
      const newLines = applyReplacement(model.lines, pos, o, n, found.tier);
      model = { lines: newLines, br: model.br, finalBreak: model.finalBreak };
      cursor = pos + n.length;
    }
    const out = serializeFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function parseV4a(lines: string[], strict: boolean, moves: MovePair[]): Edit[] {
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
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  while (i < end) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const rawLines: string[] = [];
      while (i < end) {
        const l = lines[i]!;
        if (isV4aSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('+')) {
          rawLines.push(l.slice(1));
          i++;
          continue;
        }
        if (blank(l)) {
          rawLines.push('');
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
      edits.push(makeAddEdit(path, rawLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      edits.push(makeDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLine = i + 1;
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let endedByEof = false;
      while (i < end) {
        const l = lines[i]!;
        if (isV4aSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          endedByEof = true;
          curChunk = null;
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false, explicit: true };
          chunks.push(curChunk);
          endedByEof = false;
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (endedByEof) throw new Exit2(`error: parse ${i + 1}`);
            curChunk = { anchor: null, body: [], eof: false, explicit: false };
            chunks.push(curChunk);
          }
          curChunk.body.push(l);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
        if (lastChunk.body.length === 0 && lastChunk.anchor === null && !lastChunk.eof && !lastChunk.explicit) chunks.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeUpdateEdit(path, moveTo, chunks, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---- Sections 1, 2 and 10: invocation, output and atomicity ----

function run(args: string[]): { code: number; out: string[] } {
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
  const moves: MovePair[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict, moves);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict, moves);
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
  const origMap = new Map<string, string | null>();
  for (const p of tree.now.keys()) origMap.set(p, tree.original(p));
  const rows: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  const seenMoves = new Set<string>();
  for (const m of moves) {
    const tag = `${m.old}\0${m.new}`;
    if (seenMoves.has(tag)) continue;
    seenMoves.add(tag);
    const wasOld = origMap.has(m.old) ? origMap.get(m.old)! : tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = origMap.has(m.new) ? origMap.get(m.new)! : tree.original(m.new);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      suppressed.add(m.old);
      suppressed.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (suppressed.has(p)) continue;
    const was = origMap.get(p)!;
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = origMap.get(p)!;
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
