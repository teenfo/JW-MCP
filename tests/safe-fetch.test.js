/**
 * 허용 호스트 규칙 — "모든 자료는 jw.org / wol.jw.org 에서만" 원칙을 못 박는다.
 * 네트워크 없이 돈다.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertAllowedUrl, isAllowedUrl, safeFetch, ALLOWED_DOMAINS } from '../src/tools/safe-fetch.js';

test('jw.org·wol.jw.org·jw-cdn.org 는 허용된다', () => {
  for (const u of [
    'https://wol.jw.org/ko/wol/d/r8/lp-ko/1102026526',
    'https://www.jw.org/finder?wtlocale=KO',
    'https://jw.org/',
    'https://cfp2.jw-cdn.org/a/abc.rtf',
    'https://b.jw-cdn.org/apis/pub-media/GETPUBMEDIALINKS',
  ]) {
    assert.ok(isAllowedUrl(u), u);
  }
});

test('그 밖의 주소는 거부된다', () => {
  for (const u of [
    'https://example.com/',
    'https://evil-jw.org/',          // 접미사만 같은 다른 도메인
    'https://jw.org.evil.com/',      // 앞부분만 같은 다른 도메인
    'https://wol.jw.org@evil.com/',  // 사용자 정보로 위장
    'http://wol.jw.org/',            // https 아님
    'https://wol.jw.org:8443/',      // 비표준 포트
    'ftp://jw.org/',
    'not a url',
  ]) {
    assert.equal(isAllowedUrl(u), false, u);
  }
});

test('허용 목록은 두 도메인뿐이다', () => {
  assert.deepEqual([...ALLOWED_DOMAINS].sort(), ['jw-cdn.org', 'jw.org']);
});

test('거부된 주소는 요청을 보내지 않고 예외를 던진다', async () => {
  await assert.rejects(() => safeFetch('https://example.com/'), /허용되지 않은 주소/);
  assert.throws(() => assertAllowedUrl('https://example.com/'), { name: 'DisallowedHostError' });
});

test('도구 파일은 node-fetch 를 직접 쓰지 않는다 (safe-fetch 만 예외)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tools');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js') || f === 'safe-fetch.js') continue;
    const src = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(src, /from ['"]node-fetch['"]/, `${f} 가 node-fetch 를 직접 import 함`);
    // fetch( 를 부르는 파일은 반드시 safeFetch 를 fetch 로 들여와야 한다 (전역 fetch 금지).
    if (/\bfetch\(/.test(src.replace(/safeFetch\(/g, ''))) {
      assert.match(src, /import \{ safeFetch as fetch \} from '\.\/safe-fetch\.js'/, `${f} 가 전역 fetch 를 씀`);
    }
  }
});
