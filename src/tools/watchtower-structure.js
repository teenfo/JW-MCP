/**
 * 파수대 연구 기사 — 주간 범위 파싱과 본문 구조화.
 *
 * pub-media API 는 제목 문자열 안에만 주간 범위를 담아 준다:
 *
 *   KO  "2026년 7월 27일–8월 2일: 추가 교육을 받는 동안 …"
 *   EN  "July 27–August 2, 2026: Stay Spiritually Strong While …"
 *
 * en dash(–)를 쓰고, 월·연을 넘어가고, 로케일마다 형식이 달라 소비자가 매주 문자열을
 * 파싱해야 했다. 여기서 한 번만 하고 ISO 날짜로 내보낸다.
 *
 * 본문 쪽은 RTF 파서가 평문 한 덩어리를 주는데, 그 안에 구조 정보가 마커로 남아 있다:
 *
 *   [네모 기사] … [네모 기사를 마칩니다]        박스(요점·복습란)
 *   ["낭독" 성구] … ["낭독" 성구를 마칩니다]    낭독 지정 성구
 *   [각주] … [각주를 마칩니다]                  각주
 *   노래 56 …                                   시작·마침 노래
 *   "3. 질문?" + "Your answer"                  항 번호와 질문
 *   빈 줄 + "3 본문…"                           항 본문
 *
 * 이걸 되살리는 정규식을 소비자마다 따로 쓰지 않도록 `structured` 로 제공한다.
 * **`parsedText` 는 손대지 않는다** — 구조화가 빗나가도 원문은 그대로 쓸 수 있어야 한다.
 */

/** pub-media 의 formattedDate 등에 그대로 들어오는 HTML 엔티티를 푼다. */
export function decodeEntities(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const EN_MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const iso = (y, m, d) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * 기사 제목에서 주간 범위를 뽑는다.
 *
 * 대시는 하이픈·en dash·em dash 를 모두 받는다(로케일마다 다르게 쓴다).
 * 주간 기사가 아닌 항목(차례, 성경 인물 기사 등)은 null 을 돌려준다.
 *
 * @returns {{start: string, end: string, label: string}|null} ISO 날짜
 */
export function parseWeekRange(title, fallbackYear = null) {
  if (typeof title !== 'string') return null;
  const t = decodeEntities(title);
  const DASH = '[-–—~]';

  // ── 한국어 ──────────────────────────────────────────────────────────
  // "2026년 7월 27일–8월 2일" / "2026년 7월 6-12일"
  // "2025년 12월 29일–2026년 1월 4일" (해 넘김)
  let m = new RegExp(
    `(\\d{4})년\\s*(\\d{1,2})월\\s*(\\d{1,2})일?\\s*${DASH}\\s*(?:(\\d{4})년\\s*)?(?:(\\d{1,2})월\\s*)?(\\d{1,2})일`,
  ).exec(t);
  if (m) {
    const [, y1, mo1, d1, y2, mo2, d2] = m;
    const startY = parseInt(y1, 10);
    const startM = parseInt(mo1, 10);
    const endY = y2 ? parseInt(y2, 10) : startY;
    const endM = mo2 ? parseInt(mo2, 10) : startM;
    return {
      start: iso(startY, startM, parseInt(d1, 10)),
      // 월만 넘어가고 연도 표기가 없으면(12월→1월) 해가 바뀐 것으로 본다.
      end: iso(endM < startM && !y2 ? endY + 1 : endY, endM, parseInt(d2, 10)),
      label: m[0],
    };
  }

  // ── 영어 ────────────────────────────────────────────────────────────
  // "July 27–August 2, 2026" / "July 6-12, 2026" / "December 29, 2025–January 4, 2026"
  const MON = Object.keys(EN_MONTHS).join('|');
  m = new RegExp(
    `(${MON})\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?\\s*${DASH}\\s*(?:(${MON})\\s+)?(\\d{1,2})(?:,\\s*(\\d{4}))?`,
    'i',
  ).exec(t);
  if (m) {
    const [, mon1, d1, y1, mon2, d2, y2] = m;
    const startM = EN_MONTHS[mon1.toLowerCase()];
    const endM = mon2 ? EN_MONTHS[mon2.toLowerCase()] : startM;
    // 연도는 뒤쪽에 한 번만 적히는 경우가 흔하다 — 없으면 반대쪽/발행호에서 가져온다.
    const endY = parseInt(y2 || y1 || fallbackYear, 10);
    if (Number.isNaN(endY)) return null;
    const startY = y1 ? parseInt(y1, 10) : endM < startM ? endY - 1 : endY;
    return {
      start: iso(startY, startM, parseInt(d1, 10)),
      end: iso(endY, endM, parseInt(d2, 10)),
      label: m[0],
    };
  }

  return null;
}

/** 제목에서 주간 범위 표기를 떼고 기사 제목만 남긴다. */
export function stripWeekLabel(title, range) {
  if (!range) return decodeEntities(title);
  return decodeEntities(title)
    .replace(range.label, '')
    .replace(/^\s*[:：]\s*/, '')
    .trim();
}

/** ISO 날짜 문자열이 오늘을 포함하는 주인가. */
export function isCurrentWeek(range, today = new Date()) {
  if (!range) return false;
  const t = iso(today.getFullYear(), today.getMonth() + 1, today.getDate());
  return range.start <= t && t <= range.end;
}

// ---------------------------------------------------------------------------
// 본문 구조화
// ---------------------------------------------------------------------------

/**
 * 로케일별 마커 — **실제 RTF 출력에서 확인한 값이다.**
 *
 * 두 언어의 닫는 마커 형태가 서로 다르다는 점이 중요하다. 한국어는 여는 이름 뒤에
 * 어미를 붙이고(`[각주를 마칩니다]`), 영어는 앞에 붙인다(`[End of footnote]`).
 * 규칙 하나로 일반화하려다 영어 쪽이 통째로 안 잡혔었다 — 그래서 쌍을 그대로 적는다.
 *
 * 노래 표기도 다르다. 한국어는 번호가 있고(`노래 56 …`), 영어는 없다(`SONG …`).
 */
const MARKERS = {
  KO: {
    blocks: {
      box: [['[네모 기사]', '[네모 기사를 마칩니다]']],
      read: [['[“낭독” 성구]', '[“낭독” 성구를 마칩니다]'], ['["낭독" 성구]', '["낭독" 성구를 마칩니다]']],
      foot: [['[각주]', '[각주를 마칩니다]']],
    },
    song: /^노래\s*(\d+)?\s*(.*)$/,
    noise: /^(Your answer|질문|\[사진[^\]]*\]|\[삽화[^\]]*\])$/,
  },
  EN: {
    blocks: {
      box: [['[Box]', '[End of box]']],
      read: [['[“Read” scripture]', '[End of “Read” scripture]'], ['["Read" scripture]', '[End of "Read" scripture]']],
      foot: [['[Footnote]', '[End of footnote]']],
    },
    song: /^SONG\s*(\d+)?\s*(.*)$/i,
    // 영어 본문에는 질문 앞에 "Question" 이라는 줄이 따로 온다. 소제목으로 오인하면
    // 섹션이 질문 수만큼 생겨 구조가 무의미해진다.
    noise: /^(Question|Your answer|\[Image:?\]?)$/i,
  },
};

