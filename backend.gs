/**
 * 유쾌한 소정샘의 역사 Class - Apps Script 백엔드 (Firebase 버전용)
 * 실시간 화면(달력·자료)은 Firebase 가 맡고, 이 스크립트는
 *   ① "기록" 시트에 기록  ② Gemini(AI 보조선생님) 호출  ③ 노션 과제 등록
 * 을 맡습니다. 비밀 키(Gemini·노션)는 여기 스크립트 속성에만 있습니다.
 *
 * [스크립트 속성]  GEMINI_API_KEY, NOTION_TOKEN, FIREBASE_API_KEY(웹 API 키)
 * 모든 요청은 Firebase 로그인 토큰(idToken)을 확인한 뒤 처리합니다.
 */
const CFG = {
  SHEET_ID: '11mGWsmflG2aHBZwKcZ7StCyfDskFr_EnLTx74y9M1FE',
  SHEET_NAME: '기록',
  TEACHER_EMAIL: 'teacher@sojeong.kr',          // index.html 의 TEACHER_EMAIL 과 같게
  GEMINI_MODEL: 'gemini-3.6-flash',
  NOTION_DB_ID: '840e81aa88cf4c72b6199367471452d1',
  AI_COOLDOWN_SEC: 5
};
const HEADERS = ['순번', '일시', '구분', '수업일', '학반', '번호', '이름', '제목', '내용', '링크', '부가(JSON)', '상태'];
const STUDENT_LOG = ['입장'];
const TEACHER_LOG = ['수업', '사전학습', '심화탐구', '오늘의역사'];

function doGet() { return ContentService.createTextOutput('소정샘의 역사 Class 서버 정상 동작 중'); }

