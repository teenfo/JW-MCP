/**
 * 범용 WOL 문서 파서와 「성경 안내서」 층 — 네트워크 없이 돈다.
 *
 * 픽스처는 2026-11-06 에 실측한 wol.jw.org 페이지의 **구조만** 흉내 낸 합성 HTML 이다
 * (원문 텍스트는 저장소에 넣지 않는다). 하나의 파서가 서로 다른 두 서적 —
 * 「성경 안내서」(gwt)와 「용기」(wcg) — 을 모두 읽는지가 이 파일의 핵심 계약이다.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWolDocument,
  parseCitation,
  expandVerses,
  filterParagraphs,
  resolveBook,
  renderDocumentText,
  parseToc,
  docidFromUrl,
} from '../src/tools/wol-document.js';
import { renderGuidebookText, DOC_BASE } from '../src/tools/guidebook-tools.js';

// ---------------------------------------------------------------------------
// 「성경 안내서」 구조 (gwt)
// ---------------------------------------------------------------------------
const GWT = `
<a href="/ko/wol/publication/r8/lp-ko/gwt/4" class="spriteLink ellipsized"><span class="icon"></span>하진장 26</a>
<article id="article" class="article document html5 pub- docId-1102026526 pub-gwt docClass-13">
 <header>
  <div><p id="p1" class="contextTtl">성경 제26권</p><h1 id="p2">에스겔</h1></div>
 </header>
 <div class="alternatePresentation"><div class="title">인쇄판</div></div>
 <div class="openingContent">
  <p id="p3">요점: 요점 내용</p>
  <p id="p4">성경 주제와의 연관성: 연관성 내용</p>
  <p id="p5">필자: 에스겔</p>
  <div class="boxSupplement"><aside><div class="boxTtl"><h2>성경 책 목록</h2></div>
   <div class="boxContent"><p>기록이 완료된 책:</p><p>창세기, 출애굽기</p></div></aside></div>
 </div>
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
   <div class="gen-field"><textarea></textarea></div>
   <p id="p12"><span class="parNum" data-pnum="3"></span>셋째 항</p>
  </div>
  <div id="tt26">
   <h2 id="p22">이 책의 내용</h2>
   <p id="p84" class="qu">4. 넷째 질문입니까?</p>
   <div class="gen-field"><textarea></textarea></div>
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

// ---------------------------------------------------------------------------
// 「용기」 구조 (wcg) — 번호 항 없음, p.qu 없음, 답 칸으로 토의 질문을 표시
// ---------------------------------------------------------------------------
const WCG = `
<article id="article" class="article document html5 pub- docId-1102025915 pub-wcg docClass-13">
 <header>
  <figure></figure>
  <p id="p1" class="contextTtl">15 인물들</p>
  <h1 id="p2">장 제목</h1>
 </header>
 <div class="bodyTxt">
  <div id="tt4">
   <p id="p3">이야기 첫 문단 (<a class="b" data-bid="1-1" href="#">룻 1:16</a>)</p>
   <p id="p4">이야기 둘째 문단</p>
   <div class="stdPullQuote"><p id="p46">인용 반복</p></div>
  </div>
  <div><figure><figcaption><p>장면 그림 설명</p></figcaption></figure></div>
 </div>
 <h3 id="p11">성경 기록을 읽어 보십시오</h3>
 <ul><li><p id="p12">룻기 1:1–4:22</p></li></ul>
 <h3 id="p13">토의해 보십시오</h3>
 <p id="p14">어떻게 용기를 나타냈습니까?</p>
 <div id="p15" class="gen-field"><label>답을 적는 칸</label><textarea></textarea></div>
 <div>
  <h2 id="p16">더 깊이 알아보기</h2>
  <ul>
   <li><p id="p17">1. 깊이 묻는 질문입니까? (「믿본」 39면 23항)</p><div id="p18" class="gen-field"><textarea></textarea></div></li>
   <li><p id="p20">2. 두 번째 질문입니까? (<a class="b" data-bid="2-1" href="#">룻 2:8</a>)</p><div class="gen-field"><textarea></textarea></div></li>
  </ul>
 </div>
 <h2 id="p40">더 찾아보기</h2>
 <p id="p41">더 생각해 볼 질문입니까?</p>
 <p id="p42">“참고 기사 제목” (「파21.11」 8-13면)</p>
</article>`;

const gwt = () => parseWolDocument(GWT, { langCode: 'KO', defaultBook: 26, url: 'https://wol.jw.org/x' });
const wcg = () => parseWolDocument(WCG, { langCode: 'KO', url: 'https://wol.jw.org/y' });
const types = (doc) => doc.sections.flatMap((s) => s.items.map((i) => i.type));

// ---------------------------------------------------------------------------

test('문서의 출판물 기호·번호·장 머리를 article 에서 읽는다', () => {
  const g = gwt();
  assert.equal(g.symbol, 'gwt');
  assert.equal(g.docid, 1102026526);
  assert.equal(g.citation, '하진장 26');
  assert.equal(g.label, '성경 제26권');
  assert.equal(g.title, '에스겔');
  const w = wcg();
  assert.equal(w.symbol, 'wcg');
  assert.equal(w.docid, 1102025915);
  assert.equal(w.label, '15 인물들');
});

test('여는 상자(주요 정보 네모)와 머리 상자를 나누고 중복하지 않는다', () => {
  const g = gwt();
  assert.deepEqual(g.opening.map((k) => k.label), ['요점', '성경 주제와의 연관성', '필자']);
  assert.equal(g.header_boxes[0].title, '성경 책 목록');
  assert.ok(!g.opening.some((k) => k.value.includes('창세기')));
});

test('안내서: 소제목·질문·항을 순서대로, 답란·인용 반복은 건너뛴다', () => {
  const g = gwt();
  assert.deepEqual(g.sections.map((s) => s.heading), ['이 책이 중요한 이유', '이 책의 내용', '에스겔서에서 얻을 수 있는 유익']);
  assert.deepEqual(g.sections[0].items.map((i) => i.type), ['question', 'paragraph', 'paragraph', 'supplement', 'question', 'paragraph']);
  assert.deepEqual(g.sections[0].items[0].paragraphs, [1, 2]);
  assert.ok(g.sections[0].items[2].text.startsWith('둘째 항'), '항 번호 접두어 제거');
  const json = JSON.stringify(g);
  assert.ok(!json.includes('인용 반복'));
  assert.ok(!json.includes('답을 적는 칸'));
  assert.equal(g.parse_warnings.length, 0);
});

test('안내서: 끝부분 목록은 소그룹 제목과 질문으로 나뉜다', () => {
  const last = gwt().sections[2].items;
  assert.deepEqual(last.map((i) => i.type), ['subheading', 'question', 'question']);
  assert.equal(last[0].text, '1. 여호와와 더 가까워지세요');
  assert.equal(last[1].scriptures[0].verses, '18, 19, 22');
  assert.equal(last[2].text, '4. 또 어떤 점을 배웠습니까?');
});

test('용기: 이야기 문단·그림·읽을 기록·토의 질문(답 칸)·심화 질문을 읽는다', () => {
  const w = wcg();
  assert.deepEqual(w.sections.map((s) => s.heading), [null, '성경 기록을 읽어 보십시오', '토의해 보십시오', '더 깊이 알아보기', '더 찾아보기']);
  assert.deepEqual(w.sections[0].items.map((i) => i.type), ['text', 'text', 'figure']);
  assert.equal(w.sections[1].items[0].type, 'list_item');
  assert.deepEqual(w.sections[2].items.map((i) => [i.type, i.text]), [['question', '어떻게 용기를 나타냈습니까?']]);
  assert.deepEqual(w.sections[3].items.map((i) => i.type), ['question', 'question']);
  assert.deepEqual(w.sections[4].items.map((i) => i.type), ['text', 'text'], '답 칸 없는 문단은 질문이 아니다');
  assert.ok(!JSON.stringify(w).includes('인용 반복'));
  assert.equal(w.counts.questions, 3);
  assert.equal(w.counts.paragraphs, 0);
});

test('기본 책이 없는 문서에서는 책 이름 있는 인용만 해석한다', () => {
  const w = wcg();
  assert.deepEqual([w.sections[0].items[0].scriptures[0].book, w.sections[0].items[0].scriptures[0].chapter], [8, 1]);
  const bare = parseCitation('2:8', { book: null, chapter: null }, 'KO');
  assert.equal(bare.book, null);
  assert.equal(bare.text, '2:8');
});

test('안내서: 책 이름 없는 인용은 그 장의 책, 같은 괄호 안에서는 앞 책을 잇는다', () => {
  const [p1, p2] = gwt().sections[0].items.filter((i) => i.type === 'paragraph');
  assert.deepEqual(p1.scriptures.map((r) => [r.book, r.chapter, r.verses]), [[26, 36, '11'], [26, 36, '22'], [26, 39, '7']]);
  assert.deepEqual(p2.scriptures.map((r) => [r.book, r.chapter, r.verses]), [[5, 24, '16'], [5, 30, '19']]);
  assert.equal(p2.scriptures[0].book_name, '신명기');
  assert.match(p1.scriptures[0].wol_url, /^https:\/\/wol\.jw\.org\/ko\/wol\/b\/r8\/lp-ko\/nwtsty\/26\/36$/);
});

test('보충 상자의 배울 수 있는 점·설명·표·그림을 나눈다', () => {
  const sup = gwt().sections[0].items.find((i) => i.type === 'supplement');
  assert.equal(sup.id, '26-다');
  assert.equal(sup.title, '연대표 제목');
  assert.deepEqual(sup.learning_points, ['꼭 낭독할 점']);
  assert.deepEqual(sup.description, ['설명 문장']);
  assert.deepEqual(sup.rows, [['4:1-3', '성취되다 (왕하 25:1)']]);
  assert.deepEqual(sup.figures, ['그림 설명']);
  assert.equal(sup.scriptures[0].book, 12);
});

test('각주', () => {
  assert.deepEqual(gwt().footnotes, ['a 각주 내용']);
});

test('항 범위로 자르면 범위 밖 항·상자·끝부분이 빠진다', () => {
  assert.deepEqual(types(filterParagraphs(gwt(), '1-2')), ['question', 'paragraph', 'paragraph', 'supplement']);
  const tail = filterParagraphs(gwt(), '3-4');
  assert.ok(types(tail).includes('subheading'), '마지막 항을 포함하면 끝부분 목록도 나온다');
  assert.ok(!types(tail).includes('supplement'));
  assert.throws(() => filterParagraphs(gwt(), 'abc'));
  assert.throws(() => filterParagraphs(wcg(), '1-3'), /번호 붙은 항이 없어/);
});

test('인용·절 표기 파싱', () => {
  assert.deepEqual(expandVerses('25-28'), [25, 26, 27, 28]);
  assert.deepEqual(expandVerses('18, 19, 22'), [18, 19, 22]);
  assert.deepEqual(expandVerses('1–3:27'), [1]);
  const ctx = { book: 26, chapter: null };
  assert.equal(parseCitation('—34:25-28;', ctx, 'KO').verses, '25-28');
  assert.equal(parseCitation('고후 6:16;', ctx, 'KO').book, 47);
  assert.equal(parseCitation(' 21:3', ctx, 'KO').book, 47);
  const ob = parseCitation('옵 15', { book: 26, chapter: null }, 'KO');
  assert.deepEqual([ob.book, ob.chapter, ob.verses], [31, 1, '15']);
  assert.equal(parseCitation('라 7:6', { book: 26, chapter: null }, 'KO').book, 15);
});

test('책 지정은 번호·한국어·약칭·영어 모두 받는다', () => {
  assert.equal(resolveBook(26), 26);
  assert.equal(resolveBook('에스겔'), 26);
  assert.equal(resolveBook('겔'), 26);
  assert.equal(resolveBook('Ezekiel', 'E'), 26);
  assert.throws(() => resolveBook(67));
});

test('목차: 그룹 링크와 번호 붙은 문서를 구분한다', () => {
  const html = `<title>용기  (용하) — 워치타워 온라인 라이브러리</title>
    <a href="/ko/wol/publication/r8/lp-ko/wcg/27">2부</a>
    <a href="/ko/wol/d/r8/lp-ko/1102025970">중앙장로회의 편지</a>
    <a href="/ko/wol/d/r8/lp-ko/1102025915">15 나오미와 룻 가슴 아픈 일을 함께 인내하다</a>
    <a href="/ko/wol/d/r8/lp-ko/1102025915#p3">15</a>
    <a href="/ko/wol/publication/r8/lp-ko/gwt/4">다른 출판물</a>`;
  const toc = parseToc(html, { locale: 'ko', rsconf: 'r8', lib: 'lp-ko' }, 'wcg');
  assert.deepEqual(toc.groups.map((g) => g.group), ['27']);
  assert.deepEqual(toc.documents.map((d) => [d.docid, d.number ?? null]), [[1102025970, null], [1102025915, 15]]);
  assert.equal(toc.page_title, '용기 (용하)');
});

test('wol 문서 링크에서 번호를 뽑고 다른 주소는 거부한다', () => {
  assert.equal(docidFromUrl('https://wol.jw.org/ko/wol/d/r8/lp-ko/1102025915'), 1102025915);
  assert.equal(docidFromUrl('https://wol.jw.org/ko/wol/d/r8/lp-ko/1102025915#p3'), 1102025915);
  assert.equal(docidFromUrl('https://example.com/ko/wol/d/r8/lp-ko/1102025915'), null);
});

test('텍스트 정리본: 출처·기호·낭독할 점, 안내서는 주요 정보 네모 이름', () => {
  const text = renderDocumentText(gwt());
  assert.match(text, /출처: https:\/\/wol\.jw\.org\/x/);
  assert.match(text, /출판물 기호: gwt · 문서 번호: 1102026526/);
  assert.match(text, /★ 배울 수 있는 점 \(낭독\): 꼭 낭독할 점/);
  assert.match(text, /\[1항\] 첫 항/);
  assert.match(renderGuidebookText(gwt()), /## 성경 각 책의 주요 정보/);
  assert.equal(DOC_BASE + 26, 1102026526);
  assert.match(renderDocumentText(wcg()), /- \(질문\) 어떻게 용기를 나타냈습니까\?/);
});
