/**
 * 허용 호스트 fetch — 이 서버의 **모든 외부 요청**이 지나가는 유일한 관문.
 *
 * ## 왜 있는가
 *
 * 이 MCP 의 가장 중요한 원칙은 "모든 자료를 jw.org 또는 wol.jw.org 에서만 찾는다"이다.
 * 도구가 늘어나도 그 원칙이 코드로 지켜지도록, 요청 직전에 주소를 검사해 허용 목록
 * 밖이면 **요청 자체를 보내지 않는다.**
 *
 * 허용 목록:
 *   - jw.org 와 그 하위 도메인 (www.jw.org, wol.jw.org …)
 *   - jw-cdn.org 와 그 하위 도메인 — jw.org 의 공식 파일 서버. 파수대·집회 교재 RTF,
 *     pub-media API, 동영상 자막이 여기서 온다. 2026-11-06 사용자 결정으로 포함.
 *
 * ## 리디렉션
 *
 * 자동 리디렉션을 끄고(`redirect: 'manual'`) 한 단계씩 직접 따라가며 **매 단계 주소를
 * 다시 검사한다.** 허용된 주소가 바깥으로 리디렉션하는 경우까지 막기 위해서다.
 *
 * ## 규칙
 *
 * `node-fetch` 를 도구 파일에서 직접 import 하지 말 것 — 항상 `safeFetch` 를 쓴다.
 * tests/safe-fetch.test.js 가 src/tools 안의 직접 import 를 잡아낸다.
 */

import fetch from 'node-fetch';

/** 허용 도메인. 정확히 일치하거나 그 하위 도메인이어야 한다. */
export const ALLOWED_DOMAINS = Object.freeze(['jw.org', 'jw-cdn.org']);

const MAX_REDIRECTS = 5;

export class DisallowedHostError extends Error {
  constructor(url, reason) {
    super(
      `허용되지 않은 주소라 요청하지 않았습니다: ${url} (${reason}). ` +
        `이 서버는 ${ALLOWED_DOMAINS.join(', ')} 의 자료만 사용합니다.`,
    );
    this.name = 'DisallowedHostError';
    this.url = url;
  }
}

/**
 * 주소가 허용 목록 안인지 검사한다. 통과하면 URL 객체를, 아니면 예외를 던진다.
 * https 만 허용하고, 사용자 정보(user@host)·포트 지정이 붙은 주소는 거부한다.
 */
export function assertAllowedUrl(input) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    throw new DisallowedHostError(String(input), '올바른 URL 이 아님');
  }

  if (url.protocol !== 'https:') throw new DisallowedHostError(url.href, 'https 가 아님');
  if (url.username || url.password) throw new DisallowedHostError(url.href, '사용자 정보 포함');
  if (url.port && url.port !== '443') throw new DisallowedHostError(url.href, '비표준 포트');

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const ok = ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  if (!ok) throw new DisallowedHostError(url.href, `호스트 ${host}`);

  return url;
}

/** 주소가 허용 목록 안인지 여부만 돌려준다. */
export function isAllowedUrl(input) {
  try {
    assertAllowedUrl(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * 허용 목록을 강제하는 fetch. node-fetch 와 같은 응답 객체를 돌려준다.
 * 리디렉션은 매 단계 허용 목록을 다시 검사하며 직접 따라간다.
 */
export async function safeFetch(input, options = {}) {
  let url = assertAllowedUrl(input);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(url.href, { ...options, redirect: 'manual' });

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const next = new URL(response.headers.get('location'), url);
      url = assertAllowedUrl(next.href);
      continue;
    }
    return response;
  }

  throw new Error(`리디렉션이 ${MAX_REDIRECTS}회를 넘었습니다: ${input}`);
}

export default safeFetch;
