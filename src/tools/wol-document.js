/**
 * 범용 WOL 출판물 문서 도구 — 새 서적이 나와도 코드를 고치지 않고 쓰기 위한 것.
 *
 * **자료는 wol.jw.org 에서만 가져온다.** 모든 요청은 safe-fetch.js 의 허용 호스트 검사를
 * 거친다.
 *
 * ## 왜 범용인가 (2026-11-06 실측)
 *
 * wol.jw.org 의 연구용 출판물은 같은 HTML 틀을 쓴다. 「성경 안내서」(gwt, 「하진」)와
 * 「용기」(wcg, 「용하」)를 비교하면 아래 요소의 클래스·중첩이 같다.
 *
 * - `<article class="… pub-{기호} docId-{문서 번호} …">` — 어떤 문서든 기호와 번호를 안다.
 * - 머리: `header` 안 `p.contextTtl`(장 표시) + `h1`(제목).
 * - 여는 상자: `div.openingContent` ("요점: …" 같은 라벨:값 문단). 「하진」의 "성경 각 책의
 *   주요 정보" 네모가 이것이다.
 * - 소제목: `h2`, `h3` (상자 안의 것은 상자 제목).
 * - 항 질문: `p.qu` ("1-2. …"). 질문 문단 바로 뒤에는 답 적는 칸 `.gen-field` 가 붙는다 —
 *   `p.qu` 가 없는 책(「용하」의 "토의해 보십시오")도 이 칸으로 질문임을 안다.
 * - 항: `span.parNum[data-pnum]` 이 앞에 붙은 `p`. 번호 없는 이야기체 문단도 있다.
 * - 목록: `li` — 하위 `li` 가 있으면 소그룹 제목, 없으면 질문(답 칸이 있을 때) 또는 항목.
 * - 보충 상자: `div.boxSupplement` — 제목 `.boxTtl`, 내용 `.boxContent`(표·문단·그림).
 *   "배울 수 있는 점:" 문단은 따로 뽑는다(회중 성서 연구 지침상 낭독 대상).
 * - 그림 설명 `figcaption`, 각주 `.groupFootnote`.
 * - 건너뜀: `.gen-field`(답 칸 자체), `.stdPullQuote`(본문 인용 반복), `.alternatePresentation`.
 * - 성구: `a.b`. 같은 괄호 안 연속 인용은 `data-bid` 앞 번호가 같고 책 이름이 앞에서 이어진다.
 *
 * ## 목차
 *
 * `/{loc}/wol/publication/{rs}/{lib}/{기호}` 가 그룹 0, `…/{기호}/{n}` 이 다른 그룹(부·편).
 * 페이지에는 그룹 링크(`/publication/…`)와 문서 링크(`/d/…/{번호}`)가 섞여 있다.
 * 그룹 번호는 언어마다 다를 수 있다 — 반드시 목차에서 얻은 값을 쓴다.
 */

import * as cheerio from 'cheerio';
import { safeFetch } from './safe-fetch.js';
import { resolveLocale, chapterUrl, SUPPORTED_LANGS } from './wol-locales.js';
import { searchLocalizedBooks, getLocalizedBookName } from './bible-books-i18n.js';
import { getBookNumber, getBookName } from './bible-books.js';
import { scraper } from './wol-scraper.js';

/** include_verse_text 일 때 성경 장을 몇 개까지 받아 올지. 장마다 요청 1회. */
export const MAX_VERSE_CHAPTERS = 8;

/** 한 장짜리 책 — 인용이 "옵 15" 처럼 절만으로 온다. */
const SINGLE_CHAPTER_BOOKS = new Set([31, 57, 63, 64, 65]);

// ============================================================================
// 공통
// ============================================================================

export function wolBase(lang) {
  return `https://wol.jw.org/${lang.locale}/wol`;
}

export function docUrl(lang, docid) {
  return `${wolBase(lang)}/d/${lang.rsconf}/${lang.lib}/${docid}`;
}