/** `[열기] … [닫기]` 구간을 뽑고, 본문에서 제거한 나머지를 함께 돌려준다. */
function extractBlocks(text, open, close) {
  const blocks = [];
  let rest = '';
  let i = 0;

  while (i < text.length) {
    const s = text.indexOf(open, i);
    if (s === -1) {
      rest += text.slice(i);
      break;
    }
    rest += text.slice(i, s);
    const e = text.indexOf(close, s);
    if (e === -1) {
      // 닫는 마커가 없으면 구조가 깨진 것 — 원문을 잃지 않도록 그대로 둔다.
      rest += text.slice(s);
      break;
    }
    blocks.push(text.slice(s + open.length, e).trim());
    i = e + close.length;
  }

  return { blocks, rest };
}

/**
 * RTF 파서가 만든 평문을 구조화한다.
 *
 * 정규식 기반 최선 노력이다. 못 찾은 항목은 null / 빈 배열로 두고, 무엇을 찾았는지
 * `structured.parsed` 에 남겨 소비자가 신뢰 여부를 판단할 수 있게 한다.
 *
 * @param {string} parsedText parseRTF 결과
 * @param {string} title pub-media 의 기사 제목
 * @param {string} langwritten 언어 코드
 */
export function structureArticle(parsedText, title = '', langwritten = 'E') {
  const text = String(parsedText || '');
  const ko = String(langwritten).toUpperCase().startsWith('K');
  const M = ko ? MARKERS.KO : MARKERS.EN;

  // 제목을 안 받았으면 본문 첫 줄이 곧 제목이다. 이걸 알아야 그 줄을 소제목 후보에서
  // 뺄 수 있다 — 안 그러면 기사 제목이 첫 번째 섹션으로 잡힌다.
  const articleTitle = title || text.split('\n').find((l) => l.trim()) || '';

  // 1) 마커 구간을 먼저 걷어낸다 — 남은 것이 항 본문/질문/소제목이다.
  let working = text;
  const collected = { box: [], read: [], foot: [] };

  for (const [kind, pairs] of Object.entries(M.blocks)) {
    for (const [open, close] of pairs) {
      const r = extractBlocks(working, open, close);
      collected[kind].push(...r.blocks);
      working = r.rest;
    }
  }
  const boxes = collected.box;
  const readAloud = collected.read;
  const footnotes = collected.foot;

  // 2) RTF 줄바꿈이 토큰 한가운데를 자른다. 두 가지를 이어 붙인다:
  //    - 성구 번호   "빌립보서 3:\n16."  → "빌립보서 3:16."
  //    - 항 범위     "1-\n2. (ㄱ) …"     → "1-2. (ㄱ) …"   (안 붙이면 "1-" 이 소제목으로 잡힌다)
  //    - 절 범위      "3:18-\n20."        → "3:18-20."
  //    - 절 나열      "3:5,\n6."          → "3:5,6."
  working = working
    .replace(/^(\d+)\s*[-–]\s*\n\s*(\d+\.)/gm, '$1-$2')
    .replace(/:\s*\n\s*(\d)/g, ':$1')
    .replace(/(\d)\s*([-–,])\s*\n\s*(\d)/g, '$1$2$3');

  const lines = working.split('\n').map((l) => l.trim());

  // 3) 노래 — 처음이 시작, 마지막이 마침.
  // 영어 파수대는 노래 번호를 싣지 않는다 — 번호가 없으면 null 로 두고 제목만 남긴다.
  const songs = [];
  for (const line of lines) {
    const m = M.song.exec(line);
    if (m && (m[1] || m[2])) {
      songs.push({ number: m[1] ? parseInt(m[1], 10) : null, title: (m[2] || '').trim() });
    }
  }

  // 4) 주제 성구 — 인용부호 뒤 대시 다음의 성구 표기.
  const themeLine = lines.find((l) => /^[“"']/.test(l) && /[—–-]/.test(l));
  const themeScripture = themeLine
    ? (themeLine.split(/[—–]/).pop() || '').trim().replace(/\.$/, '')
    : null;

  // 5) 항 질문과 본문.
  //    질문: 줄 시작이 "3." 또는 "1-2." (여러 항을 묶은 질문)
  //    본문: 줄 시작이 "3 " (마침표 없음)
  const questions = new Map();
  const bodies = new Map();
  const sections = [];

  let pendingQuestion = null;
  let currentSection = null;
  let lastParagraph = 0;
  const assigned = new Set();

  // 소제목처럼 짧지만 소제목이 아닌 줄들. 삽화·사진 설명이 대표적이다.
  const isCaption = (l) => /^(삽화|사진|그림)\s*(해설|설명)?\s*[:：]|^(Picture|Illustration|Photo)\s/i.test(l);

  // 한국어 본문은 첫 줄이 기사 제목(주간 범위 포함)인데, 짧아서 소제목으로 오인된다.
  // 제목은 이미 title 필드로 나가므로 소제목 후보에서 뺀다.
  const titleRange = parseWeekRange(articleTitle);
  const titleForms = new Set(
    [articleTitle, decodeEntities(articleTitle), stripWeekLabel(articleTitle, titleRange)]
      .filter(Boolean)
      .map((t) => t.trim()),
  );
  const isTitleLine = (l) => titleForms.has(l.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const qm = /^(\d+(?:\s*[-–]\s*\d+)?)\.\s*(.*)$/.exec(line);
    if (qm) {
      // 질문은 다음 줄들로 이어지고 "Your answer" 로 답란이 끼어든다.
      let body = qm[2];
      for (let j = i + 1; j < lines.length && lines[j] && !/^\d+(\s|\.)/.test(lines[j]); j++) {
        body += ' ' + lines[j];
        i = j;
      }
      const nums = expandRange(qm[1]);

      // 항 번호는 1..N 으로 차례대로 올라간다. 뒤로 돌아가거나 멀리 건너뛰는 번호는
      // 진짜 질문 머리글이 아니라 삽화 설명 안의 "(18항 참조)" 같은 참조다.
      // 이걸 안 거르면 그 번호들이 엉뚱한 소제목에 끌려 들어가 배정이 뒤엉킨다.
      if (nums[0] <= lastParagraph || nums[0] > lastParagraph + 3) continue;
      lastParagraph = nums[nums.length - 1];

      const qText = body.replace(/Your answer/g, ' ').replace(/\s{2,}/g, ' ').trim();
      for (const n of nums) questions.set(n, qText);
      pendingQuestion = nums;
      // 항은 **자기 질문이 처음 나온** 소제목에만 속한다. 이 검사가 없으면 뒤쪽
      // 소제목들이 앞서 나온 항 번호를 다시 주워 담아 배정이 뒤엉킨다.
      if (currentSection) {
        for (const n of nums) {
          if (!assigned.has(n)) {
            assigned.add(n);
            currentSection.paragraphs.push(n);
          }
        }
      } else {
        nums.forEach((n) => assigned.add(n));
      }
      continue;
    }

    const bm = /^(\d+)\s+(.+)$/.exec(line);
    if (bm) {
      const n = parseInt(bm[1], 10);
      bodies.set(n, (bodies.get(n) ? bodies.get(n) + ' ' : '') + bm[2].trim());
      continue;
    }

    // 숫자로 시작하지 않는 짧은 줄을 소제목으로 본다. 인용문(주제 성구)·노래·
    // 삽화 설명은 길이가 비슷해도 소제목이 아니다.
    const looksHeading =
      line.length < 60 &&
      !/^[“"']/.test(line) &&
      !M.song.test(line) &&
      !isCaption(line) &&
      !M.noise.test(line) &&
      !isTitleLine(line) &&
      i + 1 < lines.length;

    if (looksHeading) {
      currentSection = { heading: line, paragraphs: [] };
      sections.push(currentSection);
      pendingQuestion = null;
    }
  }

  const paragraphs = [...new Set([...questions.keys(), ...bodies.keys()])]
    .sort((a, b) => a - b)
    .map((num) => ({
      num,
      question: questions.get(num) || null,
      text: bodies.get(num) || null,
      scriptures: extractScriptures(bodies.get(num) || ''),
    }));

  const range = parseWeekRange(articleTitle);

  return {
    title: stripWeekLabel(articleTitle, range) || null,
    weekRange: range ? { start: range.start, end: range.end } : null,
    themeScripture,
    keyPoint: boxes[0] ? stripBoxLabel(boxes[0]) : null,
    songs: {
      opening: songs[0]?.number ?? null,
      closing: songs.length > 1 ? songs[songs.length - 1].number : null,
      titles: songs,
    },
    sections: sections.filter((s) => s.paragraphs.length),
    paragraphs,
    readAloudScriptures: readAloud.map(parseReadAloud),
    footnotes: footnotes.map((t, i) => ({
      marker: String.fromCharCode(97 + i),
      // 각주 안에도 답란 표시가 끼어든다 — 각주 본문에는 의미가 없다.
      text: t.replace(/^\*/, '').replace(/Your answer/g, ' ').replace(/\s{2,}/g, ' ').trim(),
    })),
    // 마지막 박스는 관행상 복습란이다(요점 박스와 같지 않을 때만).
    reviewBox: boxes.length > 1 ? stripBoxLabel(boxes[boxes.length - 1]) : null,
    parsed: {
      paragraphs: paragraphs.length,
      questions: questions.size,
      sections: sections.filter((s) => s.paragraphs.length).length,
      read_aloud: readAloud.length,
      footnotes: footnotes.length,
      boxes: boxes.length,
      note: '정규식 기반 최선 노력 구조화입니다. 원문이 필요하면 parsedText 를 쓰세요.',
    },
  };
}

/**
 * 박스 내용을 정리한다.
 * 첫 줄이 짧으면 그건 내용이 아니라 상자 이름("요점" / "KEY POINT")이라 뗀다.
 */
function stripBoxLabel(block) {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines[0].length <= 12) lines.shift();
  return lines.join(' ').replace(/Your answer/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** "1-2" → [1, 2] */
function expandRange(spec) {
  const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(spec.trim());
  if (!m) return [parseInt(spec, 10)];
  const out = [];
  for (let i = parseInt(m[1], 10); i <= parseInt(m[2], 10); i++) out.push(i);
  return out;
}

/** `빌립보서 3:16: 본문…` → { citation, text } */
function parseReadAloud(block) {
  const m = /^(.+?\d+:[\d,\s-]+)\s*:\s*([\s\S]+)$/.exec(block.trim());
  if (!m) return { citation: null, text: block.trim() };
  return { citation: m[1].trim(), text: m[2].replace(/\s{2,}/g, ' ').trim() };
}

/** 본문에서 성구 표기를 뽑는다 (한국어·영어 책 이름 + 장:절). */
function extractScriptures(text) {
  const found = new Set();
  // 서수는 영어처럼 앞에 붙거나("1 John"), 한국어처럼 뒤에 붙는다("고린도 전서").
  // 서수 자리에 맨숫자를 허용하면 "마태복음 22:37" 의 장 번호 첫 자리를 먹는다.
  // 절 부분에서 공백은 **구분자 뒤에만** 허용한다("5:1, 2"). 그냥 \s 를 넣으면
  // "고린도 전서 15:58 1 John 3:16" 의 뒤 서수까지 삼켜 "15:581" 이 된다.
  const re = /((?:[123]\s)?[가-힣A-Za-z]+(?:\s(?:전서|후서|상권|하권|상|하))?)\s*(\d+):(\d+(?:\s*[,-]\s*\d+)*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const verses = m[3].replace(/\s+/g, '').replace(/[-,]+$/, ''); // 줄바꿈으로 잘린 꼬리 제거
    if (!verses) continue;
    found.add(`${m[1].trim()} ${m[2]}:${verses}`);
  }
  return [...found];
}
