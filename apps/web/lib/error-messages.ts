/**
 * FPC 화면 오류 문구 — 서버 detail·예외 원문을 화면용 한국어 한 줄로 바꾼다.
 *
 * ⚠️ 규칙: 숨긴 코드·원문은 자세히/툴팁으로 볼 수 있어야 한다.
 *   한국어로 바꾸거나 줄여서 화면에서 감춘 코드·ID·enum·HTTP 상태·오류 코드·원문은 지우지 말고
 *   "자세히"(components/ErrorNotice) 또는 툴팁(title)으로 언제든 다시 볼 수 있게 남긴다.
 *   이후 라운드(held/sent 같은 상태값 매핑, HOME/AWAY 표기 등)도 같은 규칙을 따른다.
 * ⚠️ 규칙: 관리자 화면(영상 송출·시스템·모델 관리·Data Hub·CV·추적)은 개발 용어 허용 /
 *   기록을 쓰는 사용자 화면은 개발 용어 없이. (11-04 승준)
 *   관리자 화면(ADMIN_SURFACES)에서는 번역·화면 문장 대신 서버 문장을 그대로(JSON 껍데기만 벗겨)
 *   보여 주고, 원문 전체는 자세히로 남긴다.
 *
 * - 서버 문자열은 바꾸지 않는다. FinePlay 앱·협업사 API(/api/v1, /api/internal/xfp)·테스트가
 *   같은 detail 을 받으므로, 웹에서만 이 표로 번역한다.
 * - 표에 없는 detail 은 서버 문장을 그대로 보여 주되 JSON 껍데기({"detail":...})는 벗긴다.
 * - 5xx 에 환경 변수 이름·스택·HTML 본문이 오면 일반 안내로 바꾸고 원문은 자세히로 접는다.
 * - 오류 문구로 분기하는 코드는 message(번역된 문구) 대신 status·detail(서버 원문)로 판정한다.
 */

export type ErrorInfo = {
  /** 화면에 보일 한국어 한 줄. */
  message: string;
  /** HTTP 상태. 네트워크 오류·브라우저 예외는 없다. */
  status?: number;
  /** 서버 detail 원문(문자열이면 그대로, 객체면 JSON). */
  detail?: string;
  /** 본문의 code/error/reason 같은 식별 필드. */
  code?: string;
  /** 응답 본문 또는 예외 문자열 원문. */
  raw?: string;
  /** 요청 주소(경기·작업 ID 가 들어 있다). */
  url?: string;
  /** 화면이 덧붙이는 ID 등 (예: { '작업 ID': '...' }). */
  context?: Record<string, string | number | null | undefined>;
};

