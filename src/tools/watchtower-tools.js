import * as cheerio from 'cheerio';
import fetch from 'node-fetch';

import { fetchPublicationData, downloadRtfContent, getCurrentWatchtowerIssue } from './rtf-utils.js';
import { parseRTF } from './rtf-parser.js';
import { resolveLocale, DEFAULT_LANG } from './wol-locales.js';
import {
  decodeEntities,
  parseWeekRange,
  stripWeekLabel,
  isCurrentWeek,
  structureArticle,
} from './watchtower-structure.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

/**
 * 그 주 파수대 연구 기사의 WOL 문서 링크를 찾는다.
 *
 * pub-media API 는 CDN 의 RTF 주소만 준다. 응답에 `docid` 필드가 있긴 한데 파수대
 * RTF 항목에서는 **전부 0** 이라 쓸 수 없다(실측 확인). 대신 WOL 의 날짜별 집회
 * 페이지(`/wol/dt/{rsconf}/{lib}/{Y}/{M}/{D}`)에 그 주의 파수대 항목이
 * `.todayItem.pub-w` 로 들어 있어, 거기서 문서 링크를 얻는다.
 *
 * 주마다 요청이 한 번씩 나가므로 호출부가 대상 주를 골라 부른다.
 *
 * @returns {Promise<string|null>} 사람이 열 수 있는 WOL URL
 */
