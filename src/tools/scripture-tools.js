/**
 * Scripture Tools for JW-MCP
 * Provides Bible verse lookup and study content from wol.jw.org
 */

import { scraper } from './wol-scraper.js';
import { SUPPORTED_LANGS, DEFAULT_LANG, resolveLocale } from './wol-locales.js';
import { searchLocalizedBooks, getLocalizedBookName } from './bible-books-i18n.js';
import {
  searchBooks,
  getBookName,
  getBookNumber,
  formatReference,
  validateReference,
  BIBLE_BOOKS
} from './bible-books.js';

// 네 도구가 같은 인자를 쓰도록 스키마 조각을 공유한다. 파수대·워크북 도구의
// langwritten 과 이름·값이 같아야 한 작업에서 언어를 섞지 않고 쓸 수 있다.
const langSchema = {
  type: 'string',
  description:
    `Language code for the content (default "${DEFAULT_LANG}" = English). ` +
    `Supported: ${SUPPORTED_LANGS.join(', ')}. Use "KO" for Korean (한국어 신세계역). ` +
    'Same values as the langwritten parameter on the Watchtower/Workbook tools.',
  default: DEFAULT_LANG,
};

// ============================================================================
// Tool 1: search_bible_books
// ============================================================================

export const searchBibleBooksTool = {
  name: 'search_bible_books',
  description: 'Search for Bible books by name or abbreviation and get their book number (1-66), which the other scripture tools require. Searches English names/abbreviations and, when langwritten is set, that language\'s names and abbreviations too. Examples: "matt" -> Matthew (40), "잠언" or "잠" (with langwritten "KO") -> 잠언 (20), "1 john" -> 1 John (62).',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query - can be book name, abbreviation, or number. Examples: "matthew", "matt", "mt", "40", "1 john"'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
        default: 10
      },
      langwritten: langSchema
    },
    required: ['query']
  }
};

