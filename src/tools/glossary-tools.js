/**
 * 「신세계역 성경」 연구용 "용어 설명" (기호 nwtstg) 도구.
 *
 * ## 왜 따로 있는가
 *
 * 범용 도구로도 용어 설명을 읽을 수는 있다 — get_wol_publication_toc("nwtstg", 그룹) 로
 * 자음 그룹(ㄱ, ㄴ …)을 열고 get_wol_document 로 문서를 받는다. 그런데 용어 하나를 찾는 데
 * 목차 1회 + 문서 1회가 들고, 어느 자음 그룹인지도 미리 알아야 한다. wol.jw.org 가 느린 날은
 * 목차 호출만으로 20초 상한에 걸린다(2026-11-06 실측: 14개 그룹 중 여러 개가 시간 초과).
 *
 * 그래서 **용어 이름 → 문서 번호 색인**만 저장소에 두고(`data/glossary-index-ko.json`),
 * 설명 본문은 언제나 wol.jw.org 에서 그때그때 받는다. 색인에는 제목과 번호만 있고
 * 원문 텍스트는 넣지 않는다 — 저장소에 원문을 두지 않는다는 원칙 그대로다.
 *
 * ## 색인 갱신
 *
 * `node scripts/build-glossary-index.js` — wol.jw.org 목차를 모두 열어 색인을 다시 만든다.
 * 신세계역 개정으로 용어가 늘거나 문서 번호가 바뀌면 이걸 돌린다. 색인에 없는 번호로
 * 받은 문서가 404 이면 도구가 그 사실과 갱신 방법을 알려 준다.
 *
 * ## 제목 형태 (실측)
 *
 * - "기적; 강력한 일"       — 같은 문서를 가리키는 두 표제어. ';' 로 나눈다.
 * - "기둥(1)", "기둥(2)"    — 동음이의어. 괄호 숫자를 떼면 같은 이름 → 둘 다 돌려준다.
 * - "고대 근동(중동)"       — 괄호 안이 별칭.
 * - "요세푸스, 플라비우스"  — 인명(성, 이름). 앞부분도 별칭으로 받는다.
 *
 * ## 본문 속 용어 찾기
 *
 * 한국어는 조사가 붙으므로("게헨나에", "영혼이") **어절 머리**에서 일치하는지 본다 —
 * 앞 글자가 한글이 아니어야 한다. 한 글자 표제어("의", "영", "경", "겨")는 거의 모든 문장에
 * 걸리므로 기본으로 제외한다(min_length). 겹치면 긴 쪽을 남긴다("영매술" ⊃ "영매").
 *
 * 모든 요청은 safe-fetch.js 를 거쳐 wol.jw.org 에서만 가져온다.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveLocale } from './wol-locales.js';
import { getWolDocument, docUrl } from './wol-document.js';

export const SYMBOL = 'nwtstg';
export const PUBLICATION = '신세계역 성경 (연구용) — 용어 설명';

/** 색인을 실측으로 만든 언어만. 다른 언어는 build 스크립트로 색인을 만든 뒤 넣는다. */
export const GLOSSARY_LANGS = ['KO'];

/** 한 번에 본문을 받아 오는 최대 문서 수 — 문서마다 wol.jw.org 요청 1회. */
export const MAX_DEFINITION_FETCHES = 8;

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_FILES = { KO: join(HERE, 'data', 'glossary-index-ko.json') };

// ============================================================================
// 색인
// ============================================================================

const indexCache = new Map();

