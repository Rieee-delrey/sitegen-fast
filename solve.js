// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the output
// tree makefun-site's build returns, for every input. Written from the README and
// the reference code, with the same rules and the same answers, but with the slow
// parts rebuilt: templates compile once per case into plain JavaScript functions
// (static paths resolved at compile time, includes inlined), the Markdown lexer
// scans lines once without a token array, the inline renderer jumps between
// marks with indexOf instead of walking every character, slugify results are
// cached per case with a fast path for plain ASCII, and word counts are taken
// while the lines are already in hand. Nothing is cached from one case to the
// next: every cache and every compiled template is made fresh inside run().

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped, and nothing else. A test first: most
 * strings hold nothing to escape, and a test is one native scan. */
function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

const MARK_RE = /\p{M}/gu;

/** The slug of `text`, uncached. Pure ASCII skips the NFKD step and the mark
 * strip: ASCII has no compatibility decomposition and no combining marks. */
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out = `${slug}-2`;
  while (taken.has(out)) { n++; out = `${slug}-${n}`; }
  taken.add(out);
  return out;
}

/** Whether code unit `code` is whitespace in JavaScript's \s sense. */
function isWS(code) {
  return code <= 32 || code === 0x00a0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** The words of `line`: its runs of characters other than whitespace. */
function countWords(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    if (isWS(line.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return { error: DATE_ERR };
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) return { error: DATE_ERR };
      }
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: DATE_ERR };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. The front matter is the lines
 * between the opening "---" line and the next line that is exactly "---".
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeStart = -1;
  let bodyStart = -1;
  const p = text.indexOf('\n---\n', 3);
  if (p !== -1) { closeStart = p; bodyStart = p + 5; }
  else if (text.endsWith('\n---')) { closeStart = text.length - 4; bodyStart = text.length; }
  else return { error: 'the front matter is not closed' };
  const data = {};
  const fmText = text.slice(4, closeStart);
  if (fmText !== '') {
    const lines = fmText.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      if (line === '') continue;
      const c0 = line.charCodeAt(0);
      if (c0 === 35) continue;
      if ((c0 === 32 || c0 === 9) && isBlank(line)) continue;
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${j + 2} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${j + 2} is not "key: value"` };
      raw = raw.replace(/[ \t]+$/, '');
      if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index at or after `from` where `s` holds one of \ ` * [, or -1.
 * One native regex scan beats four indexOf calls; lastIndex is set on every
 * call, so the shared regex stays correct across the recursion in inline. */
const SPEC_RE = /[\\`*\[]/g;
function nextSpecial(s, from) {
  SPEC_RE.lastIndex = from;
  const m = SPEC_RE.exec(s);
  return m === null ? -1 : m.index;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** Whether `target` holds any whitespace character. */
function hasWS(target) {
  for (let i = 0; i < target.length; i++) if (isWS(target.charCodeAt(i))) return true;
  return false;
}

/** `s` rendered inline; `link(target)` is a link's href. Plain runs between the
 * marks are escaped in one replace each, and the scan jumps from mark to mark
 * with one native regex scan. One escape test covers the whole string: when
 * it holds nothing to escape, the runs go out raw with no test each. */
function inline(s, link) {
  const needsEsc = ESC_TEST.test(s);
  const esc = (t) => (needsEsc ? escapeHtml(t) : t);
  const out = [];
  const n = s.length;
  let start = 0;
  let pos = 0;
  while (pos < n) {
    const j = nextSpecial(s, pos);
    if (j === -1) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 >= n || !ESCAPABLE.has(s[j + 1])) { pos = j + 1; continue; }
      if (j > start) out.push(esc(s.slice(start, j)));
      const nx = s[j + 1];
      out.push(nx === '>' ? '&gt;' : nx);
      pos = j + 2;
      start = pos;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > start) out.push(esc(s.slice(start, j)));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        pos = k + 1;
        start = pos;
      } else pos = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > start) out.push(esc(s.slice(start, j)));
          out.push('<strong>', inline(s.slice(j + 2, k), link), '</strong>');
          pos = k + 2;
          start = pos;
        } else pos = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > start) out.push(esc(s.slice(start, j)));
        out.push('<em>', inline(s.slice(j + 1, k), link), '</em>');
        pos = k + 1;
        start = pos;
      } else pos = j + 1;
      continue;
    }
    const k = findUnescaped(s, ']', j + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWS(target)) {
      if (j > start) out.push(esc(s.slice(start, j)));
      const href = link(target);
      out.push('<a href="', escapeHtml(href), '">', inline(s.slice(j + 1, k), link), '</a>');
      pos = m + 1;
      start = pos;
    } else pos = j + 1;
  }
  if (start < n) out.push(esc(s.slice(start)));
  return out.join('');
}

/** The language of a fence-open line, or null when the line is not one. */
function fenceOpen(line) {
  if (!line.startsWith('```')) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  for (let k = j; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, j);
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  if (j === 0 || j > 6 || j >= line.length) return null;
  const c = line.charCodeAt(j);
  if (c !== 32 && c !== 9) return null;
  let a = j;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: j, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break.
 * A line opening on a letter never does. */
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) return false;
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (line.startsWith('```')) return fenceOpen(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  return isHR(line);
}

/** An ordered-list marker: its start number and the item's text, or null. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && j < 9) {
    const c = line.charCodeAt(j);
    if (c < 48 || c > 57) break;
    j++;
  }
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { start: Number(line.slice(0, j)), rest: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j >= line.length) return false;
  return !isWS(line.charCodeAt(j));
}

/** A blockquote line with its `>` and one space after it dropped, then trimmed. */
function stripQuote(line) {
  let s = line.slice(1);
  if (s.charCodeAt(0) === 32) s = s.slice(1);
  return trimLine(s);
}

/**
 * `src` rendered in one pass over its lines, with no token array: its HTML,
 * its table of contents, its excerpt, and its word count. `link(target)` is a
 * link's href, `slugify` the case's cached slug function. The word count is
 * one scan of the whole body up front: words never span a newline, so it
 * equals the sum over the lines, with one call instead of one per line.
 */
function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = '';
  let hasExcerpt = false;
  const words = countWords(src);
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') { i++; continue; }
    const c0 = line.charCodeAt(0);
    if ((c0 === 32 || c0 === 9) && isBlank(line)) { i++; continue; }
    // A line opening on a letter can be nothing but a paragraph: not blank,
    // a fence, a heading, a break, a quote or a list.
    const isLetter = (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122);
    const lang = !isLetter && line.startsWith('```') ? fenceOpen(line) : null;
    if (lang !== null) {
      i++;
      const bodyLines = [];
      while (i < n) {
        const l = lines[i];
        if (isFenceClose(l)) { i++; break; }
        bodyLines.push(l);
        i++;
      }
      // Escaping is per character, so the whole body escapes in one call.
      out.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${bodyLines.length === 0 ? '' : `${escapeHtml(bodyLines.join('\n'))}\n`}</code></pre>\n`);
      continue;
    }
    if (!isLetter) {
      if (c0 === 35) {
        const h = headingOf(line);
        if (h !== null) {
          const id = uniqueSlug(slugify(h.text), ids);
          const html = inline(h.text, link);
          out.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
          if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
          i++;
          continue;
        }
      }
      if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
      if (c0 === 62) {
        const qlines = [];
        const first = stripQuote(line);
        if (first !== '') qlines.push(first);
        i++;
        while (i < n && lines[i].charCodeAt(0) === 62) {
          const l = lines[i];
            const q = stripQuote(l);
          if (q !== '') qlines.push(q);
          i++;
        }
        out.push(qlines.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(qlines.join('\n'), link)}</p>\n</blockquote>\n`);
        continue;
      }
      let isOrdered = false;
      let start = 1;
      let rest = null;
      if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) rest = line.slice(2);
      else {
        const om = orderedOf(line);
        if (om !== null) { isOrdered = true; start = om.start; rest = om.rest; }
      }
      if (rest !== null) {
        const items = [[trimLine(rest)]];
        i++;
        while (i < n) {
          const l = lines[i];
          let m = null;
          if (!isOrdered) {
            if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) m = l.slice(2);
          } else {
            const om = orderedOf(l);
            if (om !== null) m = om.rest;
          }
          if (m !== null) {
                items.push([trimLine(m)]);
            i++;
            continue;
          }
          if (isContinued(l)) {
                items[items.length - 1].push(trimLine(l));
            i++;
            continue;
          }
          break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
        let itemsHtml = '';
        for (const parts of items) itemsHtml += `<li>${inline(parts.join('\n'), link)}</li>\n`;
        out.push(`${open}\n${itemsHtml}</${tag}>\n`);
        continue;
      }
    }
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      const l = lines[i];
      parts.push(trimLine(l));
      i++;
    }
    const html = inline(parts.join('\n'), link);
    if (!hasExcerpt) { excerpt = html; hasExcerpt = true; }
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt, words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template compilation: each template becomes one JavaScript function that
// appends to an output array. Paths are resolved at compile time against the
// shapes of the values templates can see; includes are inlined (to depth 8)
// so an included template shares the caller's loop bindings as plain locals.

