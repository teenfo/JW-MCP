#!/usr/bin/env node
/**
 * "용어 설명"(nwtstg) 색인을 wol.jw.org 목차에서 다시 만든다.
 *
 *   node scripts/build-glossary-index.js            # 한국어 → src/tools/data/glossary-index-ko.json
 *   node scripts/build-glossary-index.js --check    # 파일은 그대로 두고 차이만 출력
 *
 * 색인에는 표제어 제목·문서 번호·자음 그룹만 넣는다(원문 텍스트는 넣지 않는다).
 * wol.jw.org 가 느리면 목차 호출이 실패할 수 있어 그룹마다 몇 번 다시 시도한다.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicationToc } from '../src/tools/wol-document.js';
import { SYMBOL } from '../src/tools/glossary-tools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'tools', 'data', 'glossary-index-ko.json');
const CHECK = process.argv.includes('--check');

async function withRetry(fn, label, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw new Error(`${label}: ${e.message}`);
      process.stderr.write(`  ${label} 재시도 ${i}/${tries - 1} (${e.message})\n`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

const first = await withRetry(() => getPublicationToc({ symbol: SYMBOL, langwritten: 'KO' }), '그룹 0');
const groups = first.groups.length ? first.groups : [{ group: '0', title: '?' }];

const terms = [];
const seen = new Set();
for (const g of groups) {
  const toc = String(g.group) === '0' ? first : await withRetry(() => getPublicationToc({ symbol: SYMBOL, group: g.group, langwritten: 'KO' }), `그룹 ${g.group}`);
  for (const d of toc.documents) {
    if (seen.has(d.docid)) continue;
    seen.add(d.docid);
    terms.push({ title: d.title, docid: d.docid, consonant: g.title });
  }
  process.stderr.write(`[${g.title}] ${toc.documents.length}\n`);
}

const index = {
  symbol: SYMBOL,
  language: 'KO',
  source: first.toc_url,
  built: new Date().toISOString().slice(0, 10),
  note: '표제어 제목과 문서 번호만 담은 색인. 설명 본문은 도구가 wol.jw.org 에서 그때그때 받는다.',
  count: terms.length,
  terms,
};

if (CHECK) {
  const old = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { terms: [] };
  const key = (t) => `${t.docid}\t${t.title}`;
  const a = new Set(old.terms.map(key));
  const b = new Set(terms.map(key));
  const added = [...b].filter((k) => !a.has(k));
  const removed = [...a].filter((k) => !b.has(k));
  console.log(`현재 ${old.terms.length}개 → wol.jw.org ${terms.length}개`);
  for (const k of added) console.log(`+ ${k}`);
  for (const k of removed) console.log(`- ${k}`);
  process.exit(added.length || removed.length ? 1 : 0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(index, null, 2)}\n`);
console.log(`${terms.length}개 표제어 → ${OUT}`);
