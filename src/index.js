#!/usr/bin/env node
/**
 * stdio MCP 서버 — 로컬 Claude Desktop / mcporter 용.
 *
 * 인증이 없다. 이 진입점은 사용자의 기기에서 사용자 권한으로 도는 자식 프로세스라
 * 네트워크에 노출되지 않기 때문이다. 원격 접근은 전부 src/http-server.js 를 거치며
 * 거기서는 OAuth 2.1 Bearer 가 강제된다.
 *
 * 도구 목록은 src/tools/registry.js 한 곳에서만 정의된다 — HTTP 서버와 같은 배열을
 * 쓰므로 두 진입점이 어긋날 수 없다.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { allTools, callTool } from './tools/registry.js';

const server = new Server(
  { name: 'jw-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allTools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await callTool(request);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `오류: ${err?.message || err}` }],
      isError: true,
    };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`JW MCP Server (stdio) — 도구 ${allTools.length}종`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
