/**
 * 「성경 안내서」 파서 — 네트워크 없이 돈다.
 *
 * 픽스처는 2026-11-06 에 실측한 wol.jw.org 장 페이지의 **구조만** 흉내 낸 합성 HTML 이다
 * (원문 텍스트는 저장소에 넣지 않는다). 클래스·중첩 관계는 guidebook-tools.js 상단 주석과 같다.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseGuidebookChapter,
  parseCitation,
  expandVerses,
  filterParagraphs,
  resolveBook,
  renderText,
  parseToc,
} from '../src/tools/guidebook-tools.js';

const FIXTURE = `
<article id="article">
 <header>
  <div><p id="p1" class="contextTtl">성경 제26권</p><h1 id="p2">에스겔</h1></div>
 </header>
 <div class="alternatePresentation"><div class="title">인쇄판</div></div>
 <div class="openingContent">
  <p id="p3">요점: 요점 내용</p>
  <p id="p4">성경 주제와의 연관성: 연관성 내용</p>
  <p id="p5">필자: 에스겔</p>
 </div>
 <div class="boxSupplement"><aside><div class="boxTtl"><h2>성경 책 목록</h2></div>
  <div class="boxContent"><p>기록이 완료된 책:</p><p>창세기, 출애굽기</p></div></aside></div>
 <div class="bodyTxt">
  <div id="tt19">
   <h2 id="p9">이 책이 중요한 이유</h2>
   <p id="p64" class="qu">1-2. 첫 질문입니까?</p>
   <div id="p65" class="gen-field"><label>답을 적는 칸</label><textarea></textarea></div>
   <p id="p10"><span class="parNum" data-pnum="1"></span>첫 항 (<a href="/ko/wol/bc/r8/lp-ko/1102026526/0/0" data-bid="1-1" class="b">36:11</a>) 계속 (<a class="b" data-bid="2-1" href="#">36:22;</a><a class="b" data-bid="2-2" href="#"> 39:7</a>)</p>
   <p id="p11"><span class="parNum" data-pnum="2"></span>2 둘째 항 (<a class="b" data-bid="3-1" href="#">신 24:16;</a><a class="b" data-bid="3-2" href="#"> 30:19</a>)</p>
   <div class="stdPullQuote"><p id="p106">인용 반복</p></div>
   <div class="boxSupplement"><aside><div class="boxTtl"><h2>26-다 연대표 제목</h2></div>
    <div class="boxContent">
     <p>이 연대표는 연도를 보여 줍니다.</p>
     <div><p>배울 수 있는 점: 꼭 낭독할 점</p></div>
     <p>설명: 설명 문장</p>
     <table><tr><td><p>4:1-3</p></td><td><p>성취되다 (<a class="b" data-bid="9-1" href="#">왕하 25:1</a>)</p></td></tr></table>
     <figure><figcaption><p>그림 설명</p></figcaption></figure>
    </div></aside></div>
   <p id="p66" class="qu">3. 셋째 질문입니까?</p>
   <p id="p12"><span class="parNum" data-pnum="3"></span>셋째 항</p>
  </div>
  <div id="tt26">
   <h2 id="p22">이 책의 내용</h2>
   <p id="p84" class="qu">4. 넷째 질문입니까?</p>
   <p id="p23"><span class="parNum" data-pnum="4"></span>넷째 항 (<a class="b" data-bid="5-1" href="#">1:1–3:27</a>)</p>
  </div>
 </div>
 <div id="tt33">
  <h2 id="p36">에스겔서에서 얻을 수 있는 유익</h2>
  <ul>
   <li class="du-color--gray-700"><p id="p37">1. 여호와와 더 가까워지세요</p>
    <ul><li><p id="p38">ㄱ. 복습 질문 (<a class="b" data-bid="7-1" href="#">38:18, 19, 22</a>)</p><div class="gen-field"><textarea></textarea></div></li></ul>
   </li>
   <li class="du-color--gray-700"><p id="p58">4. 또 어떤 점을 배웠습니까?</p><div class="gen-field"><textarea></textarea></div></li>
  </ul>
 </div>
 <div class="groupFootnote"><div class="fn-ref"><p id="p61">a 각주 내용</p></div></div>
</article>`;

const parsed = () => parseGuidebookChapter(FIXTURE, { bookNum: 26, langCode: 'KO', url: 'https://wol.jw.org/x' });

test('장 머리와 주요 정보 네모를 읽는다', () => {
  const ch = parsed();
  assert.equal(ch.chapter_label, '성경 제26권');
  assert.equal(ch.title, '에스겔');
  assert.deepEqual(ch.key_info.map((k) => k.label), ['요점', '성경 주제와의 연관성', '필자']);
  assert.equal(ch.header_boxes[0].title, '성경 책 목록');
});

test('소제목·질문·항을 순서대로 읽고 답란·인용 반복은 건너뛴다', () => {
  const ch = parsed();
  assert.deepEqual(ch.sections.map((s) => s.heading), ['이 책이 중요한 이유', '이 책의 내용']);
  const items = ch.sections[0].items;
  assert.deepEqual(items.map((i) => i.type), ['question', 'paragraph', 'paragraph', 'supplement', 'question', 'paragraph']);
  assert.deepEqual(items[0].paragraphs, [1, 2]);
  assert.equal(items[2].text.startsWith('둘째 항'), true, '항 번호 접두어 제거');
  assert.ok(!JSON.stringify(ch).includes('인용 반복'));
  assert.ok(!JSON.stringify(ch).includes('답을 적는 칸'));
  assert.equal(ch.parse_warnings.length, 0);
});

test('책 이름 없는 인용은 이 장의 책, 같은 괄호 안에서는 앞 책을 잇는다', () => {
  const [p1, p2] = parsed().sections[0].items.filter((i) => i.type === 'paragraph');
  assert.deepEqual(p1.scriptures.map((r) => [r.book, r.chapter, r.verses]), [[26, 36, '11'], [26, 36, '22'], [26, 39, '7']]);
  assert.deepEqual(p2.scriptures.map((r) => [r.book, r.chapter, r.verses]), [[5, 24, '16'], [5, 30, '19']]);
  assert.equal(p2.scriptures[0].book_name, '신명기');
  assert.match(p1.scriptures[0].wol_url, /^https:\/\/wol\.jw\.org\/ko\/wol\/b\/r8\/lp-ko\/nwtsty\/26\/36$/);
});

test('보충 자료의 배울 수 있는 점·설명·표·그림을 나눈다', () => {
  const sup = parsed().sections[0].items.find((i) => i.type === 'supplement');
  assert.equal(sup.id, '26-다');
  assert.equal(sup.title, '연대표 제목');
  assert.deepEqual(sup.learning_points, ['꼭 낭독할 점']);
  assert.deepEqual(sup.description, ['설명 문장']);
  assert.deepEqual(sup.rows, [['4:1-3', '성취되다 (왕하 25:1)']]);
  assert.deepEqual(sup.figures, ['그림 설명']);
  assert.equal(sup.scriptures[0].book, 12);
});

test('끝부분 복습 질문과 각주', () => {
  const ch = parsed();
  assert.equal(ch.review.heading, '에스겔서에서 얻을 수 있는 유익');
  assert.equal(ch.review.groups[0].title, '1. 여호와와 더 가까워지세요');
  assert.equal(ch.review.groups[0].questions[0].scriptures[0].verses, '18, 19, 22');
  assert.equal(ch.review.groups[1].questions[0].text, '4. 또 어떤 점을 배웠습니까?');
  assert.deepEqual(ch.footnotes, ['a 각주 내용']);
  assert.equal(ch.counts.review_questions, 2);
});

test('항 범위로 자르면 범위 밖 항·상자·복습이 빠진다', () => {
  const part = filterParagraphs(parsed(), '1-2');
  const types = part.sections.flatMap((s) => s.items.map((i) => i.type));
  assert.deepEqual(types, ['question', 'paragraph', 'paragraph', 'supplement']);
  assert.equal(part.review, null);
  const tail = filterParagraphs(parsed(), '3-4');
  assert.ok(tail.review);
  assert.throws(() => filterParagraphs(parsed(), 'abc'));
});

test('인용·절 표기 파싱', () => {
  assert.deepEqual(expandVerses('25-28'), [25, 26, 27, 28]);
  assert.deepEqual(expandVerses('18, 19, 22'), [18, 19, 22]);
  assert.deepEqual(expandVerses('1–3:27'), [1]);
  const ctx = { book: 26, chapter: null };
  assert.equal(parseCitation('—34:25-28;', ctx, 'KO').verses, '25-28');
  assert.equal(parseCitation('고후 6:16;', ctx, 'KO').book, 47);
  assert.equal(parseCitation(' 21:3', ctx, 'KO').book, 47);
});

test('책 지정은 번호·한국어·약칭·영어 모두 받는다', () => {
  assert.equal(resolveBook(26), 26);
  assert.equal(resolveBook('에스겔'), 26);
  assert.equal(resolveBook('겔'), 26);
  assert.equal(resolveBook('Ezekiel', 'E'), 26);
  assert.throws(() => resolveBook(67));
});

test('목차에서 장 문서만 골라낸다', () => {
  const html = `<a href="/ko/wol/d/r8/lp-ko/1102026526">성경 제26권 에스겔</a>
                <a href="/ko/wol/d/r8/lp-ko/1102026568">이 책을 활용하는 방법</a>`;
  const items = parseToc(html, { rsconf: 'r8', lib: 'lp-ko' });
  assert.equal(items[0].book_num, 26);
  assert.equal(items[1].book_num, null);
});

test('텍스트 정리본에 출처와 낭독할 점이 표시된다', () => {
  const text = renderText(parsed());
  assert.match(text, /출처: https:\/\/wol\.jw\.org\/x/);
  assert.match(text, /★ 배울 수 있는 점 \(낭독\): 꼭 낭독할 점/);
  assert.match(text, /\[1항\] 첫 항/);
});