/** 번역표의 정확히 일치하는 서버 문장 → 한국어. */
const EXACT: Record<string, string> = {
  // 공통 · 로그인
  'Not authenticated': '로그인이 필요합니다. 다시 로그인해 주세요.',
  'Authentication required': '로그인이 필요합니다. 다시 로그인해 주세요.',
  'Superadmin only': '관리자만 할 수 있습니다.',
  // FLA 경기·대회
  'Match not found': '경기를 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
  'Archived matches are read-only': '보관된 경기는 고칠 수 없습니다. 보관을 풀고 다시 시도하세요.',
  'Operator lock held by another user': '다른 운영자가 이 경기를 기록 중입니다. 운영권을 넘겨받은 뒤 다시 시도하세요.',
  'Administrator takeover required': '다른 운영자가 기록 중입니다. 관리자가 운영권을 넘겨받아야 합니다.',
  'Not lock owner': '운영권이 없습니다.',
  'Lock already acquired': '이미 운영권을 가지고 있습니다.',
  'GATEWAY_API_BASE not configured': '중계 서버 연결 설정이 없습니다. 관리자에게 문의하세요.',
  "Competition class code can use Korean, A-Z, 0-9, and '-' only": "대회 코드는 한글·영문 대문자·숫자·'-'만 쓸 수 있습니다.",
  'Competition class already exists': '같은 코드의 대회가 이미 있습니다.',
  'Competition class name is required': '표시 이름을 입력해 주세요.',
  'Competition class not found': '대회를 찾을 수 없습니다.',
  "Match name must follow '[CLASS | 1R] HOME vs AWAY' format": "경기 이름은 '[대회 | 1R] HOME vs AWAY' 형식으로 적어 주세요.",
  'Unknown competition class': '없는 대회입니다.',
  'Competition class does not match match name format': '경기 이름의 대회가 선택한 대회와 다릅니다.',
  'Round number does not match match name format': '경기 이름의 라운드가 다릅니다.',
  'Unsupported team': '팀을 고르세요.',
  'Empty logo file': '빈 파일입니다.',
  'Logo file is too large': '파일이 너무 큽니다.',
  'Unsupported logo image': 'PNG·JPG 이미지만 올릴 수 있습니다.',
  'Unsupported fullscreen scene': '고를 수 없는 Fullscreen 장면입니다.',
  'Empty fullscreen image': '빈 파일입니다.',
  'Fullscreen image is too large': '파일이 너무 큽니다.',
  'Unsupported fullscreen image': 'PNG·JPG 이미지만 올릴 수 있습니다.',
  'Player number is required': '등번호를 입력하세요.',
  'Invalid player number': '등번호가 올바르지 않습니다.',
  'Player name is required': '선수 이름을 입력하세요.',
  'No lineup players to swap': '바꿀 명단이 없습니다.',
  'clock_ms missing and no state exists': '경기 시간이 아직 없습니다. 경기 시작을 먼저 눌러 주세요.',
  'ATTACK_LANE requires team and lane': '공격 방향 기록에는 팀과 방향이 필요합니다.',
  'XG event requires team and xg': '슈팅 기록에는 팀과 xG 값이 필요합니다.',
  'Manual matches do not use streaming': '영상 없이 기록하는 경기는 중계를 쓰지 않습니다.',
  'ingest_url is required unless ingest_protocol is RTMP': '송출 주소를 입력하세요 (RTMP 는 주소 없이 됩니다).',
  'Lineup upload must be a PDF': 'PDF 명단은 PDF 파일만 올릴 수 있습니다.',
  'Lineup record sheet must be an Excel file (.xlsx or .xlsm)': '엑셀 명단은 Excel 파일(.xlsx·.xlsm)만 올릴 수 있습니다.',
  'clock_ms is required with request_id': '경기 시간이 없어 저장하지 못했습니다. 다시 시도해 주세요.',
  '명단 방향은 AUTO, HOME, AWAY 중 선택하세요.': '명단 방향은 자동·HOME·AWAY 중에서 고르세요.',
  'FLA 경기 상세 업로드는 경기당 파일 1개입니다. 실제 경기 시트가 하나만 남도록 업로드해 주세요.': '경기 하나에 기록지 하나만 올릴 수 있습니다. 이 경기 시트만 남긴 파일을 올려 주세요.',
  'Highlight request ID already has different content': '같은 하이라이트 요청이 다른 내용으로 이미 저장돼 있습니다. 화면을 새로 고친 뒤 다시 눌러 주세요.',
  'Event editor is available for archived matches only': '기록 수정은 보관된 경기에서만 할 수 있습니다.',
  'Unsupported item kind': '수정할 수 없는 기록입니다.',
  'Unsupported timeline item type': '수정할 수 없는 기록입니다.',
  'Event not found': '기록을 찾을 수 없습니다. 새로 고쳐 주세요.',
  'Marker not found': '기록을 찾을 수 없습니다. 새로 고쳐 주세요.',
  // 하이라이트(FHL)
  '로그에서 유효한 이벤트(GOAL/SHOT)를 찾지 못했습니다.': '로그에서 골·슈팅 기록을 찾지 못했습니다.',
  "mode must be 'ai' or 'log_ai'": 'AI 또는 AI+로그 중에서 고르세요.',
  'log_data_json must be an array': '로그 파일을 읽지 못했습니다. JSON 로그 파일을 다시 고르세요.',
  'Job is not completed yet': '아직 작업이 끝나지 않았습니다.',
  'No clips selected': '클립을 고르세요.',
  'Invalid clip order': '클립 순서가 올바르지 않습니다.',
  'None of the selected clips exist': '고른 클립이 없습니다.',
  'Export file missing': '내보낸 파일이 없습니다.',
  'Export not found': '내보낸 파일이 없습니다.',
  'Job not found': '작업을 찾을 수 없습니다.',
  'Clip not found': '클립을 찾을 수 없습니다.',
  'team_side 는 home / away / 빈 값 중 하나여야 합니다.': 'HOME·AWAY 중에서 고르거나 비워 두세요.',
  '클립의 원본 잡이 없습니다.': '이 클립을 만든 작업을 찾을 수 없습니다.',
  'competition.fpcCompetitionId 는 필수입니다.': '보낼 대회를 고르세요.',
  'seq 는 필수입니다.': '장면을 고르세요.',
  'manifest 또는 clips 가 없습니다.': '신청 정보나 태그가 없어 클립을 만들 수 없습니다.',
  'FinePlay 신청 claim 이 거부됐습니다.': '신청을 가져오지 못했습니다. 다른 담당자가 작업 중인지 확인하세요.',
  '매니페스트에 영상이 없습니다.': '이 신청에 영상이 없습니다. 신청 영상을 다시 불러오세요.',
  '새 매니페스트에 영상이 없습니다.': '새로 받은 신청에 영상이 없습니다.',
  'HIGHLIGHT_S3_BUCKET 이 설정되지 않았습니다.': '영상 저장소 설정이 없습니다. 관리자에게 문의하세요.',
  'part_count 는 1~10000 이어야 합니다.': '영상 업로드 정보가 올바르지 않습니다. 다시 올려 주세요.',
  'upload_id·parts 가 필요합니다.': '영상 업로드 정보가 올바르지 않습니다. 다시 올려 주세요.',
  'upload_id 가 필요합니다.': '영상 업로드 정보가 올바르지 않습니다. 다시 올려 주세요.',
  '파트 ETag 가 비었습니다 — 버킷 CORS 의 ExposeHeaders 에 ETag 를 넣어야 합니다.': '영상 업로드를 마치지 못했습니다. 관리자에게 문의하세요 (저장소 설정 문제).',
  'team_name, opponent_name 은 필수입니다.': '우리 팀과 상대 팀 이름을 입력하세요.',
  'analysisRequestId 는 필수입니다.': '연결할 신청을 고르세요.',
  'lineup 은 비어 있을 수 없습니다.': '명단이 비어 있습니다. 선수를 한 명 이상 넣으세요.',
  'assignments 가 올바른 JSON 이 아닙니다.': '시트와 경기 연결이 올바르지 않습니다. 시트별 경기를 다시 고르세요.',
  'assignments 는 {시트명: job_id} 형식이어야 합니다.': '시트와 경기 연결이 올바르지 않습니다. 시트별 경기를 다시 고르세요.',
  'FINEPLAY_API_TOKEN 이 설정되지 않았습니다.': 'FinePlay 연결 설정이 없습니다. 관리자에게 문의하세요.',
  '이 잡에 FinePlay 신청 번호가 없습니다.': '이 작업에 연결된 신청이 없습니다.',
  'clips 형식이 올바르지 않습니다.': '태그 구간이 올바르지 않습니다.',
  '유효한 구간(end > start)이 없습니다.': '끝이 시작보다 뒤인 구간이 없습니다. 태그를 확인하세요.',
  'fpaMatchId 는 UUID 형식이어야 합니다.': '연결할 FPA 경기를 다시 고르세요.',
  'fpaOurSide 는 home 또는 away 여야 합니다.': '우리 팀이 HOME 인지 AWAY 인지 고르세요.',
  'FinePlay 작업이 아닙니다.': 'FinePlay 신청 작업을 찾을 수 없습니다. 목록을 새로 고쳐 주세요.',
  '사전 작업 원본 경로가 아닙니다.': '이 영상은 지금 작업에 쓸 수 없습니다. 다시 올려 주세요.',
  '클립 제작 완료(done) 후에만 원본을 삭제할 수 있습니다.': '클립을 다 만든 뒤에만 원본을 지울 수 있습니다.',
  '메모리가 부족해 인코딩이 중단됐습니다(커널이 ffmpeg 를 종료). 클립 수나 해상도를 줄여 다시 시도해 주세요.': '서버가 바빠 합치기가 멈췄습니다. 클립 수를 줄이거나 잠시 뒤 다시 요청해 주세요.',
  'source_key 또는 segments 가 없습니다.': '원본 영상이나 구간 정보가 없습니다. 다시 만들어 주세요.',
  'segments 형식이 올바르지 않습니다.': '원본 영상이나 구간 정보가 없습니다. 다시 만들어 주세요.',
  '클립 index 가 올바르지 않습니다.': '클립 순서가 올바르지 않습니다. 클립을 다시 잘라 올려 주세요.',
  'first 또는 second 만 있습니다.': '전반·후반 영상만 있습니다.',
  '모든 시각화를 프레임·에셋 Broadcast PNG로 다시 삽입하세요.': '시각화를 모두 다시 넣어 주세요 (예전 방식으로 넣은 항목이 있습니다).',
  'YOLO 모델이 로드되지 않았습니다.': '선수 인식 모델을 불러오지 못했습니다. 관리자에게 문의하세요.',
  'FPA dual 연결은 축구 수동 클립에서 지원합니다.': 'FPA 분석은 축구 수동 클립만 올릴 수 있습니다.',
  '클립결과에 연결할 영상 저장소가 설정되지 않았습니다. 합본은 그대로 다운로드할 수 있습니다.': '지금은 클립 검수·전송에 올릴 수 없습니다. 관리자에게 알려 주세요. 합본은 받을 수 있습니다.',
  '하이라이트 제작이 완료된 뒤 클립결과에 연결할 수 있습니다.': '하이라이트가 다 만들어진 뒤에 클립 검수·전송에 올릴 수 있습니다.',
  'boxes 를 읽을 수 없습니다(JSON).': '배치 정보를 읽지 못했습니다. 화면을 새로 고친 뒤 다시 저장하세요.',
  'boxes 는 객체여야 합니다.': '배치 정보를 읽지 못했습니다. 화면을 새로 고친 뒤 다시 저장하세요.',
  'token 이 없습니다.': '배경을 다시 올려 주세요.',
  'fields 는 목록이어야 합니다.': '글자 칸 정보가 올바르지 않습니다.',
  '템플릿 id 가 올바르지 않습니다.': '템플릿을 찾을 수 없습니다.',
  'spec 은 객체여야 합니다.': '템플릿 정보를 읽지 못했습니다. 다시 저장하세요.',
  // FPA
  'No saved FPA logs for this match': '이 경기에 저장된 FPA 기록이 없습니다. Live Logger 에서 먼저 저장하세요.',
  '획득(qq)은 single 모드 전용입니다. dual에서는 before/after 위치변화로 채점됩니다.': '획득(qq)은 Single 기록에서만 씁니다. Dual 기록은 Before/After 위치 변화로 자동 채점됩니다.',
  'No logs to process': '처리할 기록이 없습니다.',
  'Unknown FPA operation': '지원하지 않는 작업입니다.',
  'FPA request exceeds 16MB': '한 번에 보낼 수 있는 양(16MB)을 넘었습니다.',
  'side 는 home 또는 away 여야 합니다.': 'HOME·AWAY 중 하나를 고르세요.',
  '이 매치에 연결된 FinePlay 잡이 없습니다.': '이 경기에 연결된 FinePlay 신청이 없습니다.',
  'FPA rows 배열이 필요합니다. 한 번에 최대 10,000행을 열 수 있습니다.': '기록이 비어 있습니다. 한 번에 10,000줄까지 열 수 있습니다.',
  'rows와 logs의 수가 일치해야 합니다.': '기록 줄 수가 맞지 않습니다. 파일을 다시 불러오세요.',
  'Dual 좌표 형식을 확인하세요.': 'Dual 좌표를 확인하세요.',
  // FCM
  'At least one stat must be selected': '스탯을 1개 이상 고르세요.',
  'You can submit at most 5 stats': '스탯은 5개까지 고를 수 있습니다.',
  'team_side must be HOME or AWAY': 'HOME·AWAY 중 하나를 고르세요.',
  'FCM submission not found': '저장된 제출이 없습니다.',
  'FCM submissions are available for archived matches only': '카드는 보관된(끝난) 경기에서만 만들 수 있습니다.',
  'Competition class is required': '대회 클래스를 고르세요.',
  'Competition class does not exist': '없는 대회 클래스입니다.',
  'Template regex is required': '호출 Regex를 입력하세요.',
  'Template name is required': '템플릿 이름을 입력하세요.',
  'Template image must be PNG or JPG': 'PNG·JPG 이미지만 올릴 수 있습니다.',
  'Uploaded file is not a valid image': '이미지를 읽을 수 없습니다.',
  'Template not found': '템플릿을 찾을 수 없습니다.',
  'Template image not found': '템플릿을 찾을 수 없습니다.',
};