export function tocUrl(lang, symbol, group = null) {
  const base = `${wolBase(lang)}/publication/${lang.rsconf}/${lang.lib}/${encodeURIComponent(symbol)}`;
  return group === null || group === undefined || group === '' ? base : `${base}/${encodeURIComponent(group)}`;
}

/** 페이지를 받아 cheerio 로. 404 는 null. */
export async function fetchWolPage(url) {
  const res = await safeFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`wol.jw.org 응답 오류 HTTP ${res.status}: ${url}`);
  return cheerio.load(await res.text());
}

/** 공백 정규화. */
export function clean(text) {
  return String(text || '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .trim();
}

/** 책 번호 또는 이름 → 번호. */
export function resolveBook(book, langCode = 'KO') {
  if (typeof book === 'number' || /^\s*\d+\s*$/.test(String(book))) {
    const n = parseInt(book, 10);
    if (n >= 1 && n <= 66) return n;
    throw new Error(`책 번호는 1-66 이어야 합니다: ${book}`);
  }
  const q = String(book || '').trim();
  for (const code of [langCode, 'KO']) {
    const hit = searchLocalizedBooks(q, code, 1)[0];
    if (hit && hit.score >= 85) return hit.number;
  }
  const en = getBookNumber(q);
  if (en) return en;
  throw new Error(`성경 책을 찾지 못했습니다: "${book}"`);
}

export function bookLabel(bookNum, langCode) {
  return getLocalizedBookName(bookNum, langCode) || getBookName(bookNum) || String(bookNum);
}

/** wol.jw.org 문서 링크에서 문서 번호를 뽑는다. */
export function docidFromUrl(url) {
  const m = String(url || '').match(/^https:\/\/wol\.jw\.org\/[^/]+\/wol\/d\/[^/]+\/[^/]+\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ============================================================================
// 성구 인용
// ============================================================================

/**
 * 인용 텍스트 하나를 책·장·절로 나눈다.
 * ctx = { book, chapter } — 같은 괄호(같은 data-bid 그룹) 안에서 앞 인용의 책·장이 이어진다.
 * ctx.book 의 초깃값은 문서의 "기본 책"이다(「하진」은 그 장의 책, 그 밖에는 null).
 */
export function parseCitation(raw, ctx, langCode) {
  const text = clean(raw).replace(/^[—–\-\s]+/, '').replace(/[;,.]+$/, '').trim();
  const out = { text, book: null, book_name: null, chapter: null, verses: null };
  if (!text) return out;

  let rest = text;
  let book = null;

  // 책 이름이 앞에 붙은 경우 ("왕하 25:1", "고후 6:16", "1 Cor. 6:16", "Rev. 7:15")
  const m = text.match(/^((?:[1-3]\s*)?[^\d\s:][^\d:]*?)\.?\s*(\d.*)$/);
  if (m) {
    rest = m[2];
    try {
      book = resolveBook(m[1].trim(), langCode);
    } catch {
      return out; // 모르는 책 이름이면 원문만 남긴다.
    }
  }

  if (book) {
    ctx.book = book;
    ctx.chapter = null;
  }
  out.book = ctx.book;
  if (!out.book) return out;

  const cv = rest.match(/^(\d+):(.+)$/);
  const versesOnly = /^\d+(?:\s*[-–]\s*\d+)?(?:,\s*\d+)*$/.test(rest);
  if (!cv && book && SINGLE_CHAPTER_BOOKS.has(book) && versesOnly) {
    out.chapter = 1; // 한 장짜리 책은 장 없이 절만 쓴다 ("옵 15", "유 9").
    out.verses = rest;
    ctx.chapter = 1;
  } else if (cv) {
    out.chapter = parseInt(cv[1], 10);
    out.verses = cv[2].replace(/\s+/g, ' ').trim();
    ctx.chapter = out.chapter;
  } else if (versesOnly && ctx.chapter) {
    out.chapter = ctx.chapter; // "19" 처럼 절만 온 경우 — 앞 인용의 장을 잇는다.
    out.verses = rest;
  }

  out.book_name = bookLabel(out.book, langCode);
  return out;
}

/** 절 표기("25-28", "18, 19, 22", "1–3:27")를 그 장 안의 절 번호 목록으로. */
export function expandVerses(verses) {
  if (!verses) return [];
  const sameChapter = String(verses).split(/[–-]\s*\d+:/)[0]; // 장을 넘는 범위는 첫 장 부분만
  const nums = [];
  for (const part of sameChapter.split(',')) {
    const [a, b] = part.split(/[-–]/).map((s) => parseInt(s, 10));
    if (Number.isNaN(a)) continue;
    if (!Number.isNaN(b) && b >= a && b - a < 60) for (let v = a; v <= b; v++) nums.push(v);
    else nums.push(a);
  }
  return nums;
}

function collectCitations($, el, ctx) {
  const refs = [];
  const groups = new Map();
  $(el)
    .find('a.b')
    .each((_, a) => {
      const bid = String($(a).attr('data-bid') || '').split('-')[0] || `_${refs.length}`;
      if (!groups.has(bid)) groups.set(bid, { book: ctx.defaultBook, chapter: null });
      const ref = parseCitation($(a).text(), groups.get(bid), ctx.langCode);
      if (!ref.text) return;
      if (ref.book && ref.chapter) ref.wol_url = chapterUrl(ctx.langCode, ref.book, ref.chapter);
      refs.push(ref);
    });
  return refs;
}

// ============================================================================
// 문서 파싱
// ============================================================================

/** "14-15." / "1-2." / "3." → [14, 15] */
export function parseNumbers(label) {
  const m = String(label).match(/^(\d+)(?:\s*[-–]\s*(\d+))?\./);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  const out = [];
  for (let i = a; i <= b && i - a < 50; i++) out.push(i);
  return out;
}

const LEARNING_RE = /^(배울 수 있는 점|What You Can Learn|Lesson)\s*:/i;
const DESCRIPTION_RE = /^(설명|Description)\s*:/i;

function parseSupplement($, box, ctx) {
  const $box = $(box);
  const title = clean($box.find('.boxTtl').first().text());
  const idMatch = title.match(/^(\d+-\S+)\s+(.*)$/);
  const sup = {
    id: idMatch ? idMatch[1] : null,
    title: idMatch ? idMatch[2] : title,
    learning_points: [],
    description: [],
    rows: [],
    text: [],
    figures: [],
    scriptures: collectCitations($, box, ctx),
  };

  const content = $box.find('.boxContent').first();
  content.find('table tr').each((_, tr) => {
    const cells = $(tr).find('td, th').map((__, td) => clean($(td).text())).get().filter(Boolean);
    if (cells.length) sup.rows.push(cells);
  });

  content.find('p').each((_, p) => {
    const $p = $(p);
    if ($p.closest('table').length || $p.closest('.gen-field').length) return;
    const text = clean($p.text());
    if (!text) return;
    if ($p.closest('figcaption').length) sup.figures.push(text);
    else if (LEARNING_RE.test(text)) sup.learning_points.push(text.replace(/^[^:]+:\s*/, ''));
    else if (DESCRIPTION_RE.test(text)) sup.description.push(text.replace(/^[^:]+:\s*/, ''));
    else sup.text.push(text);
  });

  $box.find('figcaption p').each((_, p) => {
    const t = clean($(p).text());
    if (t && !sup.figures.includes(t)) sup.figures.push(t);
  });
  return sup;
}

/** 문단 바로 뒤(형제)에 답 적는 칸이 있는가 — 질문이라는 표시. */
function hasAnswerField($, node) {
  const next = $(node).nextAll().first();
  return next.is('.gen-field');
}

/**
 * 문서 HTML → 구조화 결과. 네트워크 없이 테스트할 수 있도록 분리했다.
 *
 * @param {object} opts
 * @param {string} opts.langCode     언어 코드 (KO, E …)
 * @param {number|null} opts.defaultBook 책 이름 없는 성구 인용에 쓸 기본 책 (없으면 null)
 * @param {string|null} opts.url     출처 URL
 */
export function parseWolDocument(html, { langCode = 'KO', defaultBook = null, url = null } = {}) {
  const $ = cheerio.load(html);
  const article = $('article').first();
  const cls = article.attr('class') || '';
  const ctx = { langCode, defaultBook };
  const warnings = [];

  const doc = {
    symbol: (cls.match(/\bpub-([a-z0-9]+)\b/i) || [])[1] || null,
    docid: parseInt((cls.match(/\bdocId-(\d+)\b/) || [])[1], 10) || null,
    citation: clean($('a.spriteLink[href*="/publication/"]').first().text()) || null,
    label: clean(article.find('header p.contextTtl, p.contextTtl').first().text()),
    title: clean(article.find('h1').first().text()),
    source_url: url,
    opening: [],
    header_boxes: [],
    sections: [],
    footnotes: [],
    parse_warnings: warnings,
  };
  if (!article.length) warnings.push('문서 본문(<article>)을 찾지 못했습니다.');

  // --- 여는 상자 ---
  article.find('.openingContent p').each((_, p) => {
    if ($(p).closest('.boxSupplement').length) return; // 머리 상자는 header_boxes 로
    const text = clean($(p).text());
    if (!text) return;
    const i = text.indexOf(':');
    if (i > 0 && i < 45) doc.opening.push({ label: text.slice(0, i).trim(), value: text.slice(i + 1).trim() });
    else doc.opening.push({ label: null, value: text });
  });

  // --- 본문 순회 ---
  let section = null;
  const openSection = (heading, level) => {
    section = { heading, level, items: [] };
    doc.sections.push(section);
  };

  for (const node of article.find('h2, h3, p, .boxSupplement, figure').toArray()) {
    const $n = $(node);

    if ($n.parents('.boxSupplement').length) continue; // 상자 안은 상자 단위로 처리
    if ($n.is('.boxSupplement')) {
      const sup = parseSupplement($, node, ctx);
      if (!section) doc.header_boxes.push(sup);
      else section.items.push({ type: 'supplement', ...sup });
      continue;
    }

    if ($n.closest('header').length || $n.closest('.openingContent').length) continue;
    if ($n.closest('.gen-field').length || $n.closest('.stdPullQuote').length) continue;
    if ($n.closest('.alternatePresentation').length) continue;
    if ($n.closest('.groupFootnote').length) {
      if ($n.is('p')) doc.footnotes.push(clean($n.text()));
      continue;
    }

    if ($n.is('h2, h3')) {
      const heading = clean($n.text());
      if (heading && !$n.closest('li').length) openSection(heading, $n.is('h2') ? 2 : 3);
      continue;
    }

    if ($n.is('figure')) {
      const caption = clean($n.find('figcaption').text());
      if (caption) {
        if (!section) openSection(null, 2);
        section.items.push({ type: 'figure', caption });
      }
      continue;
    }

    // p
    if ($n.closest('figure').length) continue;
    const text = clean($n.text());
    if (!text) continue;
    if (!section) openSection(null, 2);

    const li = $n.closest('li');
    if (li.length) {
      if (li.find('li').length) {
        section.items.push({ type: 'subheading', text });
      } else {
        const isQ = hasAnswerField($, node);
        section.items.push({ type: isQ ? 'question' : 'list_item', text, scriptures: collectCitations($, node, ctx) });
      }
      continue;
    }

    if ($n.is('.qu') || hasAnswerField($, node)) {
      const numbers = $n.is('.qu') ? parseNumbers(text) : null;
      section.items.push({ type: 'question', ...(numbers ? { paragraphs: numbers } : {}), text, scriptures: collectCitations($, node, ctx) });
      continue;
    }

    const pnum = $n.find('span.parNum').attr('data-pnum');
    if (pnum) {
      section.items.push({
        type: 'paragraph',
        number: parseInt(pnum, 10),
        text: text.replace(new RegExp(`^${pnum}\\s+`), ''),
        scriptures: collectCitations($, node, ctx),
      });
      continue;
    }

    section.items.push({ type: 'text', text, scriptures: collectCitations($, node, ctx) });
  }

  const items = doc.sections.flatMap((s) => s.items);
  const count = (t) => items.filter((i) => i.type === t).length;
  doc.counts = {
    sections: doc.sections.filter((s) => s.heading).length,
    questions: count('question'),
    paragraphs: count('paragraph'),
    text_blocks: count('text'),
    supplements: count('supplement'),
    figures: count('figure'),
  };
  if (!items.length) warnings.push('본문 항목을 하나도 찾지 못했습니다.');
  return doc;
}

/** 번호 붙은 항 범위로 자른다. 상자·그림·목록은 범위 안 항 사이에 있는 것만 남긴다. */
export function filterParagraphs(doc, range) {
  if (!range) return doc;
  const m = String(range).match(/^\s*(\d+)\s*(?:[-–~]\s*(\d+))?\s*$/);
  if (!m) throw new Error(`paragraphs 형식이 올바르지 않습니다: "${range}" (예: "1-11")`);
  const from = parseInt(m[1], 10);
  const to = m[2] ? parseInt(m[2], 10) : from;

  const paraNums = doc.sections.flatMap((s) => s.items).filter((i) => i.type === 'paragraph').map((i) => i.number);
  if (!paraNums.length) throw new Error('이 문서에는 번호 붙은 항이 없어 paragraphs 로 자를 수 없습니다.');
  const maxPara = Math.max(...paraNums);

  // 마지막 항 뒤(복습·더 찾아보기 등)는 범위가 마지막 항을 포함할 때만 남긴다.
  let current = 0;
  const sections = [];
  for (const s of doc.sections) {
    const items = [];
    for (const item of s.items) {
      if (item.type === 'question' && item.paragraphs) current = item.paragraphs[0];
      if (item.type === 'paragraph') current = item.number;
      const n = item.type === 'question' && item.paragraphs ? item.paragraphs[0] : current;
      const afterLast = current >= maxPara && item.type !== 'paragraph' && !(item.type === 'question' && item.paragraphs);
      if ((n >= from && n <= to) || (afterLast && to >= maxPara) || (current === 0 && from <= 1)) items.push(item);
    }
    if (items.length) sections.push({ ...s, items });
  }
  return { ...doc, sections, paragraph_range: `${from}-${to}` };
}

// ============================================================================
// 성구 본문 (선택)
// ============================================================================

function allCitations(doc) {
  return doc.sections.flatMap((s) => s.items).flatMap((i) => i.scriptures || []);
}

export async function attachVerseTexts(doc, langCode) {
  const refs = allCitations(doc).filter((r) => r.book && r.chapter);
  const keys = [...new Set(refs.map((r) => `${r.book}:${r.chapter}`))];
  const fetchKeys = keys.slice(0, MAX_VERSE_CHAPTERS);

  const chapters = new Map();
  await Promise.all(
    fetchKeys.map(async (k) => {
      const [b, c] = k.split(':').map(Number);
      try {
        chapters.set(k, (await scraper.extractChapterContent(b, c, langCode)).verses);
      } catch (e) {
        chapters.set(k, e);
      }
    }),
  );

  for (const r of refs) {
    const verses = chapters.get(`${r.book}:${r.chapter}`);
    if (!verses || verses instanceof Error) continue;
    const wanted = expandVerses(r.verses);
    const found = verses.filter((v) => wanted.includes(v.verse_num));
    if (found.length) r.verse_text = found.map((v) => `${v.verse_num} ${v.verse_text_plain || v.verse_text}`).join(' ');
  }

  doc.verse_text_info = {
    chapters_needed: keys.length,
    chapters_fetched: fetchKeys.length,
    ...(keys.length > fetchKeys.length
      ? { note: `성경 장 ${keys.length}개 중 ${fetchKeys.length}개만 가져왔습니다. paragraphs 로 범위를 좁히면 전부 받을 수 있습니다.` }
      : {}),
  };
}

// ============================================================================
// 텍스트 정리본
// ============================================================================

function refsLine(refs, indent = '   ') {
  if (!refs?.length) return [];
  const lines = [`${indent}성구: ${refs.map((r) => (r.book && r.chapter ? `${r.book_name} ${r.chapter}:${r.verses}` : r.text)).join('; ')}`];
  for (const r of refs) if (r.verse_text) lines.push(`${indent}  · ${r.book_name} ${r.chapter}:${r.verses} — ${r.verse_text}`);
  return lines;
}

/**
 * @param {object} doc parseWolDocument 결과
 * @param {object} labels { heading, opening } — 출판물별로 이름만 바꿔 쓴다.
 */
export function renderDocumentText(doc, labels = {}) {
  const out = [];
  out.push(labels.heading || `# ${[doc.label, doc.title].filter(Boolean).join(' — ')}`);
  out.push(`출처: ${doc.source_url}`);
  if (doc.symbol || doc.docid) out.push(`출판물 기호: ${doc.symbol || '?'} · 문서 번호: ${doc.docid || '?'}${doc.citation ? ` · ${doc.citation}` : ''}`);
  if (doc.paragraph_range) out.push(`범위: ${doc.paragraph_range}항`);
  out.push('');

  if (doc.opening.length || doc.header_boxes.length) {
    out.push(`## ${labels.opening || '여는 상자'}`);
    for (const k of doc.opening) out.push(`- ${k.label ? `${k.label}: ` : ''}${k.value}`);
    for (const b of doc.header_boxes) out.push(`- [${b.title}] ${[...b.text, ...b.description].join(' / ')}`);
    out.push('');
  }

  for (const s of doc.sections) {
    if (s.heading) out.push(`${s.level === 3 ? '###' : '##'} ${s.heading}`);
    for (const item of s.items) {
      switch (item.type) {
        case 'question':
          out.push(item.paragraphs ? `\n### 질문 ${item.text}` : `- (질문) ${item.text}`);
          out.push(...refsLine(item.scriptures, item.paragraphs ? '   ' : '    '));
          break;
        case 'paragraph':
          out.push(`[${item.number}항] ${item.text}`);
          out.push(...refsLine(item.scriptures));
          break;
        case 'subheading':
          out.push(`#### ${item.text}`);
          break;
        case 'list_item':
          out.push(`- ${item.text}`);
          out.push(...refsLine(item.scriptures, '    '));
          break;
        case 'text':
          out.push(item.text);
          out.push(...refsLine(item.scriptures));
          break;
        case 'figure':
          out.push(`(그림 설명) ${item.caption}`);
          break;
        case 'supplement':
          out.push(`\n> 보충 자료 ${item.id ? `${item.id} ` : ''}${item.title}`);
          for (const t of item.text) out.push(`>   ${t}`);
          for (const r of item.rows) out.push(`>   | ${r.join(' | ')} |`);
          for (const d of item.description) out.push(`>   (설명) ${d}`);
          for (const f of item.figures) out.push(`>   (그림) ${f}`);
          for (const lp of item.learning_points) out.push(`>   ★ 배울 수 있는 점 (낭독): ${lp}`);
          out.push(...refsLine(item.scriptures, '>   '));
          out.push('');
          break;
        default:
          break;
      }
    }
    out.push('');
  }

  if (doc.footnotes.length) {
    out.push('## 각주');
    for (const f of doc.footnotes) out.push(`- ${f}`);
    out.push('');
  }

  if (doc.verse_text_info?.note) out.push(`참고: ${doc.verse_text_info.note}`);
  if (doc.parse_warnings.length) out.push(`파싱 경고: ${doc.parse_warnings.join(' / ')}`);
  const c = doc.counts;
  out.push(`요약: 소제목 ${c.sections}개, 질문 ${c.questions}개, 번호 항 ${c.paragraphs}개, 문단 ${c.text_blocks}개, 보충 자료 ${c.supplements}개, 그림 ${c.figures}개`);
  return out.join('\n');
}

// ============================================================================
// 목차
// ============================================================================

/** 목차 페이지 → 그룹 링크와 문서 링크. */
export function parseToc(html, lang, symbol) {
  const $ = cheerio.load(html);
  const prefix = `/${lang.locale}/wol/`;
  const groupRe = new RegExp(`^${prefix}publication/${lang.rsconf}/${lang.lib}/${symbol}/([^/?#]+)$`);
  const docRe = new RegExp(`^${prefix}d/${lang.rsconf}/${lang.lib}/(\\d+)$`);
  const groups = [];
  const documents = [];
  const seen = new Set();

  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (seen.has(href)) return;
    const title = clean($(a).text());
    let m;
    if ((m = href.match(groupRe))) {
      seen.add(href);
      groups.push({ group: m[1], title, url: `https://wol.jw.org${href}` });
    } else if ((m = href.match(docRe))) {
      seen.add(href);
      const num = title.match(/^(\d+)\s/);
      documents.push({
        docid: parseInt(m[1], 10),
        title,
        ...(num ? { number: parseInt(num[1], 10) } : {}),
        url: `https://wol.jw.org${href}`,
      });
    }
  });

  const pageTitle = clean($('title').text()).replace(/\s*—.*$/, '');
  return { page_title: pageTitle, groups, documents };
}

export async function getPublicationToc({ symbol, group = null, langwritten = 'KO' }) {
  if (!/^[a-z0-9-]+$/i.test(String(symbol || ''))) throw new Error(`출판물 기호가 올바르지 않습니다: "${symbol}" (예: wcg, gwt, lfb)`);
  const lang = resolveLocale(langwritten);
  const url = tocUrl(lang, symbol, group);
  const $ = await fetchWolPage(url);
  if (!$) throw new Error(`wol.jw.org 에서 출판물 "${symbol}"${group ? ` 그룹 ${group}` : ''} 목차를 찾지 못했습니다 (${lang.code}).`);
  return { symbol, language: lang.code, group: group ?? null, toc_url: url, ...parseToc($.html(), lang, symbol) };
}

/**
 * 목차에서 "번호 제목" 문서를 찾는다 (예: 「용하」 15장 → "15 나오미와 룻 …").
 * 그룹 0 에 없으면 그룹 링크를 차례로 연다.
 */
export async function findDocidByNumber({ symbol, number, langwritten = 'KO' }) {
  const first = await getPublicationToc({ symbol, langwritten });
  const hit = (toc) => toc.documents.find((d) => d.number === number);
  let found = hit(first);
  if (found) return found;
  for (const g of first.groups) {
    if (String(g.group) === '0') continue;
    found = hit(await getPublicationToc({ symbol, group: g.group, langwritten }));
    if (found) return found;
  }
  throw new Error(`출판물 "${symbol}" 목차에서 ${number}번 문서를 찾지 못했습니다. get_wol_publication_toc 로 확인하십시오.`);
}

// ============================================================================
// 도구
// ============================================================================

const langSchema = {
  type: 'string',
  description: `언어 코드 (기본 "KO" = 한국어). 지원: ${SUPPORTED_LANGS.join(', ')}.`,
  default: 'KO',
};

export const getWolPublicationTocTool = {
  name: 'get_wol_publication_toc',
  description:
    'wol.jw.org 출판물의 목차를 가져옵니다(모든 연구용 서적 공통). 출판물 기호로 지정합니다 — 예: "wcg"(「용하」), "gwt"(「하진」 성경 안내서), "lfb"(「훈」). ' +
    '그룹(부·편)이 있으면 groups 의 group 값을 다시 넘겨 하위 목차를 엽니다. 문서의 docid 를 get_wol_document 에 넘기면 본문을 받습니다. ' +
    '기호를 모르면 집회 교재(getWorkbookContent)나 get_wol_document 결과의 "출판물 기호"를 보십시오.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: '출판물 기호 (예: wcg, gwt, lfb)' },
      group: { type: 'string', description: '목차 그룹 번호 (생략하면 첫 목차). 목차 결과의 groups[].group 값을 그대로 씁니다.' },
      langwritten: langSchema,
    },
    required: ['symbol'],
  },
};

