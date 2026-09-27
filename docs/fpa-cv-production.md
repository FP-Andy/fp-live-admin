# FPC FPA GPU 운영

Futsal → FPA → 영상 분석(`/admin/futsal/fpa/tracking`)에서 새 영상을 등록한다. 특정 경기의 결과나 초기 명단은 포함하지 않는다. 다음 실제 사용자 테스트는 경남–대구 경기다.

## 이번 배포 구조

- FPC 로그인으로 업로드·분석·결과·검수 접근을 확인한다. 운영자는 자신이 만든 분석을, 관리자는 전체 분석을 볼 수 있다.
- FPC API가 영상 스트림을 사설 GPU 서비스로 전달한다. 앱 서버 디스크에 대용량 영상을 중복 저장하지 않는다. 업로드 최대 20GB, FPA 추적 작업은 한 번에 한 경기다.
- 별도 `app-fpa-worker` 컨테이너가 기존 CUDA/PyTorch 기반에서 Ultralytics 8.4.14와 YOLO26s를 사용한다. 기존 하이라이트 컨테이너는 변경하지 않는다. 물리 GPU는 공유하므로 동시 하이라이트 부하가 있으면 처리 시간이 달라진다.
- 모델 SHA-256: `646f8bc3fe0a656803d95c294f7852321748cb29d13466a1af8862e2db384a1b`. ByteTrack, 1280 입력, confidence 0.1, 초당 15샘플, 코트·색상·초기 13명 설정을 유지한다.
- 영상·추적 결과·초기 장면은 GPU 서버 `/opt/fpa-cv/runtime`의 영속 EBS 디스크에 저장한다. 컨테이너 재생성/인스턴스 정지 이후에도 남는다. **S3 이관은 이번 배포에 포함하지 않았다.** 인스턴스 종료/볼륨 삭제에 대한 별도 백업이 필요하다.
- 검수는 FPC PostgreSQL `fpa_cv_resources`에 버전과 함께 저장한다. 다른 창의 변경을 덮어쓰지 않으며 실패한 전송은 브라우저 초안에 남는다. N차 검수는 기존 검출을 재사용하고 YOLO를 재실행하지 않는다.
- 분석을 삭제하면 휴지통으로 이동한다. 중지가 끝난 후 영구 삭제를 확인하면 결과와 서버 검수를 삭제한다. 다른 분석이 참조하는 원본은 유지한다. 마지막 분석을 지우면 원본과 관련 초기 장면도 제거한다. 다운로드한 백업은 삭제하지 않는다.

## 환경 및 배포

앱 `.env`: `FPA_CV_WORKER_URL`, `FPA_CV_WORKER_TOKEN`. 토큰은 최소 32자이며 브라우저에 전달하지 않는다.

`FPA_CV_ALLOWED_ORIGINS`는 외부 화면의 정확한 Origin 목록이다(Compose 기본값 `https://console.fineludens.kr`). CloudFront가 Host를 EC2 원본 주소로 바꾸므로 이 설정이 필요하다. 임의의 전달 헤더나 와일드카드는 신뢰하지 않는다. 영상 전송 전 작은 `/api/tracking/uploads/check` 요청으로 인증·Origin·GPU 연결을 먼저 확인한다.

GPU Compose: `infra/fpa-worker/docker-compose.yml`. `FPA_CV_PRIVATE_IP`, `FPA_CV_RUNTIME_DIR`, `FPA_CV_TOKEN_FILE`을 지정한다. 기본 CUDA 베이스는 해당 서버에 설치된 `highlight-worker-highlight-worker` 이미지다. 다른 서버에서는 `FPA_CV_BASE_IMAGE`에 검증된 CUDA/PyTorch 이미지를 지정하고 관련 CV 의존성을 검증해야 한다.

GPU 4333 포트는 앱 보안 그룹에서만 접근하도록 제한하며 모든 요청에 서비스 인증이 필요하다. 외부 브라우저는 GPU 주소에 직접 연결하지 않는다. GPU가 꺼져 있으면 새 분석 버튼은 비활성화된다. FPC System에서 기존 GPU를 시작한 뒤 화면의 연결 상태를 확인한다. 실행 중 GPU를 중지하면 해당 분석은 재시작 후 재시도해야 한다.

일반 FPC 배포는 기존 `Deploy Production` GitHub Actions로 수행한다. GPU 코드를 변경했다면 별도로 해당 서버의 FPA Compose를 재빌드한다. 모델·원본·토큰은 Git에 넣지 않는다.

## 검증 및 다음 범위

프로덕션 웹 빌드, FPA 작업 API/이벤트/선수 연결/히트맵 회귀 검사, GPU 서비스 인증, 영구 삭제 공유 원본 보호, 대기열 삭제 보호, 서버 검수 권한·버전 충돌·오프라인 복원 검사. GPU에서는 사용자 영상 대신 검은 이미지 한 장으로 실제 CUDA 추론과 모델 해시를 확인했다.

실제 경기 전체 분석의 시간·정확도는 사용자 경남–대구 테스트 이후 측정한다. 교체 입력/시간별 출전 명단, S3 백업·이관, 다중 GPU 및 38경기 일괄 처리, GPU 유휴 자동 종료는 후속 범위다. 현재 히트맵의 교체 미반영 표시는 유지한다.