/** 색인 파일을 읽는다. 테스트는 entries 를 직접 넘겨 buildIndex 를 쓴다. */
export function loadIndex(langCode = 'KO') {
  if (indexCache.has(langCode)) return indexCache.get(langCode);
  const file = INDEX_FILES[langCode];
  if (!file) throw new Error(`용어 설명 색인은 ${GLOSSARY_LANGS.join(', ')} 만 있습니다 (요청: ${langCode}).`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const index = buildIndex(raw.terms, raw);
  indexCache.set(langCode, index);
  return index;
}

/** 공백·가운뎃점 차이를 무시하고 비교한다. */
export function normalize(s) {
  return String(s || '').replace(/[\s·・]/g, '').toLowerCase();
}

/**
 * 표제어 하나에서 찾아볼 이름들을 만든다.
 * "기적; 강력한 일" → ["기적", "강력한 일"], "기둥(1)" → ["기둥"],
 * "고대 근동(중동)" → ["고대 근동", "중동"], "요세푸스, 플라비우스" → ["요세푸스, 플라비우스", "요세푸스"]
 */
export function titleAliases(title) {
  const out = [];
  for (const part0 of String(title).split(/\s*;\s*/)) {
    let part = part0.trim();
    if (!part) continue;
    const paren = part.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    if (paren) {
      part = paren[1].trim();
      if (!/^\d+$/.test(paren[2].trim())) out.push(paren[2].trim());
    }
    out.push(part);
    const comma = part.match(/^([^,]+),\s*\S/);
    if (comma) out.push(comma[1].trim());
  }
  return [...new Set(out.filter(Boolean))];
}

/** 한글 글자 수 (본문 검색에서 너무 짧은 표제어를 거르는 데 쓴다). */
function hangulLength(s) {
  return (String(s).match(/[가-힣]/g) || []).length;
}

export function buildIndex(terms, meta = {}) {
  const entries = terms.map((t) => ({ ...t, aliases: titleAliases(t.title) }));
  const byName = new Map();
  for (const e of entries) {
    for (const a of e.aliases) {
      const k = normalize(a);
      if (!byName.has(k)) byName.set(k, []);
      if (!byName.get(k).includes(e)) byName.get(k).push(e);
    }
  }
  return { meta, entries, byName };
}

/**
 * 이름으로 용어를 찾는다. 정확히 일치하는 것이 있으면 그것만, 없으면 비슷한 것을 점수순으로.
 * @returns {{ exact: object[], similar: object[] }}
 */
export function findTerms(index, query, { limit = 8 } = {}) {
  const q = normalize(query);
  if (!q) return { exact: [], similar: [] };
  const exact = index.byName.get(q) || [];
  if (exact.length) return { exact, similar: [] };

  const scored = [];
  for (const e of index.entries) {
    let best = 0;
    for (const a of e.aliases) {
      const n = normalize(a);
      if (n.startsWith(q) || q.startsWith(n)) best = Math.max(best, 3 - Math.abs(n.length - q.length) / 10);
      else if (n.includes(q) || (q.length >= 2 && q.includes(n) && n.length >= 2)) best = Math.max(best, 2);
    }
    if (best > 0) scored.push({ e, best });
  }
  scored.sort((a, b) => b.best - a.best || a.e.title.length - b.e.title.length);
  return { exact: [], similar: scored.slice(0, limit).map((s) => s.e) };
}

const HANGUL = /[가-힣]/;

/**
 * 글 속에 나오는 용어 설명 표제어를 찾는다 (네트워크 없음).
 * 어절 머리에서만 일치로 친다(앞 글자가 한글이 아님). 겹치면 긴 쪽을 남긴다.
 * @returns {Array<{entry, matched, count, context}>}  처음 나온 순서
 */
export function findTermsInText(index, text, { minLength = 2 } = {}) {
  const src = String(text || '');
  const candidates = [];
  for (const e of index.entries) {
    for (const a of e.aliases) {
      if (hangulLength(a) < minLength && !/[a-z]{3,}/i.test(a)) continue;
      let from = 0;
      for (;;) {
        const i = src.indexOf(a, from);
        if (i < 0) break;
        from = i + 1;
        if (i > 0 && HANGUL.test(src[i - 1])) continue; // 어절 중간 ("목동"의 "동" 같은 것)
        candidates.push({ start: i, end: i + a.length, entry: e, matched: a });
      }
    }
  }

  // 긴 일치부터 자리를 차지한다.
  candidates.sort((x, y) => y.end - y.start - (x.end - x.start) || x.start - y.start);
  const taken = [];
  const kept = [];
  for (const c of candidates) {
    if (taken.some(([s, t]) => c.start < t && s < c.end)) continue;
    taken.push([c.start, c.end]);
    kept.push(c);
  }
  kept.sort((x, y) => x.start - y.start);

  const byDoc = new Map();
  for (const c of kept) {
    const key = c.entry.docid;
    if (!byDoc.has(key)) {
      const s = Math.max(0, c.start - 20);
      const t = Math.min(src.length, c.end + 20);
      byDoc.set(key, { entry: c.entry, matched: c.matched, count: 0, context: `${s > 0 ? '…' : ''}${src.slice(s, t).replace(/\s+/g, ' ')}${t < src.length ? '…' : ''}` });
    }
    byDoc.get(key).count += 1;
  }
  return [...byDoc.values()];
}

// ============================================================================
// 본문
// ============================================================================

/** 용어 문서 하나의 설명을 wol.jw.org 에서 받아 간단한 모양으로. */
export async function fetchDefinition(entry, langCode = 'KO') {
  const lang = resolveLocale(langCode);
  try {
    const doc = await getWolDocument({ docid: entry.docid, langwritten: lang.code });
    return definitionFromDoc(doc, entry);
  } catch (e) {
    if (/없습니다/.test(e.message)) {
      throw new Error(
        `"${entry.title}"(문서 ${entry.docid}) 를 wol.jw.org 에서 찾지 못했습니다. 색인이 낡았을 수 있습니다 — ` +
          'scripts/build-glossary-index.js 로 색인을 다시 만드십시오.',
      );
    }
    throw e;
  }
}

/** parseWolDocument 결과 → { title, text[], scriptures[], see_also[], url } */
export function definitionFromDoc(doc, entry = {}) {
  const items = doc.sections.flatMap((s) => s.items);
  const text = [];
  const scriptures = [];
  for (const i of items) {
    if (i.type === 'figure' || i.type === 'supplement') continue;
    if (i.text) text.push(i.text);
    for (const r of i.scriptures || []) {
      const label = r.book && r.chapter ? `${r.book_name} ${r.chapter}:${r.verses}` : r.text;
      if (label && !scriptures.includes(label)) scriptures.push(label);
    }
  }
  // "—부록 나5 참조." / "용어 설명의 "…" 참조." 같은 꼬리는 따로 모아 둔다(본문에서 지우지는 않는다).
  const seeAlso = [];
  for (const t of text) for (const m of t.matchAll(/—\s*([^—]*?참조)\.?/g)) seeAlso.push(m[1].trim());

  return {
    title: entry.title || doc.title,
    docid: doc.docid || entry.docid,
    url: doc.source_url,
    text,
    scriptures,
    see_also: seeAlso,
    ...(doc.parse_warnings?.length ? { parse_warnings: doc.parse_warnings } : {}),
  };
}

export function renderDefinition(d) {
  const out = [`## ${d.title}`, ...d.text];
  if (d.scriptures.length) out.push(`성구: ${d.scriptures.join('; ')}`);
  out.push(`출처: ${d.url}`);
  return out.join('\n');
}

/** 여러 용어를 병렬로 받는다. 실패한 것은 이유와 함께 남긴다. */
async function fetchMany(entries, langCode) {
  return Promise.all(
    entries.map(async (e) => {
      try {
        return { entry: e, def: await fetchDefinition(e, langCode) };
      } catch (err) {
        return { entry: e, error: err.message };
      }
    }),
  );
}

// ============================================================================
// 도구
// ============================================================================

const langSchema = {
  type: 'string',
  description: `언어 코드 (기본 "KO"). 색인이 있는 언어: ${GLOSSARY_LANGS.join(', ')}.`,
  default: 'KO',
};

export const lookupGlossaryTermTool = {
  name: 'lookup_glossary_term',
  description:
    '「신세계역 성경」 연구용 "용어 설명"(nwtstg)에서 용어 하나의 설명을 wol.jw.org 에서 가져옵니다. ' +
    '자음 그룹이나 문서 번호를 몰라도 이름으로 바로 찾습니다(예: "게헨나", "영혼", "고통의 기둥", "데나리온", "임재"). ' +
    '정확히 일치하는 표제어가 없으면 비슷한 표제어 목록을 돌려줍니다. 동음이의어("기둥(1)", "기둥(2)")는 모두 돌려줍니다.',
  inputSchema: {
    type: 'object',
    properties: {
      term: { type: 'string', description: '찾을 용어 (예: "게헨나")' },
      format: { type: 'string', enum: ['text', 'json'], default: 'text' },
      langwritten: langSchema,
    },
    required: ['term'],
  },
};

export const findGlossaryTermsInTextTool = {
  name: 'find_glossary_terms_in_text',
  description:
    '성구 본문·연설 원고·해설 같은 글을 넘기면, 그 안에 나오는 "용어 설명"(nwtstg) 표제어를 찾아 줍니다. ' +
    '주간 성경 읽기 범위에서 배경 설명이 필요한 단어를 고르거나, 해설에서 용어를 바르게 썼는지 확인할 때 씁니다. ' +
    '기본은 목록만 돌려주며(네트워크 없음), include_definitions=true 면 앞쪽 용어의 설명 본문도 wol.jw.org 에서 함께 가져옵니다' +
    `(최대 ${MAX_DEFINITION_FETCHES}개). 한 글자 표제어("의", "영" 등)는 기본으로 제외합니다.`,
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '용어를 찾을 글' },
      include_definitions: { type: 'boolean', default: false, description: '설명 본문도 가져올지' },
      max_definitions: { type: 'number', default: MAX_DEFINITION_FETCHES, description: `본문을 가져올 최대 용어 수 (≤ ${MAX_DEFINITION_FETCHES})` },
      min_length: { type: 'number', default: 2, description: '찾을 표제어의 최소 한글 글자 수 (기본 2)' },
      format: { type: 'string', enum: ['text', 'json'], default: 'text' },
      langwritten: langSchema,
    },
    required: ['text'],
  },
};

