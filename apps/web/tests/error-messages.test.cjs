/* lib/error-messages.ts 변환표 — 영어 detail → 한국어, {"detail":..} 벗기기, 5xx·HTML, 변수 캡처, 원문 보존. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../lib/error-messages.ts'), 'utf8');
const location = { pathname: '/admin/dashboard' };
const context = { exports: {}, console, URL, window: { location } };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
const m = context.exports;
const body = (detail) => JSON.stringify({ detail });

test('rule comment is at the top of the table', () => {
  assert.match(source.slice(0, 900), /숨긴 코드·원문은 자세히\/툴팁으로 볼 수 있어야 한다/);
  assert.match(source.slice(0, 900), /관리자 화면\(영상 송출·시스템·모델 관리·Data Hub·CV·추적\)은 개발 용어 허용 \/\s+\*?\s*기록을 쓰는 사용자 화면은 개발 용어 없이/);
});

const CASES = [
  [409, body('Competition class already exists'), '같은 코드의 대회가 이미 있습니다.'],
  [404, body('Match not found'), '경기를 찾을 수 없습니다. 목록을 새로 고쳐 주세요.'],
  [409, body('Archived matches are read-only'), '보관된 경기는 고칠 수 없습니다. 보관을 풀고 다시 시도하세요.'],
  [403, body('Operator lock held by another user'), '다른 운영자가 이 경기를 기록 중입니다. 운영권을 넘겨받은 뒤 다시 시도하세요.'],
  [409, body('Lock already acquired'), '이미 운영권을 가지고 있습니다.'],
  [409, body('Manual matches do not use streaming'), '영상 없이 기록하는 경기는 중계를 쓰지 않습니다.'],
  [409, body('Archive blocked while match clock is running. Retry with explicit live-action confirmation.'), '경기 시계가 돌고 있어 보관을 바로 할 수 없습니다. 한 번 더 확인하면 진행합니다.'],
  [409, body('Possession reset blocked while match clock is running. Retry with explicit live-action confirmation.'), '경기 시계가 돌고 있어 점유 초기화를 바로 할 수 없습니다. 한 번 더 확인하면 진행합니다.'],
  [409, body('Competition class is used by 3 match(es)'), '이 대회에 경기 3개가 있어 지울 수 없습니다. 경기를 먼저 옮기거나 지우세요.'],
  [409, body('Delete blocked while match clock is running. Retry with explicit live-action confirmation.'), '경기 시계가 돌고 있어 삭제를 바로 할 수 없습니다. 한 번 더 확인하면 진행합니다.'],
  // 관리자 화면 항목으로 빠진 서버 문장(gateway·control 등)은 사용자 화면에서 일반 5xx 안내 + 자세히
  [502, body('gateway start failed: ConnectError: [Errno 111]'), '서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.'],
  [500, body('ZeroDivisionError: division by zero'), '서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
  [503, body('HIGHLIGHT_S3_BUCKET 이 설정되지 않았습니다.'), '영상 저장소 설정이 없습니다. 관리자에게 문의하세요.'],
  [503, body('FINEPLAY_API_TOKEN 이 설정되지 않았습니다.'), 'FinePlay 연결 설정이 없습니다. 관리자에게 문의하세요.'],
  [400, body('first_half_video_start_sec 값은 0 이상이어야 합니다.'), '전반 시작 시간은 0 이상이어야 합니다.'],
  [400, body('start_bg 가 너무 큽니다(20MB 제한).'), '시작 카드 배경 파일이 너무 큽니다(20MB).'],
  [400, body('seq 12 액션이 없습니다.'), '고른 장면이 없습니다. 새로 고쳐 주세요.'],
  [502, body('일부 전송 실패 — home: sent, away: failed: ReadTimeout: timed out'), '일부 전송 실패 — AWAY 전송 실패. 다시 보내 주세요. (HOME 은 전송 완료)'],
  [409, body('생성 가능한 카드가 없습니다. 당진: 당진: 배경 템플릿 없음'), '카드를 만들지 못했습니다. 당진: 배경 템플릿이 없습니다. 템플릿 화면에서 등록하세요.'],
  [409, body('생성 가능한 카드가 없습니다. 서울: KeyError(\'x\')'), '만들 수 있는 카드가 없습니다. 팀 기록을 먼저 저장하세요.'],
  [422, body('태깅이 가리키는 원본이 새 매니페스트에 없습니다: v1, v2. 그대로 바꾸면 렌더가 실패합니다.'), '태그를 단 영상이 새 신청 영상 목록에 없습니다: v1, v2. 그대로 바꾸면 클립을 만들 수 없습니다.'],
  [400, body('Data 시트에 필요한 컬럼이 없습니다: Team, Action'), '엑셀에 필요한 열이 없습니다(Team, Action). FPA에서 내려받은 원본 파일인지 확인하세요.'],
  [404, body('No saved FPA logs for this match'), '이 경기에 저장된 FPA 기록이 없습니다. Live Logger 에서 먼저 저장하세요.'],
  [400, body("Football match name must include 'HOME vs AWAY'"), "경기 이름에 'HOME vs AWAY' 를 넣어 주세요."],
  [400, body('mode must be \'ai\' or \'log_ai\''), 'AI 또는 AI+로그 중에서 고르세요.'],
  // 표에 없는 한국어 detail 은 JSON 껍데기만 벗기고 그대로
  [409, body('신청이 연결돼 있습니다(abc). 연결을 먼저 해제하세요.'), '신청이 연결돼 있습니다(abc). 연결을 먼저 해제하세요.'],
  [400, body('Some new english detail'), 'Some new english detail'],
  // 5xx 원문 감추기
  [500, body('KeyError: HIGHLIGHT_RENDER_QUEUE_URL'), '서버 설정 문제로 처리하지 못했습니다. 관리자에게 알려 주세요.'],
  [500, 'Traceback (most recent call last):\n  File "x.py", line 1, in <module>\nValueError', '서버 설정 문제로 처리하지 못했습니다. 관리자에게 알려 주세요.'],
  [502, '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>', '서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.'],
  [500, 'Internal Server Error', '서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'],
  [500, body('합치기 실패: 메모리가 부족해 인코딩이 중단됐습니다(커널이 ffmpeg 를 종료). 클립 수나 해상도를 줄여 다시 시도해 주세요.'), '서버가 바빠 합치기가 멈췄습니다. 클립 수를 줄이거나 잠시 뒤 다시 요청해 주세요.'],
  [500, body('카드 렌더 중 문제가 생겼습니다.'), '카드 렌더 중 문제가 생겼습니다.'],
  [404, '', '찾을 수 없습니다. 목록을 새로 고쳐 주세요.'],
  [418, '', '요청을 처리하지 못했습니다. (코드 418)'],
  [422, JSON.stringify({ detail: [{ loc: ['body', 'name'], msg: 'field required', type: 'value_error.missing' }] }), '입력값이 올바르지 않습니다. 내용을 확인해 주세요.'],
];

test(`변환표 ${CASES.length}건`, () => {
  for (const [status, text, expected] of CASES) {
    const error = m.errorFromBody(status, text);
    assert.equal(error.message, expected, `${status} ${text}`);
    assert.equal(error.status, status);
    assert.equal(error.raw, text);
  }
});

test('fallback is used only when the server gave no reason', () => {
  assert.equal(m.errorFromBody(500, 'Internal Server Error', { fallback: '경기 목록을 불러오지 못했습니다.' }).message, '경기 목록을 불러오지 못했습니다.');
  assert.equal(m.errorFromBody(409, body('Competition class already exists'), { fallback: '대회를 만들지 못했습니다.' }).message, '같은 코드의 대회가 이미 있습니다.');
  assert.equal(m.errorFromBody(409, body('Lock already acquired'), { action: '저장하지 못했습니다' }).message, '저장하지 못했습니다 — 이미 운영권을 가지고 있습니다.');
  assert.equal(m.errorFromBody(409, body('Lock already acquired'), { fixed: '목록을 불러오지 못했습니다.' }).message, '목록을 불러오지 못했습니다.');
  assert.equal(m.errorFromBody(400, body('At least one stat must be selected'), { overrides: { 'At least one stat must be selected': '스탯을 1개 이상 고르세요.' } }).message, '스탯을 1개 이상 고르세요.');
});

test('detail and code stay available for branching and the fold', () => {
  const stale = JSON.stringify({ detail: { reason: 'stale_command_revision', command_revision: 7 } });
  const error = m.errorFromBody(409, stale, { url: 'POST /api/matches/abc/state' });
  assert.equal(error.code, 'stale_command_revision');
  const fold = m.formatErrorInfo(error.info());
  assert.match(fold, /상태 코드: 409/);
  assert.match(fold, /오류 코드: stale_command_revision/);
  assert.match(fold, /요청: POST \/api\/matches\/abc\/state/);
  assert.match(fold, /"command_revision": 7/);
  const live = m.errorFromBody(409, body('Archive blocked while match clock is running. Retry with explicit live-action confirmation.'));
  assert.equal(m.errorDetail(live), 'Archive blocked while match clock is running. Retry with explicit live-action confirmation.');
  assert.equal(m.errorStatus(live), 409);
  assert.match(m.formatErrorInfo(live.info()), /서버 사유: Archive blocked/);
  // 문자열 state 화면: message 로 원문을 다시 찾는다.
  assert.equal(m.lookupErrorInfo(live.message).status, 409);
});

test('caught browser errors become Korean and keep the raw text', () => {
  assert.equal(m.errorMessage(new TypeError('Failed to fetch'), 'x'), '서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.');
  assert.equal(m.lookupErrorInfo('서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.').raw, 'TypeError: Failed to fetch');
  assert.equal(m.errorMessage(new Error('{"detail":"Match not found"}'), 'x'), '경기를 찾을 수 없습니다. 목록을 새로 고쳐 주세요.');
  assert.equal(m.errorMessage(new Error('Unexpected token < in JSON'), '하이라이트 로그 JSON을 읽지 못했습니다.'), '하이라이트 로그 JSON을 읽지 못했습니다.');
  assert.equal(m.errorMessage(new Error('이미 한국어 문장입니다.'), 'x'), '이미 한국어 문장입니다.');
  assert.equal(m.errorMessage(m.errorFromBody(500, 'oops'), '목록을 불러오지 못했습니다.', { fixed: true }), '목록을 불러오지 못했습니다.');
  assert.equal(m.lookupErrorInfo('목록을 불러오지 못했습니다.').raw, 'oops');
  // 일반 실패 문장은 화면 안내가 이기고, 구체적인 사유(OOM)는 번역이 이긴다.
  assert.equal(m.jobErrorMessage('합치기 실패: Conversion failed!', "합치기 실패 · '합치기 다시 요청'을 눌러 주세요"), "합치기 실패 · '합치기 다시 요청'을 눌러 주세요");
  assert.equal(m.jobErrorMessage('합치기 실패: 메모리가 부족해 인코딩이 중단됐습니다(커널이 ffmpeg 를 종료). 클립 수나 해상도를 줄여 다시 시도해 주세요.', 'x'), '서버가 바빠 합치기가 멈췄습니다. 클립 수를 줄이거나 잠시 뒤 다시 요청해 주세요.');
  assert.equal(m.jobErrorMessage('ZeroDivisionError: division by zero', '분석에 실패했습니다. 다시 시도해 주세요.'), '분석에 실패했습니다. 다시 시도해 주세요.');
  assert.equal(m.lookupErrorInfo('분석에 실패했습니다. 다시 시도해 주세요.').raw, 'ZeroDivisionError: division by zero');
});

test('admin screens show the server text as-is (JSON wrapper removed) and keep the raw', () => {
  location.pathname = '/admin/media';
  try {
    assert.equal(m.isAdminSurface(), true);
    const live = m.errorFromBody(409, body('Stop All Streams blocked while live streams exist. Retry with explicit live-action confirmation.'), { fixed: '무시됨' });
    assert.equal(live.message, 'Stop All Streams blocked while live streams exist. Retry with explicit live-action confirmation.');
    assert.equal(m.errorFromBody(500, '', { fallback: 'Media action failed' }).message, 'Media action failed');
    assert.equal(m.errorFromBody(503, '').message, 'Request failed (503)');
    assert.equal(m.errorFromBody(404, body('Match not found')).message, 'Match not found');
    assert.equal(m.errorMessage(new Error('{"detail":"MEDIA_CONTROL_URL not configured"}'), 'x'), 'MEDIA_CONTROL_URL not configured');
    assert.equal(m.jobErrorMessage('합치기 실패: Conversion failed!', '처리에 실패했습니다.'), '합치기 실패: Conversion failed!');
    assert.match(m.formatErrorInfo(live.info()), /상태 코드: 409/);
    for (const path of ['/admin/system', '/admin/fpa/reports', '/admin/data-hub', '/fpa-cv', '/admin/futsal/fpa/tracking', '/admin/highlight/process/abc']) assert.equal(m.isAdminSurface(path), true, path);
    for (const path of ['/admin/dashboard', '/admin/match/x', '/admin/highlight/clips', '/admin/fpa/live', '/admin/fcm/templates', '/admin/mediax']) assert.equal(m.isAdminSurface(path), false, path);
  } finally {
    location.pathname = '/admin/dashboard';
  }
});