const LIVE_ACTION: Record<string, string> = {
  Archive: '보관을', Delete: '삭제를', 'Event reset': '기록 초기화를', 'Possession reset': '점유 초기화를',
};
const OVERLAY_FIELD: Record<string, string> = {
  first_half_video_start_sec: '전반 시작', first_half_video_end_sec: '전반 종료',
  second_half_video_start_sec: '후반 시작', second_half_video_end_sec: '후반 종료',
  source_duration_seconds: '영상 길이',
};
const TEMPLATE_KEY: Record<string, string> = {
  start_bg: '시작 카드 배경', section_bg: '구간 카드 배경', start: '시작 카드', board: '점수판',
  first_half: '전반전 효과', second_half: '후반전 효과', outro: '마무리 영상',
};
const SIDE_KO: Record<string, string> = { home: 'HOME', away: 'AWAY' };
const name = (table: Record<string, string>, key: string) => table[key] || key;

/** 세 번째 값 true = 일반 실패 문장(화면별 안내가 있으면 그쪽이 이긴다 — jobErrorMessage). */
type Rule = [RegExp, (m: RegExpMatchArray) => string, boolean?];
/** 변수가 들어가는 서버 문장. 위에서부터 처음 맞는 규칙을 쓴다. */
const PATTERNS: Rule[] = [
  [/^(Archive|Delete|Event reset|Possession reset) blocked while match clock is running\./,
    (m) => `경기 시계가 돌고 있어 ${LIVE_ACTION[m[1]]} 바로 할 수 없습니다. 한 번 더 확인하면 진행합니다.`],
  [/^Competition class is used by (\d+) match\(es\)$/, (m) => `이 대회에 경기 ${m[1]}개가 있어 지울 수 없습니다. 경기를 먼저 옮기거나 지우세요.`],
  [/^\w+ match name must include 'HOME vs AWAY'$/, () => "경기 이름에 'HOME vs AWAY' 를 넣어 주세요."],
  [/^Invalid log_data_json:/, () => '로그 파일을 읽지 못했습니다. JSON 로그 파일을 다시 고르세요.'],
  [/^Invalid regex:/, () => '호출 Regex가 올바르지 않습니다.'],
  // "합치기 실패: 메모리가 부족해..." 처럼 접두어가 붙은 OOM 은 일반 합치기 실패보다 먼저 본다.
  [/^합치기 실패: 메모리가 부족해 인코딩이 중단됐습니다/, () => '서버가 바빠 합치기가 멈췄습니다. 클립 수를 줄이거나 잠시 뒤 다시 요청해 주세요.'],
  [/^합치기 실패:/, () => '영상을 합치지 못했습니다. 다시 시도하세요.', true],
  [/^콜백 전송 실패:/, () => 'FinePlay 로 보내지 못했습니다. 다시 보내 주세요.', true],
  [/^일부 전송 실패 — (.*)$/s, (m) => partialSend(m[1])],
  [/^seq \d+ 액션이 없습니다\.$/, () => '고른 장면이 없습니다. 새로 고쳐 주세요.'],
  [/^렌더\/업로드 실패:/, () => '클립을 만들지 못했습니다. 다시 생성하세요.', true],
  [/^FinePlay claim 실패:/, () => '신청을 가져오지 못했습니다. 다른 담당자가 작업 중인지 확인하세요.'],
  [/^claim 이 거부됐습니다 \(HTTP \d+\)/, () => '다른 담당자가 이 신청을 작업 중입니다. 잠시 후 다시 시도하세요.'],
  [/^새 매니페스트를 읽을 수 없습니다/, () => '신청 영상 정보를 새로 받지 못했습니다.'],
  [/^태깅이 가리키는 원본이 새 매니페스트에 없습니다: (.*?)\. 그대로 바꾸면 렌더가 실패합니다\.$/s,
    (m) => `태그를 단 영상이 새 신청 영상 목록에 없습니다: ${m[1]}. 그대로 바꾸면 클립을 만들 수 없습니다.`],
  [/^멀티파트 시작 실패/, () => '영상 업로드를 시작하지 못했습니다.'],
  [/^멀티파트 완료 실패/, () => '업로드를 마치지 못했습니다.'],
  [/^멀티파트 중단 실패/, () => '업로드를 취소하지 못했습니다.'],
  [/^S3 삭제 실패/, () => '원본을 지우지 못했습니다. 잠시 후 다시 시도하세요.'],
  [/^FinePlay 작업 조회 실패/, () => 'FinePlay 신청 목록을 불러오지 못했습니다. 잠시 후 다시 시도하세요.'],
  [/^(\w+) 값은 0 이상이어야 합니다\.$/, (m) => `${name(OVERLAY_FIELD, m[1])} 시간은 0 이상이어야 합니다.`],
  [/^(\w+) 값은 영상 길이 안에 있어야 합니다\.$/, (m) => `${name(OVERLAY_FIELD, m[1])} 시간은 영상 길이 안이어야 합니다.`],
  [/^(\w+) 값을 확인하세요\.$/, (m) => `${name(OVERLAY_FIELD, m[1])} 시간을 확인하세요.`],
  [/^렌더 저장소 URL을 만들 수 없습니다/, () => '영상을 만들 준비를 하지 못했습니다. 잠시 후 다시 시도하세요.'],
  [/^(\w+) 가 너무 큽니다\(20MB 제한\)\.$/, (m) => `${name(TEMPLATE_KEY, m[1])} 파일이 너무 큽니다(20MB).`],
  [/^(\w+) 를 그림으로 읽을 수 없습니다\.$/, (m) => `${name(TEMPLATE_KEY, m[1])} 파일을 그림으로 읽을 수 없습니다.`],
  [/^(\w+) 가 100MB 를 넘습니다\.$/, (m) => `${name(TEMPLATE_KEY, m[1])} 파일이 너무 큽니다(100MB).`],
  [/^(\w+) 그림을 읽을 수 없습니다\.$/, (m) => `${name(TEMPLATE_KEY, m[1])} 그림을 읽을 수 없습니다.`],
  [/^(\w+) 는 영상\(mp4\)이나 그림\(png\/jpg\) 파일이어야 합니다\.$/, (m) => `${name(TEMPLATE_KEY, m[1])}: MP4 영상이나 PNG/JPG 그림만 됩니다.`],
  [/^(\w+) 배경을 굽지 못했습니다/, (m) => `${name(TEMPLATE_KEY, m[1])} 배경을 만들지 못했습니다.`],
  [/^배경을 굽지 못했습니다/, () => '배경을 만들지 못했습니다.'],
  [/^(\w+)\.fields 는 목록이어야 합니다\.$/, () => '글자 칸 정보가 올바르지 않습니다.'],
  [/^spec 을 읽을 수 없습니다\(JSON\)/, () => '템플릿 정보를 읽지 못했습니다. 다시 저장하세요.'],
  [/^생성 가능한 카드가 없습니다\.(.*)$/s, (m) => noCards(m[1])],
  [/^Data 시트에 필요한 컬럼이 없습니다: (.*)$/, (m) => `엑셀에 필요한 열이 없습니다(${m[1]}). FPA에서 내려받은 원본 파일인지 확인하세요.`],
  [/^알 수 없는 액션 코드: '(.*)'$/, (m) => `알 수 없는 액션 코드가 있습니다: ${m[1]}`],
];

