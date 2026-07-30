/**
 * WOL 언어 매핑.
 *
 * wol.jw.org 의 성경 URL 은 `/{locale}/wol/b/{rsconf}/{lib}/nwtsty/{책}/{장}` 형태이고,
 * 이 세 조각은 언어마다 다르다. 상류 구현은 영어(`/en/wol/b/r1/lp-e/`)를 하드코딩해
 * 성구 도구 4종이 영어로만 답했다.
 *
 * ⚠️ 여기 실린 항목은 전부 **실제로 요청해서 확인한 것**이다(요한 3장을 받아 절이
 *    파싱되는지까지 확인). 조합을 추측해서 넣으면 조용히 404 가 되므로, 새 언어를
 *    추가할 때도 반드시 실측하고 넣을 것.
 *
 * 언어 코드는 pub-media API 의 `langwritten` 과 같은 값을 쓴다 — 파수대·워크북
 * 도구와 인자 이름·값이 일치해야 한 요청에서 섞어 쓸 수 있다.
 */

export const WOL_LOCALES = {
  E: { locale: 'en', rsconf: 'r1', lib: 'lp-e', name: 'English' },
  KO: { locale: 'ko', rsconf: 'r8', lib: 'lp-ko', name: '한국어' },
  S: { locale: 'es', rsconf: 'r4', lib: 'lp-s', name: 'Español' },
  F: { locale: 'fr', rsconf: 'r30', lib: 'lp-f', name: 'Français' },
  X: { locale: 'de', rsconf: 'r10', lib: 'lp-x', name: 'Deutsch' },
  T: { locale: 'pt', rsconf: 'r5', lib: 'lp-t', name: 'Português' },
  J: { locale: 'ja', rsconf: 'r7', lib: 'lp-j', name: '日本語' },
  I: { locale: 'it', rsconf: 'r6', lib: 'lp-i', name: 'Italiano' },
  U: { locale: 'ru', rsconf: 'r2', lib: 'lp-u', name: 'Русский' },
  TG: { locale: 'tl', rsconf: 'r27', lib: 'lp-tg', name: 'Tagalog' },
  IN: { locale: 'id', rsconf: 'r25', lib: 'lp-in', name: 'Indonesia' },
};

export const DEFAULT_LANG = 'E';

/** 도구 스키마에서 쓸 지원 언어 코드 목록. */
export const SUPPORTED_LANGS = Object.keys(WOL_LOCALES);

/**
 * 언어 코드를 WOL 경로 조각으로 바꾼다.
 * 대소문자와 흔한 별칭(`K`→`KO`, `EN`→`E`)을 받아준다 — 사용자가 두 표기를 섞어 쓴다.
 */
export function resolveLocale(langwritten) {
  const raw = String(langwritten || DEFAULT_LANG).trim().toUpperCase();
  const aliases = { K: 'KO', EN: 'E', ENG: 'E', KOR: 'KO', ES: 'S', FR: 'F', DE: 'X', PT: 'T', JA: 'J', IT: 'I', RU: 'U' };
  const code = WOL_LOCALES[raw] ? raw : aliases[raw];

  if (!code || !WOL_LOCALES[code]) {
    throw new Error(
      `지원하지 않는 언어 코드입니다: "${langwritten}". ` +
        `사용 가능: ${SUPPORTED_LANGS.join(', ')} (예: E=영어, KO=한국어)`,
    );
  }
  return { code, ...WOL_LOCALES[code] };
}

/** 성경 장 URL. */
export function chapterUrl(langwritten, bookNum, chapterNum) {
  const { locale, rsconf, lib } = resolveLocale(langwritten);
  return `https://wol.jw.org/${locale}/wol/b/${rsconf}/${lib}/nwtsty/${bookNum}/${chapterNum}`;
}

/** 상대 경로(WOL 내부 링크)를 절대 URL 로. */
export function absoluteUrl(href) {
  if (!href) return null;
  return href.startsWith('/') ? `https://wol.jw.org${href}` : href;
}