export const listGlossaryTermsTool = {
  name: 'list_glossary_terms',
  description:
    '"용어 설명"(nwtstg)의 표제어 목록을 돌려줍니다(네트워크 없음). consonant 로 자음 그룹(예: "ㄱ")만 볼 수 있습니다.',
  inputSchema: {
    type: 'object',
    properties: {
      consonant: { type: 'string', description: '자음 그룹 (예: "ㄱ", "ㅎ"). 생략하면 전체.' },
      langwritten: langSchema,
    },
    required: [],
  },
};

export const glossaryTools = [lookupGlossaryTermTool, findGlossaryTermsInTextTool, listGlossaryTermsTool];
const NAMES = new Set(glossaryTools.map((t) => t.name));

function glossaryLang(langwritten = 'KO') {
  const lang = resolveLocale(langwritten);
  if (!GLOSSARY_LANGS.includes(lang.code)) {
    throw new Error(`용어 설명 색인은 ${GLOSSARY_LANGS.join(', ')} 만 있습니다 (요청: ${langwritten}).`);
  }
  return lang;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });

async function lookup(args) {
  const lang = glossaryLang(args.langwritten);
  const index = loadIndex(lang.code);
  const { exact, similar } = findTerms(index, args.term);

  const targets = exact.length ? exact : similar.length === 1 ? similar : [];
  const fetched = await fetchMany(targets.slice(0, MAX_DEFINITION_FETCHES), lang.code);
  const result = {
    query: args.term,
    publication: PUBLICATION,
    found: fetched.filter((f) => f.def).map((f) => f.def),
    errors: fetched.filter((f) => f.error).map((f) => ({ title: f.entry.title, error: f.error })),
    similar: targets.length ? [] : similar.map((e) => ({ title: e.title, docid: e.docid, consonant: e.consonant })),
  };
  if (args.format === 'json') return text(JSON.stringify(result, null, 2));

  const out = [];
  if (!result.found.length && !result.errors.length) {
    out.push(`"${args.term}" 와 정확히 일치하는 표제어가 용어 설명에 없습니다.`);
    if (result.similar.length) out.push(`비슷한 표제어: ${result.similar.map((s) => s.title).join(', ')}`);
    return text(out.join('\n'));
  }
  for (const d of result.found) out.push(renderDefinition(d), '');
  for (const e of result.errors) out.push(`(${e.title}: ${e.error})`);
  return text(out.join('\n').trim());
}