export async function searchBibleBooksImplementation(query, limit = 10, langwritten = DEFAULT_LANG) {
  try {
    if (!query || typeof query !== 'string') {
      return {
        content: [{
          type: 'text',
          text: 'Error: Query must be a non-empty string'
        }],
        isError: true
      };
    }

    // 영어 이름/약칭과 요청 언어의 이름/약칭을 함께 찾고 번호로 합친다.
    // 한쪽만 쓰면 "Proverbs"(영어명)와 "잠"(한국어 약칭)이 서로 안 걸린다.
    const merged = new Map();
    for (const r of searchBooks(query, 66)) {
      merged.set(r.number, { number: r.number, name: r.name, score: r.score, matched: r.name });
    }
    for (const r of searchLocalizedBooks(query, langwritten, 66)) {
      const prev = merged.get(r.number);
      if (!prev || r.score > prev.score) merged.set(r.number, r);
    }

    const results = [...merged.values()]
      .sort((a, b) => b.score - a.score || a.number - b.number)
      .slice(0, limit);

    if (results.length === 0) {
      const hint = langwritten && langwritten.toUpperCase() !== DEFAULT_LANG
        ? ''
        : ' 한국어 책 이름으로 찾으려면 langwritten="KO" 를 함께 보내세요.';
      return {
        content: [{
          type: 'text',
          text: `No Bible books found matching "${query}". Try a book name, abbreviation, or number (1-66).${hint}`
        }]
      };
    }

    const formattedResults = results.map(r => ({
      number: r.number,
      name: r.name,
      localized_name: getLocalizedBookName(r.number, langwritten),
      testament: r.number <= 39 ? 'Old Testament' : 'New Testament',
      matched: r.matched,
      relevance_score: r.score
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: query,
          language: String(langwritten || DEFAULT_LANG).toUpperCase(),
          results_count: formattedResults.length,
          books: formattedResults
        }, null, 2)
      }]
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error searching Bible books: ${error.message}`
      }],
      isError: true
    };
  }
}

// ============================================================================
// Tool 2: get_bible_verse
// ============================================================================

export const getBibleVerseTool = {
  name: 'get_bible_verse',
  description: 'Get plain Bible verse text (New World Translation, Study Edition) from wol.jw.org. Returns the COMPLETE verse — poetic books such as Psalms and Proverbs are stored as separate lines on WOL and are joined here, so contrast verses come back whole. For study notes and cross-references use get_verse_with_study instead.',
  inputSchema: {
    type: 'object',
    properties: {
      book: {
        type: 'number',
        description: 'Bible book number (1-66). Examples: Genesis=1, Matthew=40, John=43, Revelation=66. Use search_bible_books to find book numbers.'
      },
      chapter: {
        type: 'number',
        description: 'Chapter number within the book'
      },
      verse: {
        type: 'number',
        description: 'Verse number within the chapter'
      },
      langwritten: langSchema
    },
    required: ['book', 'chapter', 'verse']
  }
};

export async function getBibleVerseImplementation(book, chapter, verse, langwritten = DEFAULT_LANG) {
  try {
    // Validate inputs
    const validation = validateReference(book, chapter, verse);
    if (!validation.valid) {
      return {
        content: [{
          type: 'text',
          text: `Validation error: ${validation.error}`
        }],
        isError: true
      };
    }

    const verseData = await scraper.getSingleVerse(book, chapter, verse, langwritten);
    const reference = formatReference(book, chapter, verse);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          reference: reference,
          localized_reference: `${verseData.book_name} ${chapter}:${verse}`,
          book_number: verseData.book_num,
          book_name: verseData.book_name,
          chapter: verseData.chapter,
          verse: verseData.verse_num,
          language: verseData.language,
          // text 는 상호 참조(+)·각주(*) 마커를 포함한 원문, text_plain 은 뗀 것.
          // 문서에 그대로 인용할 때는 text_plain 을 쓴다.
          text: verseData.verse_text,
          text_plain: verseData.verse_text_plain,
          // 시 형식 절의 행 구분. 산문책은 항상 1행이다.
          lines: verseData.lines,
          line_count: verseData.line_count,
          url: verseData.url
        }, null, 2)
      }]
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error fetching verse: ${error.message}`
      }],
      isError: true
    };
  }
}

// ============================================================================
// Tool 3: get_verse_with_study
// ============================================================================

export const getVerseWithStudyTool = {
  name: 'get_verse_with_study',
  description: 'Get Bible verse(s) with comprehensive study content from wol.jw.org. Supports single verses or ranges (e.g., "14-16"). Returns verse text, study notes, cross-references, research articles from the Research Guide, and chapter outlines. Field selection allows you to customize what content is returned.',
  inputSchema: {
    type: 'object',
    properties: {
      book: {
        type: 'number',
        description: 'Bible book number (1-66). Use search_bible_books to find book numbers.'
      },
      chapter: {
        type: 'number',
        description: 'Chapter number within the book'
      },
      verse: {
        type: 'string',
        description: 'Single verse number (e.g., "14") or verse range (e.g., "14-16")'
      },
      fields: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['verses', 'study_notes', 'study_articles', 'cross_references', 'chapter_level', 'combined_text']
        },
        description: 'Content fields to include. Options: "verses" (verse text), "study_notes" (verse-specific notes), "study_articles" (research guide articles), "cross_references" (related scriptures), "chapter_level" (outline and chapter content), "combined_text" (all verses as single text). Default: ["verses", "study_notes"]',
        default: ['verses', 'study_notes']
      },
      limit: {
        type: 'number',
        description: 'Maximum number of items for list-type fields. Applies to study_articles AND chapter_level.study_articles (the chapter index can be 50+ entries). Default: 5.',
        default: 5
      },
      langwritten: langSchema,
      fetch: {
        type: 'boolean',
        description: 'Force fresh data from wol.jw.org (useful when content appears to be missing). Default: false',
        default: false
      }
    },
    required: ['book', 'chapter', 'verse']
  }
};