/** A value as text: a string itself, a number in JavaScript's digits, true or
 * false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** An own property of an object value, or undefined (the guarded read a path
 * takes once its shape is no longer known at compile time). */
function getOwn(v, key) {
  if (v === null || typeof v !== 'object') return undefined;
  return Object.hasOwn(v, key) ? v[key] : undefined;
}

/** A number as text, or "" when there is none. */
function numText(v) {
  return v === undefined || v === null ? '' : String(v);
}

/** A boolean as text, or "" when there is none. */
function boolText(v) {
  return v === true ? 'true' : v === false ? 'false' : '';
}

const STR = { k: 'str' };
const NUM = { k: 'num' };
const BOOL = { k: 'bool' };
const ANY = { k: 'any' };
const UNDEF = { k: 'undef' };
const LOOP_SHAPE = { k: 'obj', keys: { index: NUM, first: BOOL, last: BOOL, length: NUM } };
const TAG_LITE = { k: 'obj', keys: { name: STR, slug: STR, url: STR } };
const TAG_FULL = { k: 'obj', keys: { name: STR, slug: STR, url: STR, count: NUM } };
const LINK_KEYS = { title: STR, url: STR, date: STR, date_long: STR };
const CARD_SHAPE = { k: 'obj', keys: { title: STR, url: STR, date: STR, date_long: STR, summary: STR, excerpt: STR, reading_minutes: NUM, tags: { k: 'arr', el: TAG_LITE } } };
const PAGE_SHAPE = {
  k: 'obj',
  keys: {
    ...CARD_SHAPE.keys,
    slug: STR,
    content: STR,
    toc: { k: 'arr', el: { k: 'obj', keys: { level: NUM, id: STR, html: STR } } },
    newer: { k: 'obj', keys: LINK_KEYS, nullable: true },
    older: { k: 'obj', keys: LINK_KEYS, nullable: true },
    is_post: BOOL,
  },
};
const ROOT_SHAPES = {
  site: { k: 'obj', keys: { title: STR, base_url: STR } },
  tags: { k: 'arr', el: TAG_FULL },
  recent: { k: 'arr', el: CARD_SHAPE },
  page: PAGE_SHAPE,
  posts: { k: 'arr', el: CARD_SHAPE },
  pager: { k: 'obj', keys: { number: NUM, total: NUM, url: STR, newer_url: STR, older_url: STR } },
  tag: { k: 'obj', keys: { name: STR, slug: STR, url: STR, count: NUM, posts: { k: 'arr', el: CARD_SHAPE } } },
};