/** "home: sent, away: failed: ..." → "일부 전송 실패 — AWAY 전송 실패. 다시 보내 주세요. (HOME 은 전송 완료)" */
function partialSend(statuses: string): string {
  const parts = [...statuses.matchAll(/(home|away): (.*?)(?=, (?:home|away): |$)/gs)].map((m) => ({ side: m[1], state: m[2] }));
  if (!parts.length) return '일부 팀에 보내지 못했습니다. 다시 보내 주세요.';
  const failed = parts.filter((p) => p.state.startsWith('failed'));
  const sent = parts.filter((p) => p.state === 'sent');
  const failedText = failed.map((p) => `${SIDE_KO[p.side]} 전송 실패`).join(' · ') || '일부 전송 실패';
  const sentText = sent.length ? ` (${sent.map((p) => SIDE_KO[p.side]).join('·')} 은 전송 완료)` : '';
  return `일부 전송 실패 — ${failedText}. 다시 보내 주세요.${sentText}`;
}

/** FCM 카드 생성 409: 팀별 실패 사유 중 배경 템플릿 없음만 짚어 준다. */
function noCards(rest: string): string {
  const teams = [...rest.matchAll(/([^/:]+?):\s*[^/]*배경 템플릿 없음/g)].map((m) => m[1].trim()).filter(Boolean);
  if (teams.length) return `카드를 만들지 못했습니다. ${[...new Set(teams)].join(', ')}: 배경 템플릿이 없습니다. 템플릿 화면에서 등록하세요.`;
  return '만들 수 있는 카드가 없습니다. 팀 기록을 먼저 저장하세요.';
}

