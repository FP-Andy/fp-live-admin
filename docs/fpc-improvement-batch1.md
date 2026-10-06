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
- 리포트 저장은 편집 버전별 단일 쓰기로 순서를 보장한다. 이전 저장 응답으로 최신 입력을 저장 완료 처리하지 않는다. 입력 시 사용자별 탭 복구 자료를 남기고, 내부 링크 이동은 저장 확인 후 진행한다. 브라우저 뒤로/앞으로 이동에는 화면 수명과 독립된 쓰기와 탭 복구 자료를 사용한다. 새로고침·창 닫기에는 미저장 안내를 제공한다. IDB 실패 시 화면·복구 JSON을 유지하고 저장 재시도를 제공한다.
- 리포트 전체 원본이 IDB에 저장된 뒤에는 변경한 필드만 임시 보관한다. 코멘트 입력마다 불변 좌표·FPA 데이터를 직렬화하지 않는다. 새 작업의 최초 저장 전에는 전체 임시 사본이 필요하며 저장 공간 부족 시 명시적으로 경고한다. 임시 자료는 같은 탭의 새로고침 복구용이며 브라우저 종료 후 영구 백업이 아니다. 기존 IDB 리포트의 계정별 이관(W03)은 별도다.
- 교체 재계산의 동일 선수 구간 수정은 이름·등번호·코멘트 등 작성 필드를 유지한다. 같은 교체 슬롯이라도 입장 트랙이 바뀌면 문구를 승계하지 않는다. 마지막 교체를 삭제하는 경우도 갱신 전 사본을 저장하고, 사본 저장을 기다리는 중의 입력까지 다시 반영한 뒤 적용한다. 저장 실패 시 적용하지 않는다. 변경·제외 인원과 사본 위치를 안내한다.
- 리포트·스냅샷·파일 선택에 요청 세대를 부여한다. 이전 요청의 성공·실패가 새 선택의 내용·URL·알림을 바꾸지 않는다.
- 분석 완료 대화상자는 부모 화면의 실제 보이는 iframe 영역에 배치한다. 저장 오류를 대화상자 안에 표시하고 저장 중 중복 요청과 닫기를 막는다. 체크·키보드·Escape·초점 복귀·같은 요청 ID의 재시도를 유지한다.
- Next.js를 14.2.15에서 14.2.35로 고정하고 lockfile을 함께 갱신했다. [2025-12-11 공식 수정 안내](https://nextjs.org/blog/security-update-2025-12-11)의 14.x App Router 수정판이며 npm registry에서 같은 14.2 계열의 최종 공개 패치임을 확인했다. 이 항목은 해당 수정 권고의 적용이며 모든 의존성 취약점이나 지원 수명 검토를 완료했다는 뜻은 아니다.

## 독립 백업 도구

`scripts/deploy_snapshot.py`는 HEAD 원본, index patch, 실제 작업 파일·미추적 파일 내용, 모드·심볼릭 링크·체크섬을 보관한다. 새 임시 checkout의 실제 복원이 성공하고 검사 중 원본이 바뀌지 않았을 때만 `VERIFIED`를 남긴다. 원본 checkout을 변경하거나 정리하지 않는다.

```sh
python3 scripts/deploy_snapshot.py snapshot /path/to/checkout /separate/backup/location --target-ref TARGET_COMMIT
python3 scripts/deploy_snapshot.py restore /separate/backup/location /empty/restore/location
```

백업은 원본 checkout 밖에 생성한다. 복원 경로는 비어 있어야 한다. ignored runtime·DB·객체 스토리지는 별도 백업 대상이다. 운영 배포 workflow 연결은 사용자의 지시로 보류했다. `.github/workflows/deploy-production.yml`은 변경하지 않았다.

## 검증과 한계

서로 다른 Python 프로세스에서 실행한다. API 테스트는 임시 SQLite와 실제 앱 route·인증·CORS를 사용하고 startup worker를 시작하지 않는다. 테스트 중 모든 소켓 연결을 차단한다.

```sh
python scripts/test_deploy_snapshot.py -v
python apps/api/tests/test_auth.py -v
python apps/api/tests/test_match_write_access.py -v
python apps/api/tests/test_manual_clip_results.py -v
node scripts/test-manual-draft.cjs
node scripts/test-report-recovery.cjs
node scripts/test-futsal-match-report.cjs
node scripts/test-futsal-team-report.cjs
node scripts/test-futsal-report-stories.cjs
node scripts/test-futsal-substitution-report.mjs
node apps/web/node_modules/typescript/bin/tsc --noEmit --incremental false -p apps/web/tsconfig.json
npm run build --prefix apps/web
```

브라우저 검사는 별도 localhost Next 인스턴스와 합성 MP4가 필요하다. API는 테스트 응답으로 대체하며 외부 요청은 차단한다.

```sh
# localhost:4354의 개발본이 실행 중일 때
node scripts/test-fpc-save-recovery-ui.cjs
node scripts/test-report-recovery-ui.cjs
node scripts/test-completion-dialog-ui.cjs
CLIP_QA_ORIGIN=http://127.0.0.1:4354 node scripts/test-manual-clip-results-ui.cjs
```

`FFMPEG`, `CHROME_PATH`, `FPC_QA_ORIGIN`, `FPC_QA_OUTPUT`을 지정할 수 있다. MP4 클립 기능 검사에는 PATH의 ffmpeg/ffprobe가 필요하다. `.github/workflows/regression-checks.yml`은 GitHub-hosted PR 검사만 추가하며 운영 workflow를 실행하지 않는다. 새 GitHub workflow 자체의 원격 실행 결과는 아직 없다.

확인 결과: Python 33개(복원 7, 인증 7, 실제 쓰기 route 8, 개별 클립 11), 브라우저 실패/복구 시나리오 7개, 기존 두 기능의 브라우저 검사, TypeScript, production 웹 빌드 통과. 기존 CSS 정렬값과 Browserslist 자료의 빌드 경고는 남아 있다. 이전 코드에 새 쓰기 회귀 검사를 적용하면 권한·중복 복구 기대값이 실패하는 것도 대조했다.

추가 리포트 검사: 저장 순서·복구·변경 필드 보관·선수 연결·백업 중 입력·실패 시 적용 중단 7개 순수 검사, 실제 리포트 화면의 이동·앞뒤 이동·IDB 실패·JSON·새로고침·선택 경쟁·정상 선택 6개 시나리오 통과. 기존 개인/팀 리포트·문구·교체 분석 계산 검사도 통과했다. 대화상자는 실제 부모 컴포넌트와 heatmapUI를 사용하고 분석 입력·저장 API만 합성 자료로 대체해 두 해상도를 검사했다. Next.js 14.2.35에서 이 검사와 기존 하이라이트·수동 태그·클립 UI 검사를 다시 통과했고 production 웹 빌드도 성공했다. 실제 운영 경기의 분석 정확도나 DB/스토리지 통합 결과로 확대 해석하지 않는다.

운영 전 남은 사항: 녹화·업로드·합본 종료, 실제 배포본·외부 쓰기 호출자의 세션 호환, PostgreSQL 경쟁/잠금, 전용 S3/IAM과 운영 FFmpeg 버전, 운영 DB·객체·작업 파일의 복원 재료 확인. 이 변경은 새 DB 테이블/컬럼을 추가하지 않는다.
