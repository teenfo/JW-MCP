/**
 * 「하느님의 말씀은 진리입니다—성경 안내서」 (기호 gwt, 한국어 약칭 「하진」) 도구.
 *
 * 범용 WOL 문서 도구(wol-document.js) 위의 **얇은 층**이다. 파싱은 전부 범용 파서가 하고,
 * 여기서는 이 책에만 있는 것만 더한다.
 *
 * - 장 = 성경 책 한 권. 문서 번호는 `1102026500 + 책 번호` (에스겔 26 → 1102026526).
 *   그래서 책 이름·번호로 장을 고를 수 있다. 공개 전인 책은 404 가 난다.
 * - 책 이름 없는 성구 인용("36:22")은 그 장의 책이다 → 범용 파서의 defaultBook.
 * - 여는 상자의 이름은 "성경 각 책의 주요 정보" 네모다 (장로용 사회 지침의 표현).
 * - 이 책은 단계적으로 공개된다 (2026-11-06 기준 에스겔·다니엘·호세아·요엘).
 *   목차는 그룹 구조라 그룹을 모두 열어 장 문서를 모은다.
 *
 * 모든 요청은 safe-fetch.js 를 거쳐 wol.jw.org 에서만 가져온다.
 */

import { resolveLocale } from './wol-locales.js';
import {
  getWolDocument,
  getPublicationToc,
  renderDocumentText,
  resolveBook,
  bookLabel,
  MAX_VERSE_CHAPTERS,
} from './wol-document.js';

export const SYMBOL = 'gwt';
export const DOC_BASE = 1102026500;
export const PUBLICATION = '하느님의 말씀은 진리입니다—성경 안내서';
export const OPENING_LABEL = '성경 각 책의 주요 정보';

/** 실측해서 장이 파싱되는 것을 확인한 언어만 넣는다 (wol-locales.js 와 같은 원칙). */
export const GUIDEBOOK_LANGS = ['KO', 'E'];

const langSchema = {
  type: 'string',
  description: `언어 코드 (기본 "KO" = 한국어). 지원: ${GUIDEBOOK_LANGS.join(', ')}.`,
  default: 'KO',
};

export const getGuidebookChapterListTool = {
  name: 'get_guidebook_chapter_list',
  description:
    '「하느님의 말씀은 진리입니다—성경 안내서」(gwt, 「하진」)에서 현재 wol.jw.org 에 공개된 장(성경 책) 목록을 가져옵니다. ' +
    '이 책은 단계적으로 공개됩니다. 책 번호를 get_guidebook_chapter 에 넘기면 됩니다.',
  inputSchema: { type: 'object', properties: { langwritten: langSchema }, required: [] },
};

export const getGuidebookChapterTool = {
  name: 'get_guidebook_chapter',
  description:
    '「하느님의 말씀은 진리입니다—성경 안내서」(「하진」)의 한 장을 wol.jw.org 에서 가져와 회중 성서 연구 사회 준비용으로 구조화합니다. ' +
    '"성경 각 책의 주요 정보" 네모, 소제목, 항별 질문과 항 본문, 각 항의 인용 성구(책·장·절), ' +
    '보충 자료(표·연대표·지도·도해 설명과 낭독할 "배울 수 있는 점"), 끝부분 질문, 각주를 돌려줍니다. ' +
    '장은 성경 책 번호(예: 26 = 에스겔) 또는 책 이름으로 지정합니다. get_wol_document 와 같은 파서를 씁니다.',
  inputSchema: {
    type: 'object',
    properties: {
      book: { type: ['number', 'string'], description: '성경 책 번호(1-66) 또는 이름·약칭. 예: 26, "에스겔", "겔", "Ezekiel"' },
      paragraphs: { type: 'string', description: '돌려받을 항 범위 (예: "1-11"). 생략하면 장 전체.' },
      include_verse_text: {
        type: 'boolean',
        description: `인용 성구의 신세계역 본문도 가져옵니다 (기본 false, 성경 장 ${MAX_VERSE_CHAPTERS}개까지). paragraphs 와 함께 쓰십시오.`,
        default: false,
      },
      format: { type: 'string', enum: ['text', 'json'], description: '"text"(기본) 또는 "json"', default: 'text' },
      langwritten: langSchema,
    },
    required: ['book'],
  },
};

