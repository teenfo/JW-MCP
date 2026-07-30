/**
 * WOL (Watchtower Online Library) 스크레이퍼.
 *
 * wol.jw.org 의 신세계역(연구용) 페이지에서 본문·연구 노트·상호 참조·장 개요를 뽑는다.
 *
 * ## WOL DOM 에서 반드시 알아야 할 것
 *
 * 절은 `<span class="v" id="v{책}-{장}-{절}-{행}">` 이다. **id 의 마지막 조각은 행 번호**이고,
 * 시가서(시편·잠언·욥기…)는 한 절이 여러 행으로 쪼개져 **절마다 span 이 여러 개**다.
 * 잠언 13장은 25절이 span 50개로 나온다. 산문책은 절당 1개다.
 *
 * 상류 구현은 이 구조를 몰라 span 하나를 절 하나로 취급했고, `getSingleVerse` 가
 * `.find()` 로 **첫 행만** 집어 반환했다 — 잠언 13:20 은 대조가 핵심인 절인데 앞 절반만
 * 나와 뜻이 반대로 전달될 수 있었다. 지금은 같은 절의 행을 전부 모아 합친다.
 *
 * 상호 참조는 본문에 `<a class="b" data-bid=... href="/{loc}/wol/bc/...">+</a>` 마커로만
 * 있고 대상 성구는 **지연 로딩**이다. 마커 href 를 따라가야 실제 인용을 얻는다.
 *
 * 장 개요는 `ul.outline` 이며 `#studyDiscover` **바깥**에 있다 — 상류가 안쪽에서
 * 찾다가 항상 빈 배열을 돌려주던 이유다.
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { getBookName } from './bible-books.js';
import { chapterUrl, resolveLocale, absoluteUrl, DEFAULT_LANG } from './wol-locales.js';

/** 상호 참조 마커를 몇 개까지 따라갈지. 마커마다 요청 1회라 상한이 필요하다. */
const MAX_CROSSREF_FETCHES = 12;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