async function findInText(args) {
  const lang = glossaryLang(args.langwritten);
  const index = loadIndex(lang.code);
  const hits = findTermsInText(index, args.text, { minLength: args.min_length ?? 2 });

  const limit = Math.max(0, Math.min(MAX_DEFINITION_FETCHES, args.max_definitions ?? MAX_DEFINITION_FETCHES));
  const fetched = args.include_definitions ? await fetchMany(hits.slice(0, limit).map((h) => h.entry), lang.code) : [];
  const defs = new Map(fetched.map((f) => [f.entry.docid, f]));

  const terms = hits.map((h) => {
    const f = defs.get(h.entry.docid);
    return {
      title: h.entry.title,
      matched: h.matched,
      count: h.count,
      context: h.context,
      docid: h.entry.docid,
      url: docUrl(lang, h.entry.docid),
      ...(f?.def ? { definition: f.def.text, scriptures: f.def.scriptures } : {}),
      ...(f?.error ? { error: f.error } : {}),
    };
  });

  if (args.format === 'json') return text(JSON.stringify({ publication: PUBLICATION, count: terms.length, terms }, null, 2));
  if (!terms.length) return text('글 안에서 용어 설명 표제어를 찾지 못했습니다.');

  const out = [`용어 설명 표제어 ${terms.length}개 (나온 순서)`];
  for (const t of terms) {
    out.push(`\n- ${t.title}${t.matched !== t.title ? ` (글에서: "${t.matched}")` : ''} ×${t.count} — ${t.context}`);
    if (t.definition) out.push(...t.definition.map((d) => `  ${d}`));
    if (t.scriptures?.length) out.push(`  성구: ${t.scriptures.join('; ')}`);
    if (t.definition || t.error) out.push(`  출처: ${t.url}`);
    if (t.error) out.push(`  (${t.error})`);
  }
  if (args.include_definitions && terms.length > limit) {
    out.push(`\n앞의 ${limit}개만 설명을 가져왔습니다. 나머지는 lookup_glossary_term 으로 보십시오.`);
  }
  return text(out.join('\n'));
}

function list(args) {
  const lang = glossaryLang(args.langwritten);
  const index = loadIndex(lang.code);
  const c = args.consonant?.trim();
  const entries = c ? index.entries.filter((e) => e.consonant === c) : index.entries;
  if (c && !entries.length) throw new Error(`자음 그룹 "${c}" 이 없습니다. ㄱ ㄴ ㄷ ㄹ ㅁ ㅂ ㅅ ㅇ ㅈ ㅊ ㅋ ㅌ ㅍ ㅎ 중 하나입니다.`);
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.consonant)) groups.set(e.consonant, []);
    groups.get(e.consonant).push(e.title);
  }
  const out = [`${PUBLICATION} — 표제어 ${entries.length}개 (색인 ${index.meta.built || '?'})`];
  for (const [k, titles] of groups) out.push(`\n[${k}] ${titles.join(', ')}`);
  return text(out.join('\n'));
}

export async function handleGlossaryTools(request) {
  const { name, arguments: args = {} } = request.params;
  if (!NAMES.has(name)) return null;
  try {
    if (name === 'lookup_glossary_term') return await lookup(args);
    if (name === 'find_glossary_terms_in_text') return await findInText(args);
    return list(args);
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
}