/** The JavaScript expression for `parts` in the bindings `bound` (loop names to
 * shapes), with its shape and whether it may be null or undefined. A path the
 * shapes rule out is the constant undefined, exactly as a failed lookup is. */
function resolveTemplatePath(parts, bound) {
  const first = parts[0];
  let expr;
  let shape;
  let nullable;
  if (bound.has(first)) {
    expr = `L_${first}`;
    shape = bound.get(first).shape;
    nullable = false;
  } else if (Object.hasOwn(ROOT_SHAPES, first)) {
    expr = `V.${first}`;
    shape = ROOT_SHAPES[first];
    nullable = true;
  } else {
    return { expr: 'undefined', shape: UNDEF, nullable: true };
  }
  for (let k = 1; k < parts.length; k++) {
    const key = parts[k];
    if (shape.k === 'obj') {
      const ks = shape.keys[key];
      if (ks === undefined) return { expr: 'undefined', shape: UNDEF, nullable: true };
      // Nullability is sticky: once an ancestor may be missing, the result
      // may be undefined whatever this key holds.
      const wasNull = nullable;
      expr = wasNull ? `${expr}?.${key}` : `${expr}.${key}`;
      shape = ks;
      nullable = wasNull || !!ks.nullable;
    } else if (shape.k === 'arr') {
      if (key === 'length') {
        const wasNull = nullable;
        expr = wasNull ? `${expr}?.length` : `${expr}.length`;
        shape = NUM;
        nullable = wasNull;
      } else if (/^\d+$/.test(key)) {
        expr = nullable ? `${expr}?.[${key}]` : `${expr}[${key}]`;
        shape = shape.el;
        nullable = true;
      } else return { expr: 'undefined', shape: UNDEF, nullable: true };
    } else if (shape.k === 'any') {
      expr = `G(${expr},${JSON.stringify(key)})`;
      shape = ANY;
      nullable = true;
    } else {
      return { expr: 'undefined', shape: UNDEF, nullable: true };
    }
  }
  return { expr, shape, nullable };
}

