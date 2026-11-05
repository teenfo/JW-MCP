/**
 * "용어 설명"(nwtstg) 도구 — 네트워크 없이 돈다.
 *
 * 색인 동작은 합성 표제어로, 실제 색인 파일은 형태만 검사한다.
 * 설명 본문 파싱은 wol.jw.org 용어 문서의 **구조만** 흉내 낸 합성 HTML 로 본다.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  titleAliases,
  buildIndex,
  findTerms,
  findTermsInText,
  definitionFromDoc,
  loadIndex,
} from '../src/tools/glossary-tools.js';
import { parseWolDocument } from '../src/tools/wol-document.js';

const SAMPLE = buildIndex([
  { title: '기적; 강력한 일', docid: 1, consonant: 'ㄱ' },
  { title: '기둥(1)', docid: 2, consonant: 'ㄱ' },
  { title: '기둥(2)', docid: 3, consonant: 'ㄱ' },
  { title: '고대 근동(중동)', docid: 4, consonant: 'ㄱ' },
  { title: '요세푸스, 플라비우스', docid: 5, consonant: 'ㅇ' },
  { title: '게헨나', docid: 6, consonant: 'ㄱ' },
  { title: '영매', docid: 7, consonant: 'ㅇ' },
  { title: '영매술', docid: 8, consonant: 'ㅇ' },
  { title: '의', docid: 9, consonant: 'ㅇ' },
  { title: '고통의 기둥', docid: 10, consonant: 'ㄱ' },
  { title: '동', docid: 11, consonant: 'ㄷ' },
]);

test('표제어 형태별 별칭', () => {
  assert.deepEqual(titleAliases('기적; 강력한 일'), ['기적', '강력한 일']);
  assert.deepEqual(titleAliases('기둥(1)'), ['기둥']);
  assert.deepEqual(titleAliases('고대 근동(중동)'), ['중동', '고대 근동']);
  assert.deepEqual(titleAliases('요세푸스, 플라비우스'), ['요세푸스, 플라비우스', '요세푸스']);
});

test('정확히 일치하면 그것만 — 동음이의어는 모두', () => {
  assert.deepEqual(findTerms(SAMPLE, '기둥').exact.map((e) => e.docid), [2, 3]);
  assert.deepEqual(findTerms(SAMPLE, '강력한일').exact.map((e) => e.docid), [1]); // 공백 무시
  assert.deepEqual(findTerms(SAMPLE, '요세푸스').exact.map((e) => e.docid), [5]);
});

test('일치하지 않으면 비슷한 표제어', () => {
  const r = findTerms(SAMPLE, '게헨');
  assert.equal(r.exact.length, 0);
  assert.equal(r.similar[0].docid, 6);
});

test('글 속 용어: 조사가 붙어도 찾고, 긴 쪽을 남긴다', () => {
  const hits = findTermsInText(SAMPLE, '그는 게헨나에 던져졌다. 영매술을 행하는 자와 영매를 멀리하라.');
  assert.deepEqual(hits.map((h) => h.entry.docid), [6, 8, 7]);
});

test('글 속 용어: 어절 중간과 한 글자 표제어는 기본으로 제외', () => {
  const hits = findTermsInText(SAMPLE, '목동이 의를 사랑하였다. 동쪽으로 갔다.');
  assert.deepEqual(hits.map((h) => h.entry.docid), []);
  const withShort = findTermsInText(SAMPLE, '목동이 의를 사랑하였다.', { minLength: 1 });
  assert.deepEqual(withShort.map((h) => h.entry.docid), [9]); // "목동"의 "동"은 여전히 아님
});

test('글 속 용어: 여러 단어 표제어와 반복 횟수', () => {
  const hits = findTermsInText(SAMPLE, '고통의 기둥에 달리셨다. 고통의 기둥은…');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entry.docid, 10);
  assert.equal(hits[0].count, 2);
});

const DOC = `
<a href="/ko/wol/publication/r8/lp-ko/nwtstg" class="spriteLink">신세연용</a>
<article id="article" class="article document pub-nwtstg docId-1001077080">
 <header><h1>표제어</h1></header>
 <div class="bodyTxt">
  <p>설명 첫 문장이다. (<a class="b" data-bid="1-1">출 39:30</a>)—부록 나5 참조.</p>
 </div>
</article>`;

test('용어 문서 → 설명·성구·참조', () => {
  const doc = parseWolDocument(DOC, { url: 'https://wol.jw.org/ko/wol/d/r8/lp-ko/1001077080' });
  const d = definitionFromDoc(doc, { title: '표제어', docid: 1001077080 });
  assert.equal(d.docid, 1001077080);
  assert.equal(d.text.length, 1);
  assert.deepEqual(d.scriptures, ['출애굽기 39:30']);
  assert.deepEqual(d.see_also, ['부록 나5 참조']);
});

test('실제 색인 파일: 형태와 중복', () => {
  const idx = loadIndex('KO');
  assert.ok(idx.entries.length > 300, `표제어 ${idx.entries.length}개`);
  const ids = idx.entries.map((e) => e.docid);
  assert.equal(new Set(ids).size, ids.length, '문서 번호 중복');
  for (const e of idx.entries) {
    assert.ok(e.title && Number.isInteger(e.docid) && e.consonant, JSON.stringify(e));
  }
  // 대표 용어가 들어 있는지
  for (const t of ['게헨나', '여호와', '대속물']) assert.ok(findTerms(idx, t).exact.length, t);
});
