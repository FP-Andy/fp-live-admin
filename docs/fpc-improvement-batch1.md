# FPC 첫 개선 묶음: 기록 권한과 저장 복구

기준 main: `1e64627194e056bd9209f3427323ee384ea521ca`. 운영 배포 전 변경안이다.

## 변경 동작

- 축구 운영권·시계·이벤트·마커·하이라이트·초기화는 인증된 세션을 요구한다. 기존 `user_id` 필드는 세션 본인 ID인 경우만 허용하며 인증 수단으로 사용하지 않는다. 강제 인계는 서버가 확인한 관리자 역할만 허용한다. 담당자·관리자 입력, 미배정 경기의 로그인된 담당자 입력은 유지한다.
- 축구 쓰기와 운영권 변경은 경기 행 잠금을 사용한다. 실제 PostgreSQL에서 인계와 입력의 경쟁 상황을 배포 전에 추가 검사한다.
- 하이라이트 클릭마다 요청 ID와 최초 경기 시각을 남긴다. HTTP 오류·응답 유실에는 성공을 표시하지 않고 같은 요청을 재전송한다. 동일 요청의 재전송은 기존 한 건으로 응답하고, 다른 내용·경기에 ID를 재사용하면 충돌을 반환한다. 별도 클릭은 같은 시각이어도 별도 기록이다. 기존 ID 없는 요청은 유지한다.
- 미확인 하이라이트 요청은 사용자·경기별 sessionStorage에 보관한다. 같은 탭에서 다시 열 때 복원하며, 복구 JSON을 내려받을 수 있다. 브라우저 저장도 실패하면 경고한다.
- 수동 태깅은 전체 저장·그림 제외 저장·저장 실패를 구분한다. 추가 태깅으로 경고가 사라지지 않는다. JSON은 태그, 전역·개별 패딩, 점수판·로고, 카드 내용·배치·그림, 워터마크를 보존한다. 종목·영상 이름·크기·순서가 일치해야 불러온다. 원본 영상·인트로·음악 파일과 추출 클립 자체는 포함하지 않는다.
- 수동 초안 복원 전에 자동 저장이 빈 초안을 덮어쓰지 않게 한다. 태그가 0개인 작업도 설정을 보존한다. 기존 배열 형식도 읽는다.
- 수동 태깅의 저장 실패/그림 제외 상태에는 창 닫기·새로고침 및 페이지 링크 이동 안내를 제공한다. 브라우저 뒤로/앞으로와 종목 전환 전체의 공통 보호 및 계정별 기존 초안 이관은 W03/W04 후속 범위다.
- 농구 일반 태그 X/ㅌ, 원정 2점 S/ㄴ과 축구 S/ㄴ·Q/W/E/R을 실제 키 정의로 안내한다.

## 독립 백업 도구

`scripts/deploy_snapshot.py`는 HEAD 원본, index patch, 실제 작업 파일·미추적 파일 내용, 모드·심볼릭 링크·체크섬을 보관한다. 새 임시 checkout의 실제 복원이 성공하고 검사 중 원본이 바뀌지 않았을 때만 `VERIFIED`를 남긴다. 원본 checkout을 변경하거나 정리하지 않는다.

```sh
python3 scripts/deploy_snapshot.py snapshot /path/to/checkout /separate/backup/location --target-ref TARGET_COMMIT
python3 scripts/deploy_snapshot.py restore /separate/backup/location /empty/restore/location
```

백업은 원본 checkout 밖에 생성한다. 복원 경로는 비어 있어야 한다. ignored runtime·DB·객체 스토리지는 별도 백업 대상이다. 운영 배포 workflow에 이 도구를 연결하는 변경은 아직 포함하지 않았다.

## 검증과 한계

서로 다른 Python 프로세스에서 실행한다. API 테스트는 임시 SQLite와 실제 앱 route·인증·CORS를 사용하고 startup worker를 시작하지 않는다. 테스트 중 모든 소켓 연결을 차단한다.

```sh
python scripts/test_deploy_snapshot.py -v
python apps/api/tests/test_auth.py -v
python apps/api/tests/test_match_write_access.py -v
python apps/api/tests/test_manual_clip_results.py -v
node scripts/test-manual-draft.cjs
node apps/web/node_modules/typescript/bin/tsc --noEmit --incremental false -p apps/web/tsconfig.json
npm run build --prefix apps/web
```

브라우저 검사는 별도 localhost Next 인스턴스와 합성 MP4가 필요하다. API는 테스트 응답으로 대체하며 외부 요청은 차단한다.

```sh
# localhost:4354의 개발본이 실행 중일 때
node scripts/test-fpc-save-recovery-ui.cjs
CLIP_QA_ORIGIN=http://127.0.0.1:4354 node scripts/test-manual-clip-results-ui.cjs
```

`FFMPEG`, `CHROME_PATH`, `FPC_QA_ORIGIN`, `FPC_QA_OUTPUT`을 지정할 수 있다. MP4 클립 기능 검사에는 PATH의 ffmpeg/ffprobe가 필요하다. `.github/workflows/regression-checks.yml`은 GitHub-hosted PR 검사만 추가하며 운영 workflow를 실행하지 않는다. 새 GitHub workflow 자체의 원격 실행 결과는 아직 없다.

확인 결과: Python 33개(복원 7, 인증 7, 실제 쓰기 route 8, 개별 클립 11), 브라우저 실패/복구 시나리오 7개, 기존 두 기능의 브라우저 검사, TypeScript, production 웹 빌드 통과. 기존 CSS 정렬값과 Browserslist 자료의 빌드 경고는 남아 있다. 이전 코드에 새 쓰기 회귀 검사를 적용하면 권한·중복 복구 기대값이 실패하는 것도 대조했다.

운영 전 남은 사항: 녹화·업로드·합본 종료, 실제 배포본·외부 쓰기 호출자의 세션 호환, PostgreSQL 경쟁/잠금, 전용 S3/IAM과 운영 FFmpeg 버전, 운영 DB·객체·작업 파일의 복원 재료 확인. 이 변경은 새 DB 테이블/컬럼을 추가하지 않는다.
