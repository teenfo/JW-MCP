/**
 * 도구 레지스트리 단위 테스트 — 네트워크 없이 도는 것만 다룬다.
 *
 * 상류 저장소는 stdio/HTTP 두 진입점이 각자 도구 배열을 들고 있어 조용히 어긋났다
 * (lesson 도구 2종이 HTTP 서버에서만 빠져 있었다). 여기서 그 계약을 못 박는다.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { allTools, toolNames, callTool } from '../src/tools/registry.js';

test('도구 11종이 모두 등록된다', () => {
  assert.equal(allTools.length, 11);
});

test('상류에서 HTTP 서버에 누락됐던 lesson 도구가 포함된다', () => {
  assert.ok(toolNames.has('get_lesson_content'));
  assert.ok(toolNames.has('get_lesson_list'));
});

test('모든 도구가 name·description·inputSchema 를 갖는다', () => {
  for (const tool of allTools) {
    assert.ok(tool.name, `name 없음: ${JSON.stringify(tool).slice(0, 80)}`);
    assert.ok(tool.description, `description 없음: ${tool.name}`);
    assert.equal(tool.inputSchema?.type, 'object', `inputSchema 이상: ${tool.name}`);
  }
});

test('도구 이름이 중복되지 않는다', () => {
  assert.equal(toolNames.size, allTools.length);
});

test('알 수 없는 도구는 isError 로 응답한다', async () => {
  const result = await callTool({ params: { name: 'nope', arguments: {} } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown tool/);
});

test('성경 책 검색은 네트워크 없이 동작한다', async () => {
  const result = await callTool({
    params: { name: 'search_bible_books', arguments: { query: 'john' } },
  });
  assert.notEqual(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /John/i);
});

test('느린 도구는 타임아웃으로 끊긴다', async () => {
  // jw.org 가 응답하지 않을 때 MCP 요청이 영원히 매달리지 않는지 확인한다.
  await assert.rejects(
    () => callTool({ params: { name: 'get_bible_verse', arguments: { book: 43, chapter: 3, verse: 16 } } },
                    { timeoutMs: 1 }),
    /끝나지 않았습니다/,
  );
});