/** 상호 참조 마커(+)와 각주 마커(*)를 본문에서 떼어낸다. */
export function stripMarkers(text) {
  return String(text)
    .replace(/[+*]/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export class WOLScraper {
  constructor() {
    this.headers = { 'User-Agent': USER_AGENT };
  }

  async fetchHtml(url) {
    const response = await fetch(url, { headers: this.headers, timeout: 30000 });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return cheerio.load(await response.text());
  }

  /**
   * 한 장의 모든 내용을 뽑는다.
   *
   * @param {number} bookNum 성경 책 번호 (1-66)
   * @param {number} chapterNum 장
   * @param {string} langwritten 언어 코드 (기본 E)
   */
  async extractChapterContent(bookNum, chapterNum, langwritten = DEFAULT_LANG) {
    const lang = resolveLocale(langwritten);
    const url = chapterUrl(langwritten, bookNum, chapterNum);

    try {
      const $ = await this.fetchHtml(url);
      const studyDiscover = $('#studyDiscover');

      return {
        language: lang.code,
        url,
        chapter_study_data: {
          book_num: bookNum,
          chapter_num: chapterNum,
          // 개요는 studyDiscover 밖에 있으므로 문서 전체에서 찾는다.
          outline: this.extractOutline($),
          study_articles: studyDiscover.length ? this.extractResearchGuideArticles($, studyDiscover) : [],
        },
        verse_study_notes: this.extractVerseStudyNotes($, bookNum, chapterNum),
        verses: this.extractVerses($, bookNum, chapterNum),
      };
    } catch (error) {
      throw new Error(`${bookNum}:${chapterNum} (${lang.code}) 내용을 가져오지 못했습니다 — ${error.message}`);
    }
  }

  /**
   * 절을 뽑는다. 같은 절의 여러 행을 **하나의 절로 합친다.**
   *
   * 반환 항목마다 `lines[]` 로 원래 행 구분을 함께 준다 — 시 형식을 살려 인용하려는
   * 소비자를 위해서다. `verse_text` 는 합친 본문, `verse_text_plain` 은 참조 마커(+)와
   * 각주 마커(*)를 뗀 것이다.
   */
  extractVerses($, bookNum, chapterNum) {
    const byVerse = new Map();
    const bookName = this.extractBookName($, bookNum);

    $('span.v').each((i, elem) => {
      const verseId = $(elem).attr('id');
      if (!verseId) return;

      // v{책}-{장}-{절}-{행}  — 마지막 조각이 행 번호다(없을 수도 있다).
      const parts = verseId.replace(/^v/, '').split('-').map((n) => parseInt(n, 10));
      if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return;

      const [vBook, vChapter, vVerse] = parts;
      if (vBook !== bookNum || vChapter !== chapterNum) return;

      const text = $(elem).text().trim();
      if (!text) return;

      if (!byVerse.has(vVerse)) {
        byVerse.set(vVerse, {
          book_num: bookNum,
          book_name: bookName,
          chapter: chapterNum,
          verse_num: vVerse,
          lines: [],
          // 이 절이 가진 상호 참조 마커의 href — cross_references 를 요청할 때만 따라간다.
          _refHrefs: [],
        });
      }

      const verse = byVerse.get(vVerse);
      verse.lines.push(text);
      $(elem)
        .find('a.b[href]')
        .each((j, a) => verse._refHrefs.push($(a).attr('href')));
    });

    return [...byVerse.values()]
      .sort((a, b) => a.verse_num - b.verse_num)
      .map((v) => {
        const joined = v.lines.join(' ').replace(/\s{2,}/g, ' ').trim();
        return {
          ...v,
          verse_text: joined,
          // 첫 행 맨 앞의 절 번호는 표시용이라 평문에서는 뗀다.
          verse_text_plain: stripMarkers(joined.replace(new RegExp(`^${v.verse_num}\\s+`), '')),
          line_count: v.lines.length,
        };
      });
  }

  extractBookName($, bookNum) {
    const title = $('title').text();
    if (title && title.includes('—')) {
      const name = title.split('—')[0].trim();
      // "잠언 13" / "Proverbs 13" 에서 장 번호를 뗀다.
      return name.replace(/\s*\d+\s*$/, '').trim() || getBookName(bookNum) || 'Unknown';
    }
    return getBookName(bookNum) || 'Unknown';
  }

  extractVerseStudyNotes($, bookNum, chapterNum) {
    const verseNotes = {};

    $('div.section[data-key]').each((i, section) => {
      const parts = ($(section).attr('data-key') || '').split('-').map((n) => parseInt(n, 10));
      if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return;

      const [sectionBook, sectionChapter, sectionVerse] = parts;
      if (sectionBook !== bookNum || sectionChapter !== chapterNum) return;

      const studyNotes = [];
      $(section)
        .find('div.studyNoteGroup li.item.studyNote')
        .each((k, note) => {
          const noteContent = [];
          $(note)
            .find('p')
            .each((l, p) => {
              const pText = $(p).text().trim();
              if (pText) noteContent.push(pText);
            });
          if (noteContent.length) studyNotes.push(noteContent.join(' '));
        });

      if (studyNotes.length) verseNotes[sectionVerse] = studyNotes;
    });

    return verseNotes;
  }

  /**
   * 장 개요.
   *
   * `ul.outline` 은 중첩 목록이라 li 의 텍스트를 그대로 쓰면 상위 항목에 하위 항목이
   * 전부 딸려 들어온다("솔로몬의 잠언 (10:1–24:34)지혜를 구하는 사람은…"). 자식 목록을
   * 떼고 **자기 텍스트만** 취한 뒤, 중첩 깊이를 level 로 남긴다.
   */
  extractOutline($) {
    const outline = [];
    const root = $('.outline').first();
    if (!root.length) return outline;

    root.find('li').each((i, li) => {
      const own = $(li).clone().children('ul, ol').remove().end().text().trim().replace(/\s+/g, ' ');
      if (!own) return; // 자식만 담은 래퍼 li

      // 끝의 "(10)" / "(1-14)" / "(10:1–24:34)" 는 그 항목이 다루는 절 범위다.
      const range = /\(([\d\s:–—-]+)\)\s*$/.exec(own);
      outline.push({
        text: own,
        heading: range ? own.slice(0, range.index).trim() : own,
        verses: range ? range[1].trim() : null,
        _depth: $(li).parents('li').length,
      });
    });

    // 내용 없는 래퍼 li 를 건너뛰면 DOM 깊이에 구멍이 생긴다(0 다음에 2). 실제로 쓰인
    // 깊이만 모아 0,1,2… 로 다시 매겨 소비자가 들여쓰기를 그대로 쓸 수 있게 한다.
    const depths = [...new Set(outline.map((o) => o._depth))].sort((a, b) => a - b);
    return outline.map(({ _depth, ...o }) => ({ ...o, level: depths.indexOf(_depth) }));
  }

  extractResearchGuideArticles($, studyDiscover) {
    const articles = [];

    const classify = (url, title) => {
      const u = url.toLowerCase();
      const t = title.toLowerCase();
      if (u.includes('watchtower') || t.includes('watchtower')) return 'watchtower';
      if (u.includes('awake') || t.includes('awake')) return 'awake';
      if (u.includes('/pc/') || u.includes('/d/')) return 'research';
      return 'other';
    };

    studyDiscover.find('li.item.ref-rsg').each((itemIndex, item) => {
      const paragraphs = $(item).find('p').toArray();
      let i = 0;

      while (i < paragraphs.length) {
        const p = paragraphs[i];
        const classes = ($(p).attr('class') || '').toLowerCase();

        if (classes.includes('su')) {
          const suAnchors = $(p).find('a[href]').toArray();

          if (suAnchors.length > 0) {
            const suLabel = suAnchors
              .map((a) => $(a).text().trim())
              .filter(Boolean)
              .join(' ');

            let added = false;
            let j = i + 1;

            while (j < paragraphs.length) {
              const nextClasses = ($(paragraphs[j]).attr('class') || '').toLowerCase();
              if (!nextClasses.includes('sk')) break;

              for (const a of $(paragraphs[j]).find('a[href]').toArray()) {
                const href = $(a).attr('href') || '';
                const text = $(a).text().trim();
                if (!href || !text) continue;
                const title = `${suLabel} ${text}`.trim();
                articles.push({ title, url: absoluteUrl(href), type: classify(href, title) });
                added = true;
              }
              j++;
            }

            if (added) {
              i = j - 1;
            } else {
              for (const a of suAnchors) {
                const href = $(a).attr('href') || '';
                const text = $(a).text().trim();
                if (!href || !text) continue;
                articles.push({ title: text, url: absoluteUrl(href), type: classify(href, text) });
              }
            }
          }
        }
        i++;
      }
    });

    return articles;
  }

  /**
   * 상호 참조를 실제로 가져온다.
   *
   * 본문의 `+` 마커는 링크일 뿐이고 대상 성구는 별도 페이지에 있다. 마커마다 요청이
   * 한 번씩 나가므로 **요청된 절의 마커만**, 그것도 상한을 두고 따라간다. 실패한
   * 마커는 통째로 버리지 않고 건너뛴다 — 하나가 죽어도 나머지는 쓸모가 있다.
   *
   * @param {string[]} hrefs 마커의 상대 경로
   * @returns {Promise<Array<{citation: string, url: string}>>}
   */
  async fetchCrossReferences(hrefs, { limit = MAX_CROSSREF_FETCHES } = {}) {
    const unique = [...new Set(hrefs.filter(Boolean))].slice(0, limit);

    const settled = await Promise.allSettled(
      unique.map(async (href) => {
        const $ = await this.fetchHtml(absoluteUrl(href));
        // bc 페이지의 결과 목록. 첫 링크가 인용 표기("Acts 4:13" / "사도행전 4:13")다.
        const anchor = $('ul.results a[href*="/b/"]').first();
        // 앵커 안에는 인용 표기 다음 줄에 출판물명("신세계역 성경 (연구용)")이 따라온다.
        // 통째로 공백 정규화하면 그게 인용에 눌어붙으므로 **첫 줄만** 취한다.
        const citation = anchor
          .text()
          .split('\n')
          .map((l) => l.trim())
          .find(Boolean);
        if (!citation) return null;
        return { citation, url: absoluteUrl(anchor.attr('href')) };
      }),
    );

    return settled.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
  }

  /** 절 하나를 가져온다 — 시가서에서도 모든 행이 합쳐진 온전한 본문을 준다. */
  async getSingleVerse(bookNum, chapterNum, verseNum, langwritten = DEFAULT_LANG) {
    const content = await this.extractChapterContent(bookNum, chapterNum, langwritten);
    const verse = content.verses.find((v) => v.verse_num === verseNum);
    if (!verse) throw new Error(`${bookNum}:${chapterNum}:${verseNum} 절을 찾지 못했습니다.`);

    const { _refHrefs, ...clean } = verse;
    return { ...clean, language: content.language, url: content.url };
  }

  /**
   * 절 + 연구 자료.
   *
   * @param {Object} options
   * @param {string[]} options.fields verses | combined_text | study_notes | study_articles |
   *                                  cross_references | chapter_level
   * @param {number|null} options.limit 목록형 필드의 상한 (chapter_level 에도 적용된다)
   * @param {string} options.langwritten 언어 코드
   */
  async getVerseWithStudy(bookNum, chapterNum, verseInput, options = {}) {
    const { fields = ['verses', 'study_notes'], limit = null, langwritten = DEFAULT_LANG } = options;

    let verseStart;
    let verseEnd;
    if (typeof verseInput === 'string' && verseInput.includes('-')) {
      const [a, b] = verseInput.split('-');
      verseStart = parseInt(a, 10);
      verseEnd = parseInt(b, 10);
    } else {
      verseStart = verseEnd = parseInt(verseInput, 10);
    }
    if (Number.isNaN(verseStart) || Number.isNaN(verseEnd)) {
      throw new Error(`절 형식이 올바르지 않습니다: "${verseInput}" (예: "16" 또는 "3-5")`);
    }

    const content = await this.extractChapterContent(bookNum, chapterNum, langwritten);
    const versesInRange = content.verses.filter((v) => v.verse_num >= verseStart && v.verse_num <= verseEnd);

    const result = {
      book_num: bookNum,
      book_name: content.verses[0]?.book_name || getBookName(bookNum),
      chapter: chapterNum,
      verse_range: verseStart === verseEnd ? `${verseStart}` : `${verseStart}-${verseEnd}`,
      language: content.language,
      url: content.url,
    };

    // 목록형 필드에 공통으로 적용할 상한. chapter_level 도 예외가 아니다 —
    // 상류는 여기에만 limit 을 안 걸어 장 색인 57개가 통째로 나왔다.
    const cap = (arr) => (limit && arr.length > limit ? arr.slice(0, limit) : arr);

    if (fields.includes('verses')) {
      // _refHrefs 는 내부용이라 응답에서 뺀다.
      result.verses = versesInRange.map(({ _refHrefs, ...v }) => v);
    }

    if (fields.includes('combined_text')) {
      result.combined_text = versesInRange.map((v) => v.verse_text).join(' ');
      result.combined_text_plain = versesInRange.map((v) => v.verse_text_plain).join(' ');
    }

    if (fields.includes('study_notes')) {
      result.study_notes = {};
      for (let v = verseStart; v <= verseEnd; v++) {
        if (content.verse_study_notes[v]) result.study_notes[v] = content.verse_study_notes[v];
      }
    }

    if (fields.includes('study_articles')) {
      result.study_articles = cap(content.chapter_study_data.study_articles);
    }

    if (fields.includes('cross_references')) {
      const hrefs = versesInRange.flatMap((v) => v._refHrefs);
      const refs = await this.fetchCrossReferences(hrefs);
      result.cross_references = refs;
      result.cross_references_count = refs.length;
      if (hrefs.length > MAX_CROSSREF_FETCHES) {
        result.cross_references_truncated = {
          markers_found: hrefs.length,
          markers_followed: MAX_CROSSREF_FETCHES,
          note: '마커마다 요청이 한 번씩 나가 상한을 둡니다. 절 범위를 좁히면 전부 받을 수 있습니다.',
        };
      }
    }

    if (fields.includes('chapter_level')) {
      result.chapter_level = {
        outline: content.chapter_study_data.outline,
        study_articles: cap(content.chapter_study_data.study_articles),
        study_articles_total: content.chapter_study_data.study_articles.length,
      };
    }

    return result;
  }
}

export const scraper = new WOLScraper();
