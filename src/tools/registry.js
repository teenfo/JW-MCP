/**
 * 도구 레지스트리 — 도구 목록과 핸들러의 유일한 정의처.
 *
 * stdio 진입점(src/index.js)과 HTTP 진입점(src/http-server.js)이 **둘 다 이 파일만**
 * import 한다. 상류 저장소는 두 진입점이 각자 allTools 배열을 들고 있어, 도구를 추가할
 * 때 한쪽만 고치면 조용히 누락되는 구조였다(실제로 lesson-tools 2종이 HTTP 서버에서만
 * 빠져 있었다). 정의를 한 곳으로 모아 그 사고 자체를 불가능하게 만든다.
 */

import { captionsTool, handleCaptionsTool } from './captions-tool.js';
import { workbookTools, handleWorkbookTools } from './workbook-tools.js';
import { watchtowerTools, handleWatchtowerTools } from './watchtower-tools.js';
import {
  searchBibleBooksTool,
  getBibleVerseTool,
  getVerseWithStudyTool,
  getBibleVerseURLTool,
  handleScriptureTools,
} from './scripture-tools.js';
import { lessonTools, handleLessonTools } from './lesson-tools.js';

/** MCP tools/list 에 노출되는 전체 도구 정의. */
export const allTools = [
  captionsTool,
  ...workbookTools,
  ...watchtowerTools,
  searchBibleBooksTool,
  getBibleVerseTool,
  getVerseWithStudyTool,
  getBibleVerseURLTool,
  ...lessonTools,
];

/** 각 핸들러는 자기 도구가 아니면 null 을 반환한다(상류 규약). */
const toolHandlers = [
  handleCaptionsTool,
  handleWorkbookTools,
  handleWatchtowerTools,
  handleScriptureTools,
  handleLessonTools,
];

/** 도구 이름 → 존재 여부. 인증 계층이 미지의 도구를 빠르게 거르는 데 쓴다. */
export const toolNames = new Set(allTools.map((t) => t.name));

/**
 * 도구 호출을 라우팅한다. 어떤 핸들러도 받지 않으면 isError 응답.
 *
 * jw.org(wol.jw.org)는 10~15초까지 걸리는 일이 흔하고, 응답이 아예 돌아오지 않으면
 * MCP 요청이 무한정 매달린다. 상류에는 타임아웃이 없어 여기서 상한을 씌운다.
 */
export async function callTool(request, { timeoutMs = 20000 } = {}) {
  const run = (async () => {
    for (const handler of toolHandlers) {
      const result = await handler(request);
      if (result !== null && result !== undefined) return result;
    }
    return {
      content: [{ type: 'text', text: `Unknown tool: ${request.params?.name}` }],
      isError: true,
    };
  })();

  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`도구 '${request.params?.name}' 이(가) ${timeoutMs}ms 안에 끝나지 않았습니다 (jw.org 응답 지연).`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([run, guard]);
  } finally {
    clearTimeout(timer);
  }
}