export const getWolDocumentTool = {
  name: 'get_wol_document',
  description:
    'wol.jw.org 의 출판물 문서(서적의 한 장, 기사 등) 하나를 가져와 연구 사회 준비용으로 구조화합니다 — 새 서적도 코드 수정 없이 씁니다. ' +
    '여는 상자, 소제목, 항 질문과 항, 토의 질문(답 칸이 있는 문단), 인용 성구(책·장·절로 정리), 보충 상자(표·설명·그림·"배울 수 있는 점"), 그림 설명, 각주를 돌려줍니다. ' +
    '문서는 docid, wol.jw.org 문서 url, 또는 symbol+number(목차의 "번호 제목", 예: wcg 15 = 「용하」 15장) 중 하나로 지정합니다. ' +
    '「성경 안내서」는 get_guidebook_chapter 가 같은 결과에 책별 표시를 더해 줍니다.',
  inputSchema: {
    type: 'object',
    properties: {
      docid: { type: 'number', description: 'WOL 문서 번호 (예: 1102025915)' },
      url: { type: 'string', description: 'wol.jw.org 문서 링크 (https://wol.jw.org/…/wol/d/…/{번호})' },
      symbol: { type: 'string', description: '출판물 기호 — number 와 함께 쓴다 (예: wcg)' },
      number: { type: 'number', description: '목차에서 제목 앞에 붙은 번호 (예: 15)' },
      paragraphs: { type: 'string', description: '번호 붙은 항 범위 (예: "1-11"). 번호 항이 없는 문서에는 쓰지 않습니다.' },
      include_verse_text: {
        type: 'boolean',
        description: `인용 성구의 신세계역 본문도 wol.jw.org 에서 가져옵니다 (기본 false, 성경 장 ${MAX_VERSE_CHAPTERS}개까지).`,
        default: false,
      },
      format: { type: 'string', enum: ['text', 'json'], description: '"text"(기본) 또는 "json"', default: 'text' },
      langwritten: langSchema,
    },
    required: [],
  },
};

