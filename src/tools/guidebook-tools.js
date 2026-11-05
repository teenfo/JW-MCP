/**
 * 「하느님의 말씀은 진리입니다—성경 안내서」 (기호 gwt) 도구.
 *
 * 회중 성서 연구 사회자가 장을 준비할 때 쓴다. **자료는 wol.jw.org 에서만 가져온다**
 * — 모든 요청은 safe-fetch.js 의 허용 호스트 검사를 거친다.
 *
 * ## WOL 구조 (2026-11-06 실측, 한국어)
 *
 * - 한국어 약칭 「하진」. 목차: `/{loc}/wol/publication/{rs}/{lib}/gwt/4` ("성경 책들"). 공개된 장만
 *   링크가 있다. (영어는 이 목차 경로가 404 — 장 문서 번호는 같아서 장은 받을 수 있다.)
 *   그날 기준 에스겔·다니엘·호세아·요엘 4개 장만 있었다 — 책이 단계적으로 공개된다.
 *   소개 문서(이 책을 활용하는 방법, 보충 자료 목록)는 `/gwt/0` 에 있다.
 * - 장 = 성경 책 한 권. 문서 번호는 `1102026500 + 책 번호` (에스겔 26 → 1102026526).
 *   공개 전인 책은 404 가 난다.
 * - 장 머리: `header p.contextTtl`("성경 제26권") + `h1`("에스겔").
 * - "성경 각 책의 주요 정보" 네모: `div.openingContent` 의 문단들
 *   ("요점: …", "성경 주제와의 연관성: …", "필자: …", "기록 장소: …", "기록 완료: …",
 *   "망라 기간: …"). 바로 뒤의 "성경 책 목록" 상자도 머리 부분에 속한다.
 * - 본문: `h2` 소제목 → `p.qu`("1-2. 질문…") → `p` 항(앞에 `span.parNum[data-pnum]`).
 * - 보충 자료: `div.boxSupplement` — 제목 `.boxTtl`("26-가 …"), 내용은 표·문단·그림.
 *   "배울 수 있는 점:" 으로 시작하는 문단이 있다(사회자 지침상 낭독 대상).
 * - 끝부분 "…에서 얻을 수 있는 유익": 중첩 `li` — 바깥 li 가 소그룹("1. 여호와와 더
 *   가까워지세요"), 안쪽 li 가 질문(ㄱ, ㄴ, ㄷ).
 * - 성구: `a.b` 링크. 텍스트가 "36:22;" 처럼 **책 이름 없이** 오면 이 장의 책이다.
 *   같은 괄호 안의 연속 인용은 `data-bid` 앞 번호가 같고, 책 이름은 앞 인용에서 이어진다
 *   ("신 24:16;" 다음 " 30:19" 는 신명기).
 * - 그 밖에 건너뛰는 것: `.gen-field`(답 적는 칸), `.stdPullQuote`(본문 인용 반복).
 */

import * as cheerio from 'cheerio';
import { safeFetch } from './safe-fetch.js';
import { resolveLocale, chapterUrl } from './wol-locales.js';
import { searchLocalizedBooks, getLocalizedBookName } from './bible-books-i18n.js';
import { getBookNumber, getBookName } from './bible-books.js';
import { scraper } from './wol-scraper.js';

const PUB = 'gwt';
const DOC_BASE = 1102026500;

/** 실측해서 장이 파싱되는 것을 확인한 언어만 넣는다 (wol-locales.js 와 같은 원칙). */
export const GUIDEBOOK_LANGS = ['KO', 'E'];

/** include_verse_text 일 때 성경 장을 몇 개까지 받아 올지. 장마다 요청 1회. */
const MAX_VERSE_CHAPTERS = 8;

// ============================================================================
// 도구 정의
// ============================================================================

const langSchema = {
  type: 'string',
  description: `언어 코드 (기본 "KO" = 한국어). 지원: ${GUIDEBOOK_LANGS.join(', ')}.`,
  default: 'KO',
};

export const getGuidebookChapterListTool = {
  name: 'get_guidebook_chapter_list',
  description:
    '「하느님의 말씀은 진리입니다—성경 안내서」(gwt)의 목차를 wol.jw.org 에서 가져옵니다. ' +
    '이 책은 성경 책 한 권이 한 장이며 단계적으로 공개되므로, 현재 wol.jw.org 에 공개된 장만 나옵니다. ' +
    '각 장의 책 번호를 get_guidebook_chapter 에 넘기면 됩니다.',
  inputSchema: {
    type: 'object',
    properties: { langwritten: langSchema },
    required: [],
  },
};