/** Whether `nodes` (or a template they include, to depth 8) read `loop`: when
 * they do not, a for loop can skip building its loop object. A cycle is read
 * as a use, which only costs an object, never an answer. */
function subtreeUsesLoop(nodes, templates, depth, visiting) {
  for (const node of nodes) {
    if (node.kind === 'var' || node.kind === 'raw' || node.kind === 'if' || node.kind === 'for') {
      if (node.path[0] === 'loop') return true;
    }
    if (node.kind === 'for') {
      if (subtreeUsesLoop(node.body, templates, depth, visiting)) return true;
    } else if (node.kind === 'if') {
      if (subtreeUsesLoop(node.then, templates, depth, visiting)) return true;
      if (node.else !== null && subtreeUsesLoop(node.else, templates, depth, visiting)) return true;
    } else if (node.kind === 'include') {
      if (depth < INCLUDE_DEPTH) {
        const t = templates.get(node.name);
        if (t !== undefined) {
          if (visiting.has(node.name)) return true;
          visiting.add(node.name);
          const r = subtreeUsesLoop(t, templates, depth + 1, visiting);
          visiting.delete(node.name);
          if (r) return true;
        }
      }
    }
  }
  return false;
}

/** `nodes` compiled into `st.code`: `st` holds the include depth, the loop
 * bindings in scope, the code lines, and the per-case compiler state. */