export async function resolveWolUrl(weekStart, langwritten = DEFAULT_LANG) {
  if (!weekStart) return null;
  const { locale, rsconf, lib } = resolveLocale(langwritten);
  const [y, m, d] = weekStart.split('-').map((n) => parseInt(n, 10));

  try {
    const res = await fetch(`https://wol.jw.org/${locale}/wol/dt/${rsconf}/${lib}/${y}/${m}/${d}`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
    if (!res.ok) return null;

    const $ = cheerio.load(await res.text());
    const href = $('.todayItem.pub-w').first().find('a[href*="/d/"]').first().attr('href');
    if (!href) return null;

    // 링크에 붙는 `?#h=9:0-11:0` 은 그 주 기사 위치를 가리키는 앵커라 살려 둔다.
    return `https://wol.jw.org${href}`;
  } catch {
    // WOL 이 느리거나 형식이 바뀌어도 나머지 결과는 그대로 쓸모가 있다.
    return null;
  }
}

/**
 * 특정 호의 파수대 연구 기사 목록.
 *
 * 상류 대비 추가된 것:
 *  - `weekStart` / `weekEnd` (ISO) 와 `isCurrentWeek` — 제목 문자열을 소비자가 파싱하지 않아도 된다
 *  - `articleTitle` — 주간 범위 표기를 뗀 제목
 *  - `formattedDate` 의 HTML 엔티티 디코딩 (`"2026년 &nbsp;5월"` → `"2026년 5월"`)
 *  - `wolUrl` — 문서에 넣을 사람이 읽는 링크 (includeWolUrl=true 일 때)
 */
export async function getWatchtowerLinks(
  pub = 'w',
  langwritten = DEFAULT_LANG,
  issue = null,
  fileformat = 'RTF',
  includeWolUrl = true,
) {
  try {
    const finalIssue = issue || getCurrentWatchtowerIssue();
    const { files, pubName, formattedDate, language } = await fetchPublicationData(
      pub,
      langwritten,
      finalIssue,
      fileformat,
    );

    const issueYear = parseInt(String(finalIssue).slice(0, 4), 10);

    // 첫 항목은 전체 ZIP 이라 건너뛴다(상류와 동일).
    const articles = files.slice(1).map((file) => {
      const rawTitle = decodeEntities(file.title);
      const range = parseWeekRange(rawTitle, issueYear);
      return {
        title: rawTitle,
        articleTitle: stripWeekLabel(rawTitle, range),
        weekStart: range?.start ?? null,
        weekEnd: range?.end ?? null,
        isCurrentWeek: isCurrentWeek(range),
        url: file.file.url,
        wolUrl: null,
        filesize: file.filesize,
        track: file.track,
        modifiedDatetime: file.file.modifiedDatetime,
        checksum: file.file.checksum,
      };
    });

    // WOL 링크는 주마다 요청이 한 번씩 나간다. 전부 받으면 8주 × 왕복이라 느려지므로
    // **이번 주 기사만** 해결한다 — 실제로 필요한 것도 그것이다. 이번 주가 없으면
    // (지난 호를 조회한 경우) 주간 기사 중 첫 번째로 대신한다.
    if (includeWolUrl) {
      const target =
        articles.find((a) => a.isCurrentWeek) ?? articles.find((a) => a.weekStart) ?? null;
      if (target) target.wolUrl = await resolveWolUrl(target.weekStart, langwritten);
    }

    return {
      pubName: decodeEntities(pubName),
      formattedDate: decodeEntities(formattedDate),
      issue: finalIssue,
      language,
      currentWeekArticle: articles.find((a) => a.isCurrentWeek)?.title ?? null,
      articles,
    };
  } catch (error) {
    throw new Error(`파수대 목록을 가져오지 못했습니다: ${error.message}`);
  }
}

/**
 * 파수대 기사 본문.
 *
 * `parsedText` 는 그대로 두고 `structured` 를 덧붙인다 — 구조화가 빗나가도 원문은
 * 늘 쓸 수 있어야 하기 때문이다.
 */
export async function getWatchtowerContent(url, { structured = true, langwritten = null, title = '' } = {}) {
  const rtfData = await downloadRtfContent(url);

  try {
    const parsedText = parseRTF(rtfData.content);

    // 언어를 안 줬으면 CDN 파일명에서 유추한다 (w_KO_202605_04.rtf).
    const lang =
      langwritten || (/\/w_([A-Z]+)_/.exec(url)?.[1] ?? DEFAULT_LANG);

    const result = {
      url: rtfData.url,
      contentType: rtfData.contentType,
      originalSize: rtfData.size,
      language: lang,
      parsedText,
      parsedSize: parsedText.length,
    };

    if (structured) {
      // 제목을 따로 안 줬으면 본문 첫 줄이 곧 제목이다.
      const heading = title || parsedText.split('\n').find((l) => l.trim()) || '';
      result.structured = structureArticle(parsedText, heading, lang);
    }

    return result;
  } catch (error) {
    throw new Error(`RTF 본문을 해석하지 못했습니다: ${error.message}`);
  }
}

// Tool definitions for the MCP server
export const watchtowerTools = [
  {
    name: 'getWatchtowerLinks',
    description:
      "STEP 1: Get JW.org Watchtower study articles. When a user asks for current/this week's Watchtower content, use this tool FIRST without any parameters — it automatically picks the right issue (Watchtower study articles are published 2 months ahead, so July 2026 studies come from the May 2026 issue). Each article includes machine-readable weekStart/weekEnd (ISO dates) and isCurrentWeek, so you never have to parse the date out of the title, plus wolUrl — a human-readable wol.jw.org link for the current week's article.",
    inputSchema: {
      type: 'object',
      properties: {
        pub: {
          type: 'string',
          description: 'Publication code: "w" for Watchtower (Study edition)',
          default: 'w',
        },
        langwritten: {
          type: 'string',
          description: 'Language code: "E" English, "KO" Korean, "S" Spanish, etc.',
          default: 'E',
        },
        issue: {
          type: 'string',
          description:
            'Issue in YYYYMM00 format. Leave empty for the current study articles (the server calculates it — Watchtower studies run 2 months after the issue date)',
        },
        fileformat: {
          type: 'string',
          description: 'File format: "RTF" for Rich Text Format',
          default: 'RTF',
        },
        includeWolUrl: {
          type: 'boolean',
          description:
            "Resolve wolUrl (a readable wol.jw.org link) for the current week's article. Costs one extra request. Default: true",
          default: true,
        },
      },
      required: [],
    },
  },
  {
    name: 'getWatchtowerContent',
    description:
      'STEP 2: Get the actual Watchtower article content after the user chooses an article. Takes the RTF URL from getWatchtowerLinks, downloads and converts it to clean plain text (parsedText), and additionally returns a `structured` object that recovers the article\'s shape: paragraph numbers with their questions, section headings and the paragraphs they cover, theme scripture, key-point box, opening/closing songs, read-aloud scriptures, footnotes and the review box. Use `structured` to build study notes; fall back to `parsedText` when you need the raw wording.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The RTF file URL from getWatchtowerLinks results (e.g. "https://cfp2.jw-cdn.org/a/...")',
        },
        structured: {
          type: 'boolean',
          description:
            'Include the `structured` breakdown (paragraphs, questions, sections, songs, footnotes). Set false to save tokens when you only need the plain text. Default: true',
          default: true,
        },
        title: {
          type: 'string',
          description:
            'Optional article title from getWatchtowerLinks. Improves weekRange detection in `structured`; inferred from the content when omitted.',
        },
        langwritten: {
          type: 'string',
          description: 'Language code of the article. Inferred from the URL when omitted.',
        },
      },
      required: ['url'],
    },
  },
];

// Tool handlers
export async function handleWatchtowerTools(request) {
  if (request.params.name === 'getWatchtowerLinks') {
    try {
      const { pub, langwritten, issue, fileformat, includeWolUrl } = request.params.arguments || {};
      const result = await getWatchtowerLinks(
        pub,
        langwritten,
        issue,
        fileformat,
        includeWolUrl !== false,
      );
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }

  if (request.params.name === 'getWatchtowerContent') {
    try {
      const { url, structured, title, langwritten } = request.params.arguments || {};

      if (!url) {
        return {
          content: [{ type: 'text', text: 'Error: URL parameter is required' }],
          isError: true,
        };
      }

      const result = await getWatchtowerContent(url, {
        structured: structured !== false,
        title,
        langwritten,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  }

  return null;
}
