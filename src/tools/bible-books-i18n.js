/**
 * 성경 책 이름 — 언어별.
 *
 * 상류는 영어 이름과 영어 약칭만 알아서 `search_bible_books(query="잠언")` 이
 * "찾을 수 없음" 을 돌려줬다. 한국어 사용자는 책 번호를 알아낼 방법이 없어 번호표를
 * 프롬프트에 직접 박아 넣어야 했다.
 *
 * 이름은 신세계역(한국어) 표기를 따르고, 약칭은 집회에서 실제로 쓰는 것들을 넣는다
 * (잠, 시, 마, 고전 …). 공백·가운뎃점 유무를 사용자가 신경 쓰지 않도록 검색 쪽에서
 * 정규화한다.
 */

/** 언어 코드 → { 책번호: [정식명, ...별칭] } */
export const BOOK_NAMES_I18N = {
  KO: {
    1: ['창세기', '창'], 2: ['출애굽기', '출'], 3: ['레위기', '레'], 4: ['민수기', '민'],
    5: ['신명기', '신'], 6: ['여호수아', '수'], 7: ['판관기', '판', '사사기'], 8: ['룻기', '룻'],
    9: ['사무엘 상', '삼상', '사무엘상'], 10: ['사무엘 하', '삼하', '사무엘하'],
    11: ['열왕기 상', '왕상', '열왕기상'], 12: ['열왕기 하', '왕하', '열왕기하'],
    13: ['역대기 상', '대상', '역대상', '역대기상'], 14: ['역대기 하', '대하', '역대하', '역대기하'],
    15: ['에스라', '스'], 16: ['느헤미야', '느'], 17: ['에스더', '더'], 18: ['욥기', '욥'],
    19: ['시편', '시'], 20: ['잠언', '잠'], 21: ['전도서', '전'], 22: ['아가', '아'],
    23: ['이사야', '사'], 24: ['예레미야', '렘'], 25: ['애가', '애', '예레미야 애가'],
    26: ['에스겔', '겔'], 27: ['다니엘', '단'], 28: ['호세아', '호'], 29: ['요엘', '욜'],
    30: ['아모스', '암'], 31: ['오바댜', '옵'], 32: ['요나', '욘'], 33: ['미가', '미'],
    34: ['나훔', '나'], 35: ['하박국', '합'], 36: ['스바냐', '습'], 37: ['학개', '학'],
    38: ['스가랴', '슥'], 39: ['말라기', '말'],

    40: ['마태복음', '마', '마태'], 41: ['마가복음', '막', '마가'], 42: ['누가복음', '눅', '누가'],
    43: ['요한복음', '요', '요한'], 44: ['사도행전', '행'], 45: ['로마서', '롬'],
    46: ['고린도 전서', '고전', '고린도전서'], 47: ['고린도 후서', '고후', '고린도후서'],
    48: ['갈라디아서', '갈'], 49: ['에베소서', '엡'], 50: ['빌립보서', '빌'],
    51: ['골로새서', '골'], 52: ['데살로니가 전서', '살전', '데살로니가전서'],
    53: ['데살로니가 후서', '살후', '데살로니가후서'],
    54: ['디모데 전서', '딤전', '디모데전서'], 55: ['디모데 후서', '딤후', '디모데후서'],
    56: ['디도서', '딛'], 57: ['빌레몬서', '몬'], 58: ['히브리서', '히'], 59: ['야고보서', '약'],
    60: ['베드로 전서', '벧전', '베드로전서'], 61: ['베드로 후서', '벧후', '베드로후서'],
    62: ['요한 1서', '요일', '요한1서'], 63: ['요한 2서', '요이', '요한2서'],
    64: ['요한 3서', '요삼', '요한3서'], 65: ['유다서', '유'], 66: ['요한 계시록', '계', '계시록'],
  },
};

/** 검색 비교용 정규화 — 공백·가운뎃점·마침표를 없애고 소문자로. */
export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s·.]/g, '')
    .trim();
}

/** 해당 언어의 정식 책 이름. 없으면 null. */
export function getLocalizedBookName(bookNum, langwritten) {
  const table = BOOK_NAMES_I18N[String(langwritten || '').toUpperCase()];
  return table?.[bookNum]?.[0] ?? null;
}

/**
 * 언어별 이름·약칭으로 책을 찾는다.
 * @returns {Array<{number: number, name: string, score: number, matched: string}>}
 */
export function searchLocalizedBooks(query, langwritten, limit = 10) {
  const table = BOOK_NAMES_I18N[String(langwritten || '').toUpperCase()];
  if (!table) return [];

  const q = normalizeName(query);
  if (!q) return [];

  const results = [];
  for (const [num, names] of Object.entries(table)) {
    let best = 0;
    let matched = null;

    for (const name of names) {
      const n = normalizeName(name);
      let score = 0;
      if (n === q) score = 100;
      else if (n.startsWith(q)) score = 85;
      else if (q.startsWith(n)) score = 75; // "잠언13" 처럼 뒤에 뭐가 붙은 경우
      else if (n.includes(q)) score = 60;

      if (score > best) {
        best = score;
        matched = name;
      }
    }

    if (best > 0) results.push({ number: parseInt(num, 10), name: names[0], score: best, matched });
  }

  return results.sort((a, b) => b.score - a.score || a.number - b.number).slice(0, limit);
}