/** 표에서 찾은 한국어. 없으면 null. overrides 는 화면별로 더 알맞은 문장을 쓸 때. */
export function translateDetail(detail: string, overrides?: Record<string, string>, skipGeneric = false): string | null {
  const text = detail.trim();
  if (!text) return null;
  if (overrides && text in overrides) return overrides[text];
  if (text in EXACT) return EXACT[text];
  for (const [pattern, render, generic] of PATTERNS) {
    const match = text.match(pattern);
    if (match) return generic && skipGeneric ? null : render(match);
  }
  return null;
}

/**
 * 관리자·개발 화면 — 개발 용어 허용(11-04 승준). 여기서는 변환표·화면 문장을 쓰지 않고
 * 서버 문장을 그대로(JSON 껍데기만 벗겨) 보여 준다. 원문 전체는 여전히 자세히로 남는다.
 */
export const ADMIN_SURFACES = [
  '/admin/media', '/admin/system', '/admin/fpa/reports', '/admin/data-hub', '/fpa-cv',
  '/admin/fpa/tracking', '/admin/futsal/fpa/tracking',
  '/admin/highlight/upload', '/admin/highlight/my', '/admin/highlight/process', '/admin/highlight/completed',
];
export function isAdminSurface(pathname?: string): boolean {
  const path = pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '');
  return ADMIN_SURFACES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

