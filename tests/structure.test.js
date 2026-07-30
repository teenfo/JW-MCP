/**
 * 파수대 구조화·주간 범위 파싱 회귀 테스트 (네트워크 불필요).
 *
 * 커넥터 리포트(2026-07-31)에서 나온 결함들을 못 박는다. 특히 로케일별 마커는
 * **실측한 문자열**이라 규칙으로 일반화하면 안 된다 — 한국어는 닫는 어미를 뒤에
 * 붙이고(`[각주를 마칩니다]`) 영어는 앞에 붙인다(`[End of footnote]`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeEntities,
  parseWeekRange,
  stripWeekLabel,
  isCurrentWeek,
  structureArticle,
} from '../src/tools/watchtower-structure.js';

test('formattedDate 의 HTML 엔티티를 푼다', () => {
  assert.equal(decodeEntities('2026년 &nbsp;5월'), '2026년 5월');
  assert.equal(decodeEntities('May&nbsp;2026'), 'May 2026');
  assert.equal(decodeEntities('A&amp;B'), 'A&B');
});

test('한국어 제목에서 주간 범위를 뽑는다', () => {
  assert.deepEqual(parseWeekRange('2026년 7월 6-12일: 성경 원칙'), {
    start: '2026-07-06', end: '2026-07-12', label: '2026년 7월 6-12일',
  });
});

test('월을 넘어가는 주(en dash)를 처리한다', () => {
  const r = parseWeekRange('2026년 7월 27일–8월 2일: 추가 교육');
  assert.equal(r.start, '2026-07-27');
  assert.equal(r.end, '2026-08-02');
});

test('해를 넘어가는 주를 처리한다', () => {
  assert.equal(parseWeekRange('2025년 12월 29일–2026년 1월 4일: 제목').end, '2026-01-04');
  // 연도 표기가 한쪽에만 있어도 12월→1월이면 다음 해로 본다.
  const implied = parseWeekRange('2025년 12월 29일–1월 4일: 제목');
  assert.equal(implied.end, '2026-01-04');
});

test('영어 제목의 여러 형식을 처리한다', () => {
  assert.equal(parseWeekRange('July 6-12, 2026: Bible Principles').start, '2026-07-06');
  assert.equal(parseWeekRange('July 27–August 2, 2026: Stay Strong').end, '2026-08-02');
  const cross = parseWeekRange('December 29, 2025–January 4, 2026: Year End');
  assert.equal(cross.start, '2025-12-29');
  assert.equal(cross.end, '2026-01-04');
});

test('주간 기사가 아닌 항목은 null 이다', () => {
  assert.equal(parseWeekRange('이번 호의 기사들'), null);
  assert.equal(parseWeekRange('성경 인물에게서 배울 수 있는 교훈—마나엔'), null);
  assert.equal(parseWeekRange('In This Issue'), null);
});

test('제목에서 주간 범위 표기를 뗀다', () => {
  const t = '2026년 7월 27일–8월 2일: 추가 교육을 받는 동안';
  assert.equal(stripWeekLabel(t, parseWeekRange(t)), '추가 교육을 받는 동안');
});

test('isCurrentWeek 은 경계일을 포함한다', () => {
  const r = { start: '2026-07-27', end: '2026-08-02' };
  assert.equal(isCurrentWeek(r, new Date('2026-07-27T12:00:00')), true);
  assert.equal(isCurrentWeek(r, new Date('2026-08-02T12:00:00')), true);
  assert.equal(isCurrentWeek(r, new Date('2026-08-03T12:00:00')), false);
  assert.equal(isCurrentWeek(null), false);
});

// ---------------------------------------------------------------------------

const KO_SAMPLE = `2026년 7월 27일–8월 2일: 추가 교육을 받는 동안 가까이 지내십시오
“이 동일한 행로로 계속 걸읍시다.”—빌립보서 3:
16.
노래 56 진리를 자신의 것으로 만들라
[네모 기사] 요점
어떻게 영적으로 강한 상태를 유지할 수 있습니까? [네모 기사를 마칩니다]
1-
2. (ㄱ) 무엇이 필요합니까?
Your answer

1 첫째 항 본문입니다. 야고보서 4:8 을 보십시오.

2 둘째 항 본문입니다.
[“낭독” 성구] 빌립보서 3:16: 계속 걸읍시다. [“낭독” 성구를 마칩니다]
좋은 영적 일과를 유지하십시오
3. 어떤 어려움이 있습니까?
Your answer

3 셋째 항 본문입니다.—계시록 2:
4.
삽화 해설: 학업이 앞자리에 오지 않게 (18항 참조)
[각주] 각주 내용입니다. [각주를 마칩니다]
노래 87 와서, 새 힘을 얻으라!`;

const EN_SAMPLE = `July 27–August 2, 2026: Stay Spiritually Strong
“Let us go on walking orderly.”—Philippians 3:
16.

SONG Make the Truth Your Own

[Box] Focus
Four Bible principles that will help you. [End of box]
Question
1-
2. (a) What do you need to keep doing?
Your answer

1 First paragraph body.

2 Second paragraph body.
[“Read” scripture] Philippians 3:16: Let us go on. [End of “Read” scripture]
Maintain a Healthy Spiritual Routine
3. What challenge might you face?
Your answer

3 Third paragraph body.
[Footnote] A footnote. [End of footnote]

SONG Come! Be Refreshed`;

test('한국어 기사를 구조화한다', () => {
  const s = structureArticle(KO_SAMPLE, '2026년 7월 27일–8월 2일: 추가 교육을 받는 동안 가까이 지내십시오', 'KO');

  assert.equal(s.title, '추가 교육을 받는 동안 가까이 지내십시오');
  assert.deepEqual(s.weekRange, { start: '2026-07-27', end: '2026-08-02' });
  assert.equal(s.themeScripture, '빌립보서 3:16'); // 줄바꿈으로 잘린 절 번호가 이어붙는다
  assert.equal(s.songs.opening, 56);
  assert.equal(s.songs.closing, 87);
  assert.match(s.keyPoint, /^어떻게/); // 상자 이름("요점")은 뗀다
  assert.equal(s.readAloudScriptures.length, 1);
  assert.equal(s.readAloudScriptures[0].citation, '빌립보서 3:16');
  assert.equal(s.footnotes.length, 1);
  assert.equal(s.paragraphs.length, 3);
  assert.equal(s.paragraphs.find((p) => p.num === 3).question, '어떤 어려움이 있습니까?');
});

test('"1-\\n2." 로 잘린 항 범위가 소제목으로 오인되지 않는다', () => {
  const s = structureArticle(KO_SAMPLE, '', 'KO');
  assert.ok(!s.sections.some((x) => x.heading === '1-'));
  // 1항과 2항이 같은 질문을 공유한다
  assert.equal(s.paragraphs.find((p) => p.num === 1).question, s.paragraphs.find((p) => p.num === 2).question);
});

test('삽화 설명과 그 안의 항 참조가 배정을 어지럽히지 않는다', () => {
  const s = structureArticle(KO_SAMPLE, '', 'KO');
  assert.ok(!s.sections.some((x) => /삽화/.test(x.heading)));
  const assigned = s.sections.flatMap((x) => x.paragraphs);
  assert.equal(assigned.length, new Set(assigned).size, '항이 두 소제목에 중복 배정됨');
  // 삽화 설명의 "(18항 참조)" 가 항 18로 잡히면 안 된다 — 본문에 18항은 없다.
  assert.ok(!s.paragraphs.some((p) => p.num === 18));
});

test('영어 기사를 구조화한다 (닫는 마커 형태가 한국어와 다르다)', () => {
  const s = structureArticle(EN_SAMPLE, 'July 27–August 2, 2026: Stay Spiritually Strong', 'E');

  assert.equal(s.title, 'Stay Spiritually Strong');
  assert.deepEqual(s.weekRange, { start: '2026-07-27', end: '2026-08-02' });
  assert.equal(s.themeScripture, 'Philippians 3:16');
  assert.equal(s.readAloudScriptures.length, 1, '[End of ...] 형태의 닫는 마커를 놓쳤다');
  assert.equal(s.footnotes.length, 1);
  assert.match(s.keyPoint, /Four Bible principles/);
});

test('영어는 노래 번호가 없어 null 로 둔다', () => {
  const s = structureArticle(EN_SAMPLE, '', 'E');
  assert.equal(s.songs.opening, null);
  assert.equal(s.songs.titles[0].title, 'Make the Truth Your Own');
  assert.equal(s.songs.titles.length, 2);
});

test('영어의 "Question" 줄이 소제목으로 잡히지 않는다', () => {
  const s = structureArticle(EN_SAMPLE, '', 'E');
  assert.ok(!s.sections.some((x) => /^Question$/i.test(x.heading)));
  assert.deepEqual(s.sections.map((x) => x.heading), ['Maintain a Healthy Spiritual Routine']);
});

test('구조화가 빗나가도 예외를 던지지 않는다', () => {
  for (const input of ['', '아무 구조도 없는 평문입니다.', '[네모 기사] 닫히지 않은 상자']) {
    const s = structureArticle(input, '', 'KO');
    assert.equal(typeof s.parsed.paragraphs, 'number');
  }
});
