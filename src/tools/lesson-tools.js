import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://wol.jw.org';
const LESSON_BASE_ID = 1102016000;

/**
 * Get lesson content tool definition
 */
export const getLessonTool = {
  name: 'get_lesson_content',
  description: '「하느님의 교훈이 담긴 성경 이야기 (훈)」 특정 과의 내용을 가져옵니다. 1-116과까지 지원합니다.',
  inputSchema: {
    type: 'object',
    properties: {
      lesson_number: {
        type: 'number',
        description: '과 번호 (1-116)',
        minimum: 1,
        maximum: 116
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
        maximum: 116,
        default: 1
      },
      end: {
        type: 'number',
        description: '끝 과 번호 (기본값: 116)',
        minimum: 1,
        maximum: 116,
        default: 116
      }
    },
    required: [],
  },
};

/**
 * Fetch lesson content from wol.jw.org
 */
async function fetchLessonContent(lessonNumber, language = 'ko') {
  const langCode = language === 'ko' ? 'r8/lp-ko' : 'r1/lp-e';
  const docId = LESSON_BASE_ID + lessonNumber;
  const url = `${BASE_URL}/${language}/wol/d/${langCode}/${docId}`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JW-MCP/1.0)',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Lesson ${lessonNumber} not found`);
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    
    // Extract title
    const title = $('article h2').first().text().trim();
    
    // Extract lesson number from page
    const lessonLabel = $('article p.themeScrp').first().text().trim();
    
    // Extract main content
    const contentParagraphs = [];
    $('article .bodyTxt p').each((i, elem) => {
      const text = $(elem).text().trim();
      if (text) {
        contentParagraphs.push(text);
      }
    });

    // Extract scripture reference if exists
    const scriptureRef = $('article p.sb').last().text().trim();

    return {
      lesson_number: lessonNumber,
      lesson_label: lessonLabel,
      title: title,
      content: contentParagraphs.join('\n\n'),
      scripture_reference: scriptureRef,
      url: url
    };
  } catch (error) {
    throw error;
  }
}

/**
 * Fetch multiple lesson titles
 */
async function fetchLessonList(start = 1, end = 116, language = 'ko') {
  const lessons = [];
  
  // Fetch lessons in parallel (with limit to avoid overwhelming server)
  const batchSize = 10;
  for (let i = start; i <= end; i += batchSize) {
    const batch = [];
    const batchEnd = Math.min(i + batchSize - 1, end);
    
    for (let j = i; j <= batchEnd; j++) {
      batch.push(
        fetchLessonContent(j, language)
          .then(lesson => ({
            lesson_number: lesson.lesson_number,
            lesson_label: lesson.lesson_label,
            title: lesson.title,
            url: lesson.url
          }))
          .catch(error => ({
            lesson_number: j,
            error: error.message
          }))
      );
    }
    
    const results = await Promise.all(batch);
    lessons.push(...results);
    
    // Small delay between batches
    if (batchEnd < end) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
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
      
      if (!lesson_number || lesson_number < 1 || lesson_number > 116) {
        throw new Error('lesson_number must be between 1 and 116');
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
      const { language = 'ko', start = 1, end = 116 } = args;
      
      if (start < 1 || start > 116 || end < 1 || end > 116 || start > end) {
        throw new Error('Invalid start/end range. Must be between 1-116');
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