const HANGUL = /[가-힣]/;
const HTML_BODY = /^\s*<(!doctype|html|head|body)\b/i;
const STACK = /Traceback \(most recent call last\)|^\s+at \S+ \(|File "[^"]+", line \d+/m;
/** 대문자_대문자 꼴의 환경 변수 이름(HIGHLIGHT_S3_BUCKET, FINEPLAY_API_TOKEN 등). */
const ENV_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/;

type Parsed = { detail?: string; detailValue?: unknown; code?: string; json: boolean };

/** 응답 본문에서 detail·code 를 꺼낸다. JSON 이 아니면 json=false. */
export function parseErrorBody(text: string): Parsed {
  const body = (text || '').trim();
  if (!body || !/^[{[]/.test(body)) return { json: false };
  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== 'object') return { json: true };
    const top = data as any;
    const value = Array.isArray(data) ? data : top.detail ?? top.message ?? top.error;
    const nested = value && typeof value === 'object' && !Array.isArray(value) ? value as any : null;
    const codeValue = nested?.code ?? nested?.reason ?? (Array.isArray(data) ? undefined
      : top.code ?? top.error_code ?? (typeof top.error === 'string' && top.detail !== undefined ? top.error : undefined));
    let detail: string | undefined;
    if (typeof value === 'string') detail = value;
    else if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as any).message === 'string') detail = (value as any).message;
    else if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as any).detail === 'string') detail = (value as any).detail;
    else if (value !== undefined) detail = JSON.stringify(value);
    return { detail, detailValue: value, code: codeValue == null ? undefined : String(codeValue), json: true };
  } catch {
    return { json: false };
  }
}