function compileNodes(nodes, st) {
  for (const node of nodes) {
    if (node.kind === 'text') {
      st.code.push(`O.push(${JSON.stringify(node.text)});`);
      continue;
    }
    if (node.kind === 'var' || node.kind === 'raw') {
      const r = resolveTemplatePath(node.path, st.bound);
      const raw = node.kind === 'raw';
      switch (r.shape.k) {
        case 'undef':
        case 'obj':
          st.code.push(`O.push('');`);
          break;
        case 'str':
          st.code.push(raw ? (r.nullable ? `O.push(${r.expr} ?? '');` : `O.push(${r.expr});`) : `O.push(E(${r.expr}));`);
          break;
        case 'num':
          st.code.push(r.nullable ? `O.push(N(${r.expr}));` : `O.push(String(${r.expr}));`);
          break;
        case 'bool':
          st.code.push(`O.push(B(${r.expr}));`);
          break;
        default:
          st.code.push(raw ? `O.push(W(${r.expr}));` : `O.push(E(W(${r.expr})));`);
          break;
      }
      continue;
    }
    if (node.kind === 'if') {
      const r = resolveTemplatePath(node.path, st.bound);
      if (r.shape.k === 'undef') {
        if (node.not) compileNodes(node.then, st);
        else if (node.else !== null) compileNodes(node.else, st);
        continue;
      }
      const cond = node.not ? `!Y(${r.expr})` : `Y(${r.expr})`;
      st.code.push(`if(${cond}){`);
      compileNodes(node.then, st);
      if (node.else !== null) {
        st.code.push('}else{');
        compileNodes(node.else, st);
      }
      st.code.push('}');
      continue;
    }
    if (node.kind === 'for') {
      const r = resolveTemplatePath(node.path, st.bound);
      if (r.shape.k !== 'arr' && r.shape.k !== 'any') continue;
      const a = `_a${st.cx.next++}`;
      const ii = `_i${st.cx.next++}`;
      const elShape = r.shape.k === 'arr' ? r.shape.el : ANY;
      const inner = new Map(st.bound);
      const needLoop = node.name !== 'loop' && subtreeUsesLoop(node.body, st.cx.templates, st.depth, new Set());
      if (node.name === 'loop') inner.set('loop', { shape: LOOP_SHAPE });
      else {
        inner.set(node.name, { shape: elShape });
        if (needLoop) inner.set('loop', { shape: LOOP_SHAPE });
      }
      st.code.push(`{const ${a}=${r.expr};if(Array.isArray(${a})){for(let ${ii}=0;${ii}<${a}.length;${ii}++){`);
      if (node.name === 'loop') {
        st.code.push(`const L_loop={index:${ii}+1,first:${ii}===0,last:${ii}===${a}.length-1,length:${a}.length};`);
      } else {
        st.code.push(`const L_${node.name}=${a}[${ii}];`);
        if (needLoop) st.code.push(`const L_loop={index:${ii}+1,first:${ii}===0,last:${ii}===${a}.length-1,length:${a}.length};`);
      }
      compileNodes(node.body, { depth: st.depth, bound: inner, code: st.code, cx: st.cx });
      st.code.push('}}}');
      continue;
    }
    if (node.kind === 'include') {
      if (st.depth < INCLUDE_DEPTH) {
        const t = st.cx.templates.get(node.name);
        if (t !== undefined) compileNodes(t, { depth: st.depth + 1, bound: st.bound, code: st.code, cx: st.cx });
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };

  // Templates, parsed in code-unit order of their name; one that does not
  // parse is reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // Templates compile lazily, only when a render asks for one.
  const cx = { templates, next: 0 };
  const compiled = new Map();
  const getFn = (name) => {
    let fn = compiled.get(name);
    if (fn !== undefined) return fn;
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const code = [];
    compileNodes(nodes, { depth: 0, bound: new Map(), code, cx });
    fn = new Function('V', 'O', 'E', 'Y', 'W', 'G', 'N', 'B', code.join(''));
    compiled.set(name, fn);
    return fn;
  };

  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter, in order: refused, reserved directory,
  // post with no date, unknown layout, draft.
  let kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its
  // directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files
  // they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug; each post's neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the
  // posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages
  // through theirs. A page's card is built once and shared between its own
  // render and the lists that show it.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of kept) s.card = cardOf(s);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};
  // One vars object per case, its per-render keys reassigned: cheaper than a
  // fresh spread object for every page.
  const V = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const render = (name, vars) => {
    const fn = getFn(name);
    if (fn === null) return null;
    V.page = vars.page;
    V.posts = vars.posts;
    V.pager = vars.pager;
    V.tag = vars.tag;
    const out = [];
    fn(V, out, escapeHtml, truthy, textOf, getOwn, numText, boolText);
    return out.join('');
  };
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