function doPost(e) {
  let out;
  try {
    const b = JSON.parse(e.postData.contents);
    const user = verify_(b.idToken);
    const teacher = user.email === CFG.TEACHER_EMAIL;
    switch (b.action) {
      case 'log':    out = log_(b, teacher); break;
      case 'ask':    out = ask_(b, user); break;
      case 'submit': out = submit_(b); break;
      default: throw new Error('알 수 없는 요청');
    }
  } catch (err) {
    out = { ok: false, error: String(err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Firebase idToken 검증 (익명 로그인도 가능). 5분 캐시. */
function verify_(idToken) {
  if (!idToken) throw new Error('로그인이 필요합니다.');
  const cache = CacheService.getScriptCache();
  const key = 'tk_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const apiKey = PropertiesService.getScriptProperties().getProperty('FIREBASE_API_KEY');
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + apiKey, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('인증에 실패했습니다.');
  const u = (JSON.parse(res.getContentText()).users || [])[0];
  if (!u) throw new Error('인증에 실패했습니다.');
  const user = { uid: u.localId, email: u.email || '' };
  cache.put(key, JSON.stringify(user), 300);
  return user;
}

/* ------------------------------ 시트 ------------------------------ */

function setup() { sheet_(); return '완료'; }

function sheet_() {
  const ss = SpreadsheetApp.openById(CFG.SHEET_ID);
  let sh = ss.getSheetByName(CFG.SHEET_NAME);
  if (!sh) {
    const all = ss.getSheets();
    if (all.length === 1) { sh = all[0]; sh.setName(CFG.SHEET_NAME); } else sh = ss.insertSheet(CFG.SHEET_NAME);
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#fde68a');
    sh.setFrozenRows(1);
  }
  return sh;
}

function now_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'); }

/** 시트에서 수식으로 실행되지 않도록 = + - @ 로 시작하면 앞에 ' 를 붙임 */
function safe_(v, max) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const s = String(v).slice(0, max || 500);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function safeUrl_(u) { u = String(u || '').trim(); return /^https?:\/\//i.test(u) ? u : ''; }

function append_(type, o) {
  o = o || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const sh = sheet_();
    const last = sh.getLastRow();
    const seq = last <= 1 ? 1 : Number(sh.getRange(last, 1).getValue()) + 1;
    sh.appendRow([seq, now_(), type, safe_(o.date), safe_(o.cls, 10), safe_(o.no, 5), safe_(o.name, 20), safe_(o.title, 200),
      safe_(o.body, 3000), safeUrl_(o.link), o.extra ? JSON.stringify(o.extra).slice(0, 1000) : '', safe_(o.status, 20)]);
  } finally { lock.releaseLock(); }
}

function log_(b, teacher) {
  const ok = teacher ? STUDENT_LOG.concat(TEACHER_LOG) : STUDENT_LOG;
  if (ok.indexOf(b.type) < 0) throw new Error('허용되지 않은 기록');
  append_(b.type, b);
  return { ok: true };
}

/* ------------------------------ AI 보조선생님 (Gemini) ------------------------------ */

function ask_(b, user) {
  const text = String(b.text || '').trim().slice(0, 2000);
  if (!text && !b.image) throw new Error('용어를 입력하거나 사진을 올려주세요.');
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY가 설정되지 않았습니다.');
  const cache = CacheService.getScriptCache();
  if (cache.get('ai_' + user.uid)) throw new Error('잠깐만요! ' + CFG.AI_COOLDOWN_SEC + '초 뒤에 다시 질문해 주세요.');
  cache.put('ai_' + user.uid, '1', CFG.AI_COOLDOWN_SEC);

  const parts = [];
  if (text) parts.push({ text: text });
  if (b.image && b.image.data) {
    if (String(b.image.data).length > 4000000) throw new Error('사진이 너무 큽니다.');
    parts.push({ inline_data: { mime_type: String(b.image.mime || 'image/jpeg'), data: b.image.data } });
  }
  const body = {
    system_instruction: { parts: [{ text:
      '너는 "유쾌한 소정샘의 역사 Class"의 AI 보조 선생님이야. 중·고등학생에게 한국사·세계사 용어와 사진(사료, 유물, 지도 등)을 쉽고 친절한 존댓말로 설명해 줘. ' +
      '형식: 1) 한 줄 뜻 2) 시기·배경 3) 핵심 포인트 2~3개 4) 함께 알면 좋은 용어. 전체 400자 내외. 역사와 무관한 질문은 정중히 사양하고, 확실하지 않은 내용은 추측하지 말고 모른다고 말해.' }] },
    contents: [{ role: 'user', parts: parts }],
    generationConfig: { maxOutputTokens: 1024 }
  };
  const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + CFG.GEMINI_MODEL + ':generateContent', {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: JSON.stringify(body), muteHttpExceptions: true
  });
  const json = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) throw new Error('AI 응답 오류(' + res.getResponseCode() + '): ' + ((json.error && json.error.message) || '').slice(0, 120));
  const ans = (((json.candidates || [])[0] || {}).content || {}).parts;
  const out = ans ? ans.map(function (x) { return x.text || ''; }).join('') : '';
  if (!out) throw new Error('AI가 답변을 만들지 못했어요. 다시 시도해 주세요.');
  append_('AI질문', { date: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'), cls: b.cls, no: b.no, name: b.name, title: text, body: out, extra: { image: !!b.image } });
  return { ok: true, answer: out };
}

/* ------------------------------ 보고서 → 노션 ------------------------------ */

function submit_(b) {
  const name = String(b.name || '').trim(), title = String(b.title || '').trim(), link = safeUrl_(b.link);
  if (!name || !title) throw new Error('이름과 과제명을 입력하세요.');
  if (!link) throw new Error('제출 링크는 http(s)로 시작해야 합니다.');
  const token = PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN');
  if (!token) throw new Error('NOTION_TOKEN이 설정되지 않았습니다.');
  const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  const props = {
    '학생 이름': { title: [{ text: { content: name.slice(0, 100) } }] },
    '학년·반': { rich_text: [{ text: { content: String(b.cls || '').slice(0, 50) } }] },
    '과제명': { rich_text: [{ text: { content: title.slice(0, 200) } }] },
    '제출 링크': { url: link },
    '제출일': { date: { start: today } },
    '확인 상태': { status: { name: '제출 완료' } }
  };
  if (b.no !== '' && b.no != null && !isNaN(Number(b.no))) props['번호'] = { number: Number(b.no) };
  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, 'Notion-Version': '2022-06-28' },
    payload: JSON.stringify({ parent: { database_id: CFG.NOTION_DB_ID }, properties: props }), muteHttpExceptions: true
  });
  const ok = res.getResponseCode() === 200;
  append_('보고서', { date: today, cls: b.cls, no: b.no, name: name, title: title, link: link, status: ok ? '노션 등록' : '노션 실패' });
  if (!ok) throw new Error('노션 등록 실패(' + res.getResponseCode() + '). 선생님께 알려주세요.');
  return { ok: true };
}