export const getGuidebookChapterTool = {
  name: 'get_guidebook_chapter',
  description:
    '「하느님의 말씀은 진리입니다—성경 안내서」(gwt)의 한 장을 wol.jw.org 에서 가져와 회중 성서 연구 사회 준비용으로 구조화합니다. ' +
    '"성경 각 책의 주요 정보" 네모, 소제목, 항별 질문과 항 본문, 각 항에 인용된 성구(책·장·절로 정리), ' +
    '보충 자료(표·연대표·지도·도해 설명과 "배울 수 있는 점"), 끝부분 복습 질문, 각주를 돌려줍니다. ' +
    '장은 성경 책 번호(예: 26 = 에스겔) 또는 책 이름으로 지정합니다. ' +
    'include_verse_text 를 켜면 인용 성구의 신세계역 본문도 wol.jw.org 에서 함께 가져옵니다(paragraphs 로 범위를 좁혀 쓰십시오).',
  inputSchema: {
    type: 'object',
    properties: {
      book: {
        type: ['number', 'string'],
        description: '성경 책 번호(1-66) 또는 이름·약칭. 예: 26, "에스겔", "겔", "Ezekiel"',
      },
      paragraphs: {
        type: 'string',
        description:
          '돌려받을 항 범위 (예: "1-11"). 생략하면 장 전체. 주요 정보 네모와 각주는 항상 포함되고, ' +
          '보충 자료는 범위 안의 항 사이에 나오는 것만 포함됩니다. 끝부분 복습 질문은 범위가 장 끝을 포함할 때만 나옵니다.',
      },
      include_verse_text: {
        type: 'boolean',
        description: `인용 성구의 본문을 함께 가져옵니다 (기본 false). 성경 장 ${MAX_VERSE_CHAPTERS}개까지.`,
        default: false,
      },
      format: {
        type: 'string',
        enum: ['text', 'json'],
        description: '"text"(기본, 읽기 쉬운 정리본) 또는 "json"(구조화 데이터).',
        default: 'text',
      },
      langwritten: langSchema,
    },
    required: ['book'],
  },
};

export const guidebookTools = [getGuidebookChapterListTool, getGuidebookChapterTool];

// ============================================================================
// 공통
// ============================================================================

function guideLocale(langwritten = 'KO') {
  const lang = resolveLocale(langwritten);
  if (!GUIDEBOOK_LANGS.includes(lang.code)) {
    throw new Error(`「성경 안내서」는 ${GUIDEBOOK_LANGS.join(', ')} 만 지원합니다 (요청: ${langwritten}).`);
  }
  return lang;
}

function wolBase(lang) {
  return `https://wol.jw.org/${lang.locale}/wol`;
}

export function chapterDocUrl(lang, bookNum) {
  return `${wolBase(lang)}/d/${lang.rsconf}/${lang.lib}/${DOC_BASE + bookNum}`;
}

async function fetchPage(url) {
  const res = await safeFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`wol.jw.org 응답 오류 HTTP ${res.status}: ${url}`);
  return cheerio.load(await res.text());
}