export const guidebookTools = [getGuidebookChapterListTool, getGuidebookChapterTool];

function guideLang(langwritten = 'KO') {
  const lang = resolveLocale(langwritten);
  if (!GUIDEBOOK_LANGS.includes(lang.code)) {
    throw new Error(`「성경 안내서」는 ${GUIDEBOOK_LANGS.join(', ')} 만 지원합니다 (요청: ${langwritten}).`);
  }
  return lang;
}

async function getChapterList(langwritten = 'KO') {
  const lang = guideLang(langwritten);
  let first;
  try {
    first = await getPublicationToc({ symbol: SYMBOL, langwritten: lang.code });
  } catch (e) {
    throw new Error(`${e.message} 영어 목차 경로는 확인되지 않았습니다 — 목차는 langwritten "KO" 로 보고, 장은 E 로도 받을 수 있습니다.`);
  }

  const docs = [...first.documents];
  for (const g of first.groups) {
    if (String(g.group) === '0') continue;
    const toc = await getPublicationToc({ symbol: SYMBOL, group: g.group, langwritten: lang.code });
    docs.push(...toc.documents);
  }

  const seen = new Set();
  const chapters = [];
  const intro = [];
  for (const d of docs) {
    if (seen.has(d.docid)) continue;
    seen.add(d.docid);
    const bookNum = d.docid - DOC_BASE;
    if (bookNum >= 1 && bookNum <= 66) chapters.push({ book_num: bookNum, title: d.title, docid: d.docid, url: d.url });
    else intro.push({ title: d.title, docid: d.docid, url: d.url });
  }

  return {
    publication: PUBLICATION,
    publication_short: '하진',
    symbol: SYMBOL,
    language: lang.code,
    toc_url: first.toc_url,
    chapters: chapters.sort((a, b) => a.book_num - b.book_num),
    intro_documents: intro,
    note: '이 책은 단계적으로 공개됩니다. 목록에 없는 책은 아직 wol.jw.org 에 공개되지 않은 것입니다.',
  };
}

export async function getGuidebookChapter(args) {
  const lang = guideLang(args.langwritten || 'KO');
  const bookNum = resolveBook(args.book, lang.code);
  try {
    const doc = await getWolDocument({
      docid: DOC_BASE + bookNum,
      paragraphs: args.paragraphs,
      include_verse_text: args.include_verse_text,
      langwritten: lang.code,
      defaultBook: bookNum,
    });
    return { publication: PUBLICATION, publication_short: '하진', book_num: bookNum, ...doc, key_info: doc.opening };
  } catch (e) {
    if (/없습니다/.test(e.message) && /문서/.test(e.message)) {
      throw new Error(
        `「성경 안내서」의 ${bookLabel(bookNum, lang.code)}(${bookNum}) 장은 아직 wol.jw.org 에 공개되지 않았습니다. ` +
          'get_guidebook_chapter_list 로 공개된 장을 확인하십시오.',
      );
    }
    throw e;
  }
}

export function renderGuidebookText(ch) {
  return renderDocumentText(ch, {
    heading: `# ${[ch.label, ch.title].filter(Boolean).join(' ')} — 「${PUBLICATION}」`,
    opening: OPENING_LABEL,
  });
}

export async function handleGuidebookTools(request) {
  const { name, arguments: args = {} } = request.params;
  if (name !== 'get_guidebook_chapter_list' && name !== 'get_guidebook_chapter') return null;

  try {
    if (name === 'get_guidebook_chapter_list') {
      return { content: [{ type: 'text', text: JSON.stringify(await getChapterList(args.langwritten), null, 2) }] };
    }
    const ch = await getGuidebookChapter(args);
    const text = args.format === 'json' ? JSON.stringify(ch, null, 2) : renderGuidebookText(ch);
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
}