function genericForStatus(status: number): string {
  if (status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
  if (status === 403) return '이 작업을 할 권한이 없습니다.';
  if (status === 404) return '찾을 수 없습니다. 목록을 새로 고쳐 주세요.';
  if (status === 408 || status === 504) return '응답이 늦어 멈췄습니다. 잠시 후 다시 시도해 주세요.';
  if (status === 413) return '파일이 너무 큽니다.';
  if (status === 429) return '요청이 많아 잠시 막혔습니다. 잠시 후 다시 시도해 주세요.';
  if (status === 502 || status === 503) return '서버가 응답하지 않습니다. 잠시 후 다시 시도해 주세요.';
  if (status >= 500) return '서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  return `요청을 처리하지 못했습니다. (코드 ${status})`;
}

const SERVER_SETUP = '서버 설정 문제로 처리하지 못했습니다. 관리자에게 알려 주세요.';

export type ReasonResult = { reason: string; fromServer: boolean };

/**
 * HTTP 상태·본문 → 화면 문장.
 * fromServer=true 는 서버가 사유를 말해 준 경우(번역됐거나 서버 문장 그대로),
 * false 는 상태 코드만 보고 만든 일반 문장이다(화면별 fallback 을 쓰는 편이 낫다).
 */
export function reasonFromBody(status: number, text: string, overrides?: Record<string, string>): ReasonResult {
  const parsed = parseErrorBody(text);
  const body = (text || '').trim();
  if (Array.isArray(parsed.detailValue)) {
    // FastAPI 검증 오류(422): [{loc, msg, type}] — 칸 이름은 자세히에 남는다.
    return { reason: '입력값이 올바르지 않습니다. 내용을 확인해 주세요.', fromServer: true };
  }
  const detail = parsed.json ? parsed.detail : body;
  if (detail) {
    const translated = translateDetail(detail, overrides);
    if (translated) return { reason: translated, fromServer: true };
    if (HTML_BODY.test(detail)) return { reason: status >= 502 && status <= 504 ? genericForStatus(status) : SERVER_SETUP, fromServer: false };
    if (status >= 500) {
      if (STACK.test(detail) || ENV_NAME.test(detail)) return { reason: SERVER_SETUP, fromServer: false };
      // 5xx 라도 서버가 한국어 문장으로 사유를 줬으면 그대로 보여 준다(짧은 한 줄만).
      if (HANGUL.test(detail) && detail.length <= 200 && !detail.includes('\n')) return { reason: detail, fromServer: true };
      return { reason: genericForStatus(status), fromServer: false };
    }
    if (STACK.test(detail)) return { reason: genericForStatus(status), fromServer: false };
    if (!parsed.json && !HANGUL.test(detail) && detail.length > 160) return { reason: genericForStatus(status), fromServer: false };
    return { reason: detail, fromServer: true };
  }
  return { reason: genericForStatus(status), fromServer: false };
}

/** 응답 오류. message 는 화면용 한국어, status·detail·raw 는 분기·자세히용 원문. */
export class FpcError extends Error {
  status?: number;
  detail?: string;
  code?: string;
  raw: string;
  url?: string;
  fromServer: boolean;
  /** 화면이 준 문장(fallback·fixed·action)으로 message 를 만들었는지. */
  screenMessage: boolean;
  context?: ErrorInfo['context'];
  constructor(info: ErrorInfo & { fromServer?: boolean; screenMessage?: boolean }) {
    super(info.message);
    this.name = 'FpcError';
    this.status = info.status;
    this.detail = info.detail;
    this.code = info.code;
    this.raw = info.raw ?? '';
    this.url = info.url;
    this.context = info.context;
    this.fromServer = !!info.fromServer;
    this.screenMessage = !!info.screenMessage;
    rememberErrorInfo(this.info());
  }
  info(): ErrorInfo {
    return { message: this.message, status: this.status, detail: this.detail, code: this.code, raw: this.raw, url: this.url, context: this.context };
  }
}

export type ErrorOptions = {
  /** 서버 사유가 없을 때(본문 없음·5xx 일반) 쓸 화면 문장. */
  fallback?: string;
  /** 서버 사유가 있어도 이 문장만 보여 준다(원문은 자세히). */
  fixed?: string;
  /** "{action} — {서버 사유}" 로 앞에 붙인다. 서버 사유가 없으면 fallback(없으면 action). */
  action?: string;
  overrides?: Record<string, string>;
  url?: string;
  context?: ErrorInfo['context'];
};

/** HTTP 상태와 본문 문자열로 FpcError 를 만든다. */
export function errorFromBody(status: number, text: string, options: ErrorOptions = {}): FpcError {
  const parsed = parseErrorBody(text);
  if (isAdminSurface()) {
    const serverText = (parsed.json ? parsed.detail ?? '' : '') || (parsed.json ? '' : (text || '').trim()) || (parsed.json ? (text || '').trim() : '');
    const message = serverText || options.fallback || `Request failed (${status})`;
    return new FpcError({ message, status, detail: parsed.json ? parsed.detail : undefined, code: parsed.code, raw: text, url: options.url, context: options.context, fromServer: !!serverText, screenMessage: !serverText && !!options.fallback });
  }
  const { reason, fromServer } = reasonFromBody(status, text, options.overrides);
  let message: string;
  if (options.fixed) message = options.fixed;
  else if (fromServer) message = options.action ? `${options.action} — ${reason}` : reason;
  else message = options.fallback || (options.action ? `${options.action}. ${reason}` : reason);
  const detail = parsed.json ? parsed.detail : undefined;
  const screenMessage = !!(options.fixed || options.action || (!fromServer && options.fallback));
  return new FpcError({ message, status, detail, code: parsed.code, raw: text, url: options.url, context: options.context, fromServer, screenMessage });
}

function responsePath(response: Response): string | undefined {
  try {
    if (!response.url) return undefined;
    const url = new URL(response.url);
    return url.pathname + url.search;
  } catch {
    return response.url || undefined;
  }
}

/** fetch 응답(ok 아님)의 본문을 읽어 FpcError 로. fallback 만 줄 때는 문자열을 넘겨도 된다. */
export async function errorFromResponse(response: Response, options: ErrorOptions | string = {}): Promise<FpcError> {
  const opts = typeof options === 'string' ? { fallback: options } : options;
  let text = '';
  try { text = await response.text(); } catch { /* 본문을 못 읽어도 상태로 안내한다. */ }
  return errorFromBody(response.status, text, { ...opts, url: opts.url ?? responsePath(response) });
}

/** 응답(ok 아님) → 화면 문자열. 원문은 자세히에서 찾을 수 있게 기억해 둔다. */
export async function responseMessage(response: Response, options: ErrorOptions | string = {}): Promise<string> {
  return (await errorFromResponse(response, options)).message;
}

const NETWORK = /^(Failed to fetch|NetworkError when attempting to fetch resource\.?|Load failed|Network request failed)$/i;

/**
 * catch 한 값 → 화면 문자열. FpcError 는 이미 한국어. 그 밖의 예외는
 * 네트워크·시간 초과·JSON 껍데기만 다듬고, 원문은 자세히에 남긴다.
 * fixed 를 주면 그 문장만 보여 준다(원문은 자세히).
 */
export function errorMessage(error: unknown, fallback: string, options: { fixed?: boolean; action?: string; context?: ErrorInfo['context'] } = {}): string {
  if (isAdminSurface()) {
    // 관리자 화면: 예전처럼 예외 문장 그대로(JSON 껍데기만 벗김). 원문은 자세히.
    if (error instanceof FpcError) {
      if (options.context) rememberErrorInfo({ ...error.info(), context: { ...error.context, ...options.context } });
      return error.message;
    }
    const raw = isErrorLike(error) ? String((error as Error).message ?? '') : error == null ? '' : String(error);
    const parsed = /^\s*[{[]/.test(raw) ? parseErrorBody(raw) : { json: false } as Parsed;
    const message = (parsed.json && parsed.detail) || raw || fallback;
    if (raw && raw !== message) rememberErrorInfo({ message, raw, context: options.context });
    return message;
  }
  if (error instanceof FpcError) {
    // 서버가 사유를 말해 줬으면 그 문장(번역), 상태 코드만 있으면 화면별 fallback 이 더 낫다.
    let message = error.message;
    if (options.fixed) message = fallback;
    else if (!error.fromServer && !error.screenMessage && fallback) message = fallback;
    else if (options.action && error.fromServer) message = `${options.action} — ${error.message}`;
    if (message !== error.message || options.context) rememberErrorInfo({ ...error.info(), message, context: { ...error.context, ...options.context } });
    return message;
  }
  const like = isErrorLike(error);
  const raw = like ? String((error as Error).message ?? '') : error == null ? '' : String(error);
  const name = like ? String((error as Error).name || '') : '';
  let message: string;
  if (name === 'AbortError' || /aborted|timeout/i.test(raw) && !HANGUL.test(raw)) message = '응답이 늦어 멈췄습니다. 다시 시도해 주세요.';
  else if (NETWORK.test(raw.trim())) message = '서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.';
  else if (/^\s*[{[]/.test(raw)) {
    const parsed = parseErrorBody(raw);
    message = (parsed.detail && translateDetail(parsed.detail)) || parsed.detail || fallback;
  } else if (raw && HANGUL.test(raw)) message = translateDetail(raw) || raw;
  else message = (raw && translateDetail(raw)) || fallback;
  if (options.fixed) message = fallback;
  else if (options.action && message !== fallback) message = `${options.action} — ${message}`;
  if (raw && raw !== message) rememberErrorInfo({ message, raw: name && name !== 'Error' ? `${name}: ${raw}` : raw, context: options.context });
  return message;
}

function isErrorLike(error: unknown): boolean {
  return error instanceof Error || (!!error && typeof error === 'object' && typeof (error as Error).message === 'string');
}

/** 오류 문구로 분기할 때 쓰는 서버 원문(detail). 번역된 message 로 분기하지 않는다. */
export function errorDetail(error: unknown): string {
  if (error instanceof FpcError) return error.detail ?? (error.raw || error.message);
  return isErrorLike(error) ? String((error as Error).message) : String(error ?? '');
}

export function errorStatus(error: unknown): number | undefined {
  return error instanceof FpcError ? error.status : undefined;
}

/** 화면 문자열(message) → 자세히 정보. 문자열 state 만 들고 있는 화면이 원문을 잃지 않게 한다. */
const REMEMBERED = new Map<string, ErrorInfo>();
const LIMIT = 80;
export function rememberErrorInfo(info: ErrorInfo): void {
  if (!info.message) return;
  REMEMBERED.delete(info.message);
  REMEMBERED.set(info.message, info);
  while (REMEMBERED.size > LIMIT) REMEMBERED.delete(REMEMBERED.keys().next().value as string);
}
export function lookupErrorInfo(message: string | null | undefined): ErrorInfo | undefined {
  if (!message) return undefined;
  const direct = REMEMBERED.get(message);
  if (direct) return direct;
  // 화면이 "실패: " 같은 머리말이나 " · 다시 시도" 같은 꼬리를 붙였으면 경계를 확인하고 찾는다.
  for (const [key, info] of [...REMEMBERED].reverse()) {
    if (key.length < 8 || message.length <= key.length) continue;
    if (message.endsWith(key) && /[\s:：—·(]$/.test(message.slice(0, -key.length))) return info;
    if (message.startsWith(key) && /^[\s—·(]/.test(message.slice(key.length))) return info;
  }
  return undefined;
}

/** 원문(예: job.error_message)을 화면 문장과 묶어 기억하고 화면 문장을 돌려준다. */
export function foldRaw(message: string, raw: string | null | undefined, context?: ErrorInfo['context']): string {
  if (raw && raw !== message) rememberErrorInfo({ message, raw, context });
  return message;
}

/** 서버가 남긴 작업 오류 문자열(job.error_message 등) → 화면 문장. 표에 있으면 번역, 없으면 fallback. */
export function jobErrorMessage(raw: string | null | undefined, fallback: string, context?: ErrorInfo['context']): string {
  const text = String(raw || '').trim();
  if (isAdminSurface()) return foldRaw(text || fallback, text, context);
  // 화면이 준 안내(fallback)가 일반 실패 문장("합치기 실패: …" 등)보다 낫다 — 구체적인 사유만 번역.
  const translated = text ? translateDetail(text, undefined, true) : null;
  return foldRaw(translated || fallback, text, context);
}

/** 자세히 칸 본문 — 상태 코드·사유·코드·주소·ID·원문을 복사하기 좋게 줄로 모은다. */
export function formatErrorInfo(info: ErrorInfo): string {
  const lines: string[] = [];
  if (info.status != null) lines.push(`상태 코드: ${info.status}`);
  if (info.code) lines.push(`오류 코드: ${info.code}`);
  if (info.detail && info.detail !== info.message) lines.push(`서버 사유: ${info.detail}`);
  if (info.url) lines.push(`요청: ${info.url}`);
  for (const [key, value] of Object.entries(info.context || {})) if (value != null && value !== '') lines.push(`${key}: ${value}`);
  const raw = (info.raw || '').trim();
  if (raw && raw !== info.detail) {
    let pretty = raw;
    try { if (/^[{[]/.test(raw)) pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* 그대로 */ }
    lines.push(`원문:\n${pretty.length > 4000 ? `${pretty.slice(0, 4000)}…` : pretty}`);
  }
  return lines.join('\n');
}

export function hasErrorDetails(info: ErrorInfo | undefined): boolean {
  return !!info && !!formatErrorInfo(info);
}

/** window.confirm/alert 에는 원문을 넣지 않는다 — 콘솔에 남긴다. */
export function warnRaw(label: string, info: Partial<ErrorInfo> | FpcError): void {
  const data = info instanceof FpcError ? info.info() : info;
  try { console.warn(`[FPC] ${label}`, data); } catch { /* 콘솔 없음 */ }
}