/** 공백 정규화 + 상호 참조/각주 마커 제거. */
function clean(text) {
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

function bookLabel(bookNum, langCode) {
  return getLocalizedBookName(bookNum, langCode) || getBookName(bookNum) || String(bookNum);
}

// ============================================================================
// 성구 인용 파싱
// ============================================================================

/**
 * 인용 텍스트 하나를 책·장·절로 나눈다.
 * ctx = { book, chapter } — 같은 괄호(같은 data-bid 그룹) 안에서 앞 인용의 책·장이 이어진다.
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
    const name = m[1].trim();
    rest = m[2];
    try {
      book = resolveBook(name, langCode);
    } catch {
      return out; // 모르는 책 이름이면 원문만 남긴다.
    }
  }

  if (book) {
    ctx.book = book;
    ctx.chapter = null;
  }
  out.book = ctx.book;

  const cv = rest.match(/^(\d+):(.+)$/);
  if (cv) {
    out.chapter = parseInt(cv[1], 10);
    out.verses = cv[2].replace(/\s+/g, ' ').trim();
    ctx.chapter = out.chapter;
  } else if (/^\d+(?:\s*[-–]\s*\d+)?(?:,\s*\d+)*$/.test(rest) && ctx.chapter) {
    // "19" 처럼 절만 온 경우 — 앞 인용의 장을 잇는다.
    out.chapter = ctx.chapter;
    out.verses = rest;
  }

  if (out.book) out.book_name = bookLabel(out.book, langCode);
  return out;
}

/** 절 표기("25-28", "18, 19, 22", "1–3:27")를 이 장 안의 절 번호 목록으로. */
export function expandVerses(verses) {
  if (!verses) return [];
  // 장을 넘는 범위("1–3:27")는 첫 장 부분만 — 시작 절부터라고만 표시한다.
  const sameChapter = String(verses).split(/[–-]\s*\d+:/)[0];
  const nums = [];
  for (const part of sameChapter.split(',')) {
    const [a, b] = part.split(/[-–]/).map((s) => parseInt(s, 10));
    if (Number.isNaN(a)) continue;
    if (!Number.isNaN(b) && b >= a && b - a < 60) for (let v = a; v <= b; v++) nums.push(v);
    else nums.push(a);
  }
  return nums;
}

function collectCitations($, el, chapterBook, langCode) {
  const refs = [];
  const groups = new Map();
  $(el)
    .find('a.b')
    .each((_, a) => {
      const bid = String($(a).attr('data-bid') || '').split('-')[0] || `_${refs.length}`;
      if (!groups.has(bid)) groups.set(bid, { book: chapterBook, chapter: null });
      const ref = parseCitation($(a).text(), groups.get(bid), langCode);
      if (!ref.text) return;
      if (ref.book && ref.chapter) ref.wol_url = chapterUrl(langCode, ref.book, ref.chapter);
      refs.push(ref);
    });
  return refs;
}

// ============================================================================
// 장 파싱
// ============================================================================

function parseNumbers(label) {
  // "14-15." / "1-2." / "3." → [14, 15]
  const m = String(label).match(/^(\d+)(?:\s*[-–]\s*(\d+))?\./);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = m[2] ? parseInt(m[2], 10) : a;
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function parseSupplement($, box, chapterBook, langCode) {
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
    scriptures: collectCitations($, box, chapterBook, langCode),
  };

  const content = $box.find('.boxContent').first();
  content.find('table tr').each((_, tr) => {
    const cells = $(tr)
      .find('td, th')
      .map((__, td) => clean($(td).text()))
      .get()
      .filter(Boolean);
    if (cells.length) sup.rows.push(cells);
  });

  content.find('p').each((_, p) => {
    const $p = $(p);
    if ($p.closest('table').length || $p.closest('.gen-field').length) return;
    const text = clean($p.text());
    if (!text) return;
    if ($p.closest('figcaption').length) {
      sup.figures.push(text);
    } else if (/^(배울 수 있는 점|What You Can Learn|Lesson)\s*:/i.test(text)) {
      sup.learning_points.push(text.replace(/^[^:]+:\s*/, ''));
    } else if (/^(설명|Description)\s*:/i.test(text)) {
      sup.description.push(text.replace(/^[^:]+:\s*/, ''));
    } else {
      sup.text.push(text);
    }
  });

  // 그림 설명이 boxContent 바깥(제목 아래)에 있는 경우
  $box.find('figcaption p').each((_, p) => {
    const t = clean($(p).text());
    if (t && !sup.figures.includes(t)) sup.figures.push(t);
  });

  return sup;
}

/**
 * 장 HTML → 구조화 결과. 네트워크 없이 테스트할 수 있도록 분리했다.
 */
export function parseGuidebookChapter(html, { bookNum, langCode = 'KO', url = null } = {}) {
  const $ = cheerio.load(html);
  const article = $('article').first();
  const warnings = [];

  const result = {
    publication: '하느님의 말씀은 진리입니다—성경 안내서',
    publication_short: '하진',
    book_num: bookNum,
    chapter_label: clean(article.find('header p.contextTtl, p.contextTtl').first().text()),
    title: clean(article.find('h1').first().text()),
    source_url: url,
    key_info: [],
    sections: [],
    review: null,
    footnotes: [],
    parse_warnings: warnings,
  };

  // --- 주요 정보 네모 ---
  article.find('.openingContent p').each((_, p) => {
    const text = clean($(p).text());
    if (!text) return;
    const i = text.indexOf(':');
    if (i > 0 && i < 20) result.key_info.push({ label: text.slice(0, i).trim(), value: text.slice(i + 1).trim() });
    else result.key_info.push({ label: null, value: text });
  });
  if (!result.key_info.length) warnings.push('주요 정보 네모(.openingContent)를 찾지 못했습니다.');

  // --- 본문 순회 ---
  let section = null;
  let reviewMode = false;
  let reviewGroup = null;
  const openSection = (heading) => {
    section = { heading, items: [] };
    result.sections.push(section);
  };

  const nodes = article.find('h2, p, .boxSupplement, figure').toArray();
  for (const node of nodes) {
    const $n = $(node);

    // 상자 안의 요소는 상자 단위로 처리한다.
    const inBox = $n.parents('.boxSupplement').length > 0;
    if (inBox) continue;
    if ($n.is('.boxSupplement')) {
      const sup = parseSupplement($, node, bookNum, langCode);
      if (reviewMode) continue;
      if (!section) {
        // 머리 부분 상자(성경 책 목록)
        result.header_boxes = result.header_boxes || [];
        result.header_boxes.push(sup);
      } else {
        section.items.push({ type: 'supplement', ...sup });
      }
      continue;
    }

    if ($n.closest('header').length || $n.closest('.openingContent').length) continue;
    if ($n.closest('.gen-field').length || $n.closest('.stdPullQuote').length) continue;
    if ($n.closest('.groupFootnote').length) {
      if ($n.is('p')) result.footnotes.push(clean($n.text()));
      continue;
    }
    if ($n.closest('.alternatePresentation').length) continue;

    if ($n.is('h2')) {
      const heading = clean($n.text());
      if (!heading) continue;
      if ($n.closest('li').length) continue;
      // 끝부분 복습: 다음 형제에 li 목록이 있는 제목
      if ($n.parent().find('li').length) {
        reviewMode = true;
        result.review = { heading, groups: [] };
        continue;
      }
      reviewMode = false;
      openSection(heading);
      continue;
    }

    if ($n.is('figure')) {
      if (reviewMode || !section) continue;
      const caption = clean($n.find('figcaption').text());
      if (caption) section.items.push({ type: 'figure', caption });
      continue;
    }

    // p
    if ($n.closest('figure').length) continue;
    const text = clean($n.text());
    if (!text) continue;

    if (reviewMode || $n.closest('li').length) {
      if (!result.review) result.review = { heading: null, groups: [] };
      const li = $n.closest('li');
      const topLevel = li.parents('li').length === 0;
      const question = () => ({ text, scriptures: collectCitations($, node, bookNum, langCode) });
      if (li.find('li').length) {
        // 소그룹 제목 ("1. 여호와와 더 가까워지세요")
        reviewGroup = { title: text, questions: [] };
        result.review.groups.push(reviewGroup);
      } else if (topLevel) {
        // 하위 질문 없이 그 자체가 질문인 바깥 항목 ("4. 또 어떤 점을 배웠습니까?")
        result.review.groups.push({ title: null, questions: [question()] });
        reviewGroup = null;
      } else {
        if (!reviewGroup) {
          reviewGroup = { title: null, questions: [] };
          result.review.groups.push(reviewGroup);
        }
        reviewGroup.questions.push(question());
      }
      continue;
    }

    if (!section) openSection(null);

    if ($n.is('.qu')) {
      section.items.push({ type: 'question', paragraphs: parseNumbers(text), text });
      continue;
    }

    const pnum = $n.find('span.parNum').attr('data-pnum');
    if (pnum) {
      section.items.push({
        type: 'paragraph',
        number: parseInt(pnum, 10),
        text: text.replace(new RegExp(`^${pnum}\\s+`), ''),
        scriptures: collectCitations($, node, bookNum, langCode),
      });
      continue;
    }

    section.items.push({ type: 'text', text, scriptures: collectCitations($, node, bookNum, langCode) });
  }

  const paraCount = result.sections.flatMap((s) => s.items).filter((i) => i.type === 'paragraph').length;
  const quCount = result.sections.flatMap((s) => s.items).filter((i) => i.type === 'question').length;
  if (!paraCount) warnings.push('번호가 붙은 항을 찾지 못했습니다.');
  if (!quCount) warnings.push('항 질문(p.qu)을 찾지 못했습니다.');
  result.counts = {
    sections: result.sections.length,
    questions: quCount,
    paragraphs: paraCount,
    supplements: result.sections.flatMap((s) => s.items).filter((i) => i.type === 'supplement').length,
    review_questions: result.review ? result.review.groups.reduce((n, g) => n + g.questions.length, 0) : 0,
  };
  return result;
}

/** 항 범위로 자른다. 상자·그림은 범위 안 항 사이에 있는 것만 남긴다. */
export function filterParagraphs(chapter, range) {
  if (!range) return chapter;
  const m = String(range).match(/^\s*(\d+)\s*(?:[-–~]\s*(\d+))?\s*$/);
  if (!m) throw new Error(`paragraphs 형식이 올바르지 않습니다: "${range}" (예: "1-11")`);
  const from = parseInt(m[1], 10);
  const to = m[2] ? parseInt(m[2], 10) : from;

  const maxPara = Math.max(0, ...chapter.sections.flatMap((s) => s.items).filter((i) => i.type === 'paragraph').map((i) => i.number));

  let current = 0;
  const sections = [];
  for (const s of chapter.sections) {
    const items = [];
    for (const item of s.items) {
      if (item.type === 'question') current = item.paragraphs?.[0] ?? current;
      if (item.type === 'paragraph') current = item.number;
      const n = item.type === 'question' ? item.paragraphs?.[0] ?? current : current;
      if (n >= from && n <= to) items.push(item);
    }
    if (items.length) sections.push({ ...s, items });
  }
  return {
    ...chapter,
    sections,
    review: to >= maxPara ? chapter.review : null,
    paragraph_range: `${from}-${to}`,
  };
}

// ============================================================================
// 성구 본문 (선택)
// ============================================================================

function allCitations(chapter) {
  const refs = [];
  for (const s of chapter.sections)
    for (const item of s.items) if (item.scriptures) refs.push(...item.scriptures);
  if (chapter.review) for (const g of chapter.review.groups) for (const q of g.questions) refs.push(...q.scriptures);
  return refs;
}

async function attachVerseTexts(chapter, langCode) {
  const refs = allCitations(chapter).filter((r) => r.book && r.chapter);
  const keys = [...new Set(refs.map((r) => `${r.book}:${r.chapter}`))];
  const fetchKeys = keys.slice(0, MAX_VERSE_CHAPTERS);

  const chapters = new Map();
  await Promise.all(
    fetchKeys.map(async (k) => {
      const [b, c] = k.split(':').map(Number);
      try {
        const content = await scraper.extractChapterContent(b, c, langCode);
        chapters.set(k, content.verses);
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

  chapter.verse_text_info = {
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

export function renderText(ch) {
  const out = [];
  out.push(`# ${ch.chapter_label} ${ch.title} — 「${ch.publication}」`);
  out.push(`출처: ${ch.source_url}`);
  if (ch.paragraph_range) out.push(`범위: ${ch.paragraph_range}항`);
  out.push('');

  out.push('## 성경 각 책의 주요 정보');
  for (const k of ch.key_info) out.push(`- ${k.label ? `${k.label}: ` : ''}${k.value}`);
  for (const b of ch.header_boxes || []) {
    out.push(`- [${b.title}] ${[...b.text, ...b.description].join(' / ')}`);
  }
  out.push('');

  for (const s of ch.sections) {
    if (s.heading) out.push(`## ${s.heading}`);
    for (const item of s.items) {
      if (item.type === 'question') out.push(`\n### 질문 ${item.text}`);
      else if (item.type === 'paragraph') {
        out.push(`[${item.number}항] ${item.text}`);
        out.push(...refsLine(item.scriptures));
      } else if (item.type === 'text') {
        out.push(item.text);
        out.push(...refsLine(item.scriptures));
      } else if (item.type === 'figure') out.push(`(그림 설명) ${item.caption}`);
      else if (item.type === 'supplement') {
        out.push(`\n> 보충 자료 ${item.id ? `${item.id} ` : ''}${item.title}`);
        for (const t of item.text) out.push(`>   ${t}`);
        for (const r of item.rows) out.push(`>   | ${r.join(' | ')} |`);
        for (const d of item.description) out.push(`>   (설명) ${d}`);
        for (const f of item.figures) out.push(`>   (그림) ${f}`);
        for (const lp of item.learning_points) out.push(`>   ★ 배울 수 있는 점 (낭독): ${lp}`);
        out.push(...refsLine(item.scriptures, '>   '));
        out.push('');
      }
    }
    out.push('');
  }

  if (ch.review) {
    out.push(`## ${ch.review.heading || '복습'}`);
    for (const g of ch.review.groups) {
      if (g.title) out.push(`### ${g.title}`);
      for (const q of g.questions) {
        out.push(`- ${q.text}`);
        out.push(...refsLine(q.scriptures, '    '));
      }
    }
    out.push('');
  }

  if (ch.footnotes.length) {
    out.push('## 각주');
    for (const f of ch.footnotes) out.push(`- ${f}`);
    out.push('');
  }

  if (ch.verse_text_info?.note) out.push(`참고: ${ch.verse_text_info.note}`);
  if (ch.parse_warnings.length) out.push(`파싱 경고: ${ch.parse_warnings.join(' / ')}`);
  out.push(
    `요약: 소제목 ${ch.counts.sections}개, 질문 ${ch.counts.questions}개, 항 ${ch.counts.paragraphs}개, ` +
      `보충 자료 ${ch.counts.supplements}개, 복습 질문 ${ch.counts.review_questions}개`,
  );
  return out.join('\n');
}

// ============================================================================
// 목차
// ============================================================================

export function parseToc(html, lang) {
  const $ = cheerio.load(html);
  const docRe = new RegExp(`/wol/d/${lang.rsconf}/${lang.lib}/(\\d+)$`);
  const seen = new Set();
  const items = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    const m = href.match(docRe);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    const docid = parseInt(m[1], 10);
    const title = clean($(a).text());
    const bookNum = docid - DOC_BASE;
    items.push({
      docid,
      title,
      book_num: bookNum >= 1 && bookNum <= 66 ? bookNum : null,
      url: `https://wol.jw.org${href}`,
    });
  });
  return items;
}

async function getChapterList(langwritten) {
  const lang = guideLocale(langwritten);
  const base = `${wolBase(lang)}/publication/${lang.rsconf}/${lang.lib}/${PUB}`;
  const [intro$, books$] = await Promise.all([fetchPage(`${base}/0`), fetchPage(`${base}/4`)]);
  if (!books$) {
    throw new Error(
      `wol.jw.org 에서 「성경 안내서」 목차를 찾지 못했습니다 (${lang.code}). ` +
        '영어 목차 경로는 아직 확인되지 않았습니다 — langwritten "KO" 로 목차를 보고, 장은 E 로도 받을 수 있습니다.',
    );
  }

  const chapters = parseToc(books$.html(), lang).filter((i) => i.book_num && i.docid !== DOC_BASE);
  const intro = intro$ ? parseToc(intro$.html(), lang).filter((i) => !i.book_num || i.docid === DOC_BASE) : [];
  return {
    publication: '하느님의 말씀은 진리입니다—성경 안내서',
    publication_short: '하진',
    symbol: PUB,
    language: lang.code,
    toc_url: `${base}/4`,
    chapters: chapters.sort((a, b) => a.book_num - b.book_num),
    intro_documents: intro,
    note: '이 책은 단계적으로 공개됩니다. 목록에 없는 책은 아직 wol.jw.org 에 공개되지 않은 것입니다.',
  };
}

async function getChapter(args) {
  const lang = guideLocale(args.langwritten || 'KO');
  const bookNum = resolveBook(args.book, lang.code);
  const url = chapterDocUrl(lang, bookNum);
  const $ = await fetchPage(url);
  if (!$) {
    throw new Error(
      `「성경 안내서」의 ${bookLabel(bookNum, lang.code)}(${bookNum}) 장은 아직 wol.jw.org 에 공개되지 않았습니다. ` +
        'get_guidebook_chapter_list 로 공개된 장을 확인하십시오.',
    );
  }

  let chapter = parseGuidebookChapter($.html(), { bookNum, langCode: lang.code, url });
  chapter = filterParagraphs(chapter, args.paragraphs);
  if (args.include_verse_text) await attachVerseTexts(chapter, lang.code);
  return chapter;
}

// ============================================================================
// 핸들러
// ============================================================================

export async function handleGuidebookTools(request) {
  const { name, arguments: args = {} } = request.params;
  if (name !== 'get_guidebook_chapter_list' && name !== 'get_guidebook_chapter') return null;

  try {
    if (name === 'get_guidebook_chapter_list') {
      const list = await getChapterList(args.langwritten || 'KO');
      return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };
    }

    const chapter = await getChapter(args);
    const text = args.format === 'json' ? JSON.stringify(chapter, null, 2) : renderText(chapter);
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
}