export async function getVerseWithStudyImplementation(book, chapter, verse, fields = ['verses', 'study_notes'], limit = 5, fetch = false, langwritten = DEFAULT_LANG) {
  try {
    // Validate inputs
    const validation = validateReference(book, chapter, verse);
    if (!validation.valid) {
      return {
        content: [{
          type: 'text',
          text: `Validation error: ${validation.error}`
        }],
        isError: true
      };
    }

    // Validate fields
    const validFields = ['verses', 'study_notes', 'study_articles', 'cross_references', 'chapter_level', 'combined_text'];
    const invalidFields = fields.filter(f => !validFields.includes(f));
    if (invalidFields.length > 0) {
      return {
        content: [{
          type: 'text',
          text: `Invalid fields: ${invalidFields.join(', ')}. Valid fields are: ${validFields.join(', ')}`
        }],
        isError: true
      };
    }

    // Fetch verse with study content
    const studyData = await scraper.getVerseWithStudy(book, chapter, verse, {
      fields: fields,
      limit: limit,
      langwritten: langwritten
    });

    // Format reference
    const reference = formatReference(book, chapter, studyData.verse_range);

    // Build response
    const response = {
      reference: reference,
      localized_reference: `${studyData.book_name} ${chapter}:${studyData.verse_range}`,
      book_number: studyData.book_num,
      book_name: studyData.book_name,
      chapter: studyData.chapter,
      verse_range: studyData.verse_range,
      language: studyData.language,
      url: studyData.url
    };

    // Add requested fields
    if (studyData.verses) {
      response.verses = studyData.verses;
    }

    if (studyData.combined_text) {
      response.combined_text = studyData.combined_text;
      response.combined_text_plain = studyData.combined_text_plain;
    }

    if (studyData.study_notes) {
      response.study_notes = studyData.study_notes;
      response.study_notes_count = Object.keys(studyData.study_notes).length;
    }

    if (studyData.study_articles) {
      response.study_articles = studyData.study_articles;
      response.study_articles_count = studyData.study_articles.length;
    }

    if (studyData.cross_references) {
      response.cross_references = studyData.cross_references;
      response.cross_references_count = studyData.cross_references_count;
      if (studyData.cross_references_truncated) {
        response.cross_references_truncated = studyData.cross_references_truncated;
      }
    }

    if (studyData.chapter_level) {
      response.chapter_level = studyData.chapter_level;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }]
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error fetching verse with study content: ${error.message}`
      }],
      isError: true
    };
  }
}

// ============================================================================
// Tool 4: get_bible_verse_url
// ============================================================================

export const getBibleVerseURLTool = {
  name: 'get_bible_verse_url',
  description: 'Get the jw.org URL for a Bible verse or range of verses. Returns a direct link to view the scripture on jw.org. Supports single verses (e.g., verse: "18"), verse ranges (e.g., verse: "14-16"), and comma-separated verses (e.g., verse: "1,3,5" - will convert to range if contiguous). Use search_bible_books to find book numbers. Perfect for adding clickable scripture links to markdown documents.',
  inputSchema: {
    type: 'object',
    properties: {
      book: {
        type: 'number',
        description: 'Bible book number (1-66). Examples: Genesis=1, Psalms=19, Isaiah=23, Matthew=40, Revelation=66. Use search_bible_books to find book numbers.'
      },
      chapter: {
        type: 'number',
        description: 'Chapter number within the book'
      },
      verse: {
        type: 'string',
        description: 'Optional verse reference. Can be: single verse ("18"), verse range ("14-16"), or comma-separated verses ("1,3,5"). If omitted, returns URL for the entire chapter.'
      },
      langwritten: langSchema
    },
    required: ['book', 'chapter']
  }
};

export async function getBibleVerseURLImplementation(book, chapter, verse, langwritten = DEFAULT_LANG) {
  try {
    // Validate the reference (use verse 1 if no verse provided for validation)
    const verseForValidation = verse ? (verse.toString().split(/[-,]/)[0]) : 1;
    const validation = validateReference(book, chapter, parseInt(verseForValidation));
    if (!validation.valid) {
      return {
        content: [{
          type: 'text',
          text: `Validation error: ${validation.error}`
        }],
        isError: true
      };
    }

    // Format book and chapter with zero-padding
    const bookNum = book.toString();
    const chapterNum = chapter.toString().padStart(3, '0');

    let bibleParam;
    let verseDisplay;

    if (verse) {
      // Parse verse parameter
      const verseStr = verse.toString();

      // Check if it contains a comma (multiple verses)
      if (verseStr.includes(',')) {
        const verseArray = verseStr.split(',').map(v => parseInt(v.trim())).sort((a, b) => a - b);

        // Check if verses are contiguous
        const isContiguous = verseArray.every((v, i) => i === 0 || v === verseArray[i - 1] + 1);

        if (isContiguous && verseArray.length > 1) {
          // Convert to range
          const startVerse = verseArray[0].toString().padStart(3, '0');
          const endVerse = verseArray[verseArray.length - 1].toString().padStart(3, '0');
          bibleParam = `${bookNum}${chapterNum}${startVerse}-${bookNum}${chapterNum}${endVerse}`;
          verseDisplay = `${verseArray[0]}-${verseArray[verseArray.length - 1]}`;
        } else {
          // Use just the first verse for non-contiguous
          const firstVerse = verseArray[0].toString().padStart(3, '0');
          bibleParam = `${bookNum}${chapterNum}${firstVerse}`;
          verseDisplay = verseArray[0].toString();
        }
      }
      // Check if it contains a dash (range)
      else if (verseStr.includes('-')) {
        const [startVerse, endVerse] = verseStr.split('-').map(v => v.trim());
        const startVersePadded = startVerse.padStart(3, '0');
        const endVersePadded = endVerse.padStart(3, '0');
        bibleParam = `${bookNum}${chapterNum}${startVersePadded}-${bookNum}${chapterNum}${endVersePadded}`;
        verseDisplay = `${startVerse}-${endVerse}`;
      }
      // Single verse
      else {
        const versePadded = verseStr.padStart(3, '0');
        bibleParam = `${bookNum}${chapterNum}${versePadded}`;
        verseDisplay = verseStr;
      }
    } else {
      // Chapter only (no verse specified)
      bibleParam = `${bookNum}${chapterNum}`;
      verseDisplay = null;
    }

    // wtlocale 은 언어 인자를 따라간다. 상류는 여기가 E 로 고정이라, 한국어로
    // 조회한 구절도 링크만 영어로 열리는 불일치가 있었다.
    const lang = resolveLocale(langwritten);
    const url = `https://www.jw.org/finder?wtlocale=${lang.code}&prefer=lang&bible=${bibleParam}&pub=nwtsty`;

    return {
      content: [{
        type: 'text',
        text: url
      }]
    };

  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Error generating Bible verse URL: ${error.message}`
      }],
      isError: true
    };
  }
}

// ============================================================================
// Tool Handler
// ============================================================================

export async function handleScriptureTools(request) {
  const toolName = request.params.name;
  const args = request.params.arguments;

  switch (toolName) {
    case 'search_bible_books':
      return await searchBibleBooksImplementation(
        args.query,
        args.limit,
        args.langwritten
      );

    case 'get_bible_verse':
      return await getBibleVerseImplementation(
        args.book,
        args.chapter,
        args.verse,
        args.langwritten
      );

    case 'get_verse_with_study':
      return await getVerseWithStudyImplementation(
        args.book,
        args.chapter,
        args.verse,
        args.fields,
        args.limit,
        args.fetch,
        args.langwritten
      );

    case 'get_bible_verse_url':
      return await getBibleVerseURLImplementation(
        args.book,
        args.chapter,
        args.verse,
        args.langwritten
      );

    default:
      return null;
  }
}