export const wolDocumentTools = [getWolPublicationTocTool, getWolDocumentTool];

/**
 * 문서를 받아 구조화한다. 다른 도구(「하진」 등)도 이 함수를 쓴다.
 */
export async function getWolDocument({ docid, url, symbol, number, paragraphs, include_verse_text, langwritten = 'KO', defaultBook = null }) {
  const lang = resolveLocale(langwritten);

  let id = docid ? parseInt(docid, 10) : null;
  if (!id && url) {
    id = docidFromUrl(url);
    if (!id) throw new Error(`wol.jw.org 문서 링크가 아닙니다: ${url}`);
  }
  if (!id && symbol && number) id = (await findDocidByNumber({ symbol, number: parseInt(number, 10), langwritten })).docid;
  if (!id) throw new Error('docid, url, 또는 symbol+number 중 하나를 지정하십시오.');

  const pageUrl = docUrl(lang, id);
  const $ = await fetchWolPage(pageUrl);
  if (!$) throw new Error(`wol.jw.org 에 문서 ${id} 가 없습니다 (${lang.code}). 아직 공개되지 않았거나 번호가 틀렸습니다.`);

  let doc = parseWolDocument($.html(), { langCode: lang.code, defaultBook, url: pageUrl });
  doc = filterParagraphs(doc, paragraphs);
  if (include_verse_text) await attachVerseTexts(doc, lang.code);
  return doc;
}

export async function handleWolDocumentTools(request) {
  const { name, arguments: args = {} } = request.params;
  if (name !== 'get_wol_publication_toc' && name !== 'get_wol_document') return null;

  try {
    if (name === 'get_wol_publication_toc') {
      const toc = await getPublicationToc(args);
      return { content: [{ type: 'text', text: JSON.stringify(toc, null, 2) }] };
    }
    const doc = await getWolDocument(args);
    const text = args.format === 'json' ? JSON.stringify(doc, null, 2) : renderDocumentText(doc);
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
}
