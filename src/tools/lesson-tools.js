// 자료는 wol.jw.org 에서만 가져온다 — 범용 문서 도구(→ safe-fetch.js)를 거친다.
import { getWolDocument, getPublicationToc } from './wol-document.js';

/**
 * Get lesson content tool definition
 */
export const getLessonTool = {
  name: 'get_lesson_content',
  description: '「하느님의 교훈이 담긴 성경 이야기 (훈)」 특정 과의 내용을 가져옵니다. 1-103장까지 있습니다 (wol.jw.org 목차 기준).',
  inputSchema: {
    type: 'object',
    properties: {
      lesson_number: {
        type: 'number',
        description: '과 번호 (1-103)',
        minimum: 1,
        maximum: 103
      },
      language: {
        type: 'string',
        description: '언어 코드 (기본값: ko)',
        enum: ['ko', 'en'],
        default: 'ko'
      }
    },
    required: ['lesson_number'],
  },
};

/**
 * Get lesson list tool definition
 */
export const getLessonListTool = {
  name: 'get_lesson_list',
  description: '「하느님의 교훈이 담긴 성경 이야기 (훈)」 전체 목록을 가져옵니다.',
  inputSchema: {
    type: 'object',
    properties: {
      language: {
        type: 'string',
        description: '언어 코드 (기본값: ko)',
        enum: ['ko', 'en'],
        default: 'ko'
      },
      start: {
        type: 'number',
        description: '시작 과 번호 (기본값: 1)',
        minimum: 1,
        maximum: 103,
        default: 1
      },
      end: {
        type: 'number',
        description: '끝 과 번호 (기본값: 103)',
        minimum: 1,
        maximum: 103,
        default: 103
      }
    },
    required: [],
  },
};

/**
 * 「훈」(lfb) 과 → 문서.
 *
 * 예전 구현은 문서 번호를 `1102016000 + 과` 로 계산했지만 실제 1과는 1102016011 이고
 * 표지·차례·부 소개 문서가 중간에 끼어 번호가 연속되지도 않는다 — 그래서 모든 과가
 * "not found" 로 실패했다(2026-11-06 확인). 지금은 wol.jw.org 목차에서 "N장" 제목으로
 * 문서를 찾는 범용 도구(wol-document.js)를 쓴다.
 */
const LFB = 'lfb';
const langOf = (language) => (language === 'en' ? 'E' : 'KO');

async function fetchLessonContent(lessonNumber, language = 'ko') {
  const doc = await getWolDocument({ symbol: LFB, number: lessonNumber, langwritten: langOf(language) });
  const items = doc.sections.flatMap((s) => s.items);
  const content = items
    .filter((i) => i.type === 'text' || i.type === 'paragraph')
    .map((i) => i.text)
    .join('\n\n');
  const refs = [...new Set(items.flatMap((i) => i.scriptures || []).map((r) => r.text))];
  return {
    lesson_number: lessonNumber,
    lesson_label: doc.label,
    title: doc.title,
    content,
    scripture_reference: refs.join('; '),
    questions: items.filter((i) => i.type === 'question').map((i) => i.text),
    url: doc.source_url,
  };
}

/** 목차에서 과 목록을 만든다 (그룹이 있으면 모두 연다). */
async function fetchLessonList(start = 1, end = 103, language = 'ko') {
  const langwritten = langOf(language);
  const first = await getPublicationToc({ symbol: LFB, langwritten });
  const docs = [...first.documents];
  for (const g of first.groups) {
    if (String(g.group) === '0') continue;
    docs.push(...(await getPublicationToc({ symbol: LFB, group: g.group, langwritten })).documents);
  }
  const byNumber = new Map();
  for (const d of docs) if (d.number && !byNumber.has(d.number)) byNumber.set(d.number, d);
  const lessons = [];
  for (let n = start; n <= end; n++) {
    const d = byNumber.get(n);
    lessons.push(d ? { lesson_number: n, title: d.title, url: d.url } : { lesson_number: n, error: '목차에 없음' });
  }
  return lessons;
}

/**
 * Export all lesson tools
 */
export const lessonTools = [getLessonTool, getLessonListTool];

/**
 * Handle lesson tool requests
 */
export async function handleLessonTools(request) {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'get_lesson_content') {
      const { lesson_number, language = 'ko' } = args;
      
      if (!lesson_number || lesson_number < 1 || lesson_number > 103) {
        throw new Error('lesson_number must be between 1 and 103');
      }

      const lesson = await fetchLessonContent(lesson_number, language);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(lesson, null, 2),
          },
        ],
      };
    }

    if (name === 'get_lesson_list') {
      const { language = 'ko', start = 1, end = 103 } = args;
      
      if (start < 1 || start > 103 || end < 1 || end > 103 || start > end) {
        throw new Error('Invalid start/end range. Must be between 1-103');
      }

      const lessons = await fetchLessonList(start, end, language);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(lessons, null, 2),
          },
        ],
      };
    }

    return null; // Not our tool, let other handlers try
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
}
