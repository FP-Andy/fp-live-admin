# Media Server Ops Checklist

운영 기준:

- 앱 서버 `live-admin-app`은 상시 켠다.
- 미디어 서버 `live-admin-media`는 송출이 필요할 때만 켠다.
- 수동 기록 경기(`MANUAL`)는 미디어 서버 없이 진행 가능하다.
- 스트리밍 경기(`STREAM`)는 미디어 서버가 반드시 켜져 있어야 한다.

## 미디어 서버를 꺼도 되는 경우

- 현재 라이브 송출 중인 경기가 없다.
- RTMP/SRT ingest를 기다리는 경기가 없다.
- 운영자가 `Media` 페이지에서 `Re-attach`, `Stop Stream`, `Clear HLS`, RTMP 정보 확인을 할 계획이 없다.
- 외부에서 HLS를 시청 중인 사용자가 없다.
- 오늘 남은 경기가 모두 `MANUAL` 운영이다.

## 미디어 서버를 끄기 전 체크

- `https://console.fineludens.kr/admin/dashboard` 접속 가능
- 오늘 진행 예정 경기 중 `stream_mode=STREAM`인 항목이 없는지 확인
- `https://console.fineludens.kr/admin/media`에서 실제 running stream이 없는지 확인
- 미디어 서버 고정 IP가 `3.227.35.90`으로 유지되는지 확인
- 앱 서버 `GATEWAY_API_BASE=http://172.31.95.167:8090` 설정이 유지되는지 확인

## 미디어 서버 중지 절차

1. AWS EC2 콘솔에서 `live-admin-media` 선택
2. `인스턴스 상태`
3. `인스턴스 중지`
4. 상태가 `중지됨`이 될 때까지 대기

## 미디어 서버 중지 후 정상이어야 하는 것

- `https://console.fineludens.kr/login` 접속 가능
- `https://console.fineludens.kr/admin/dashboard` 접속 가능
- 수동 경기 생성 가능
- 수동 경기의 Match Control 진입 가능
- 타이머, possession, lane, xG/xGOT 입력 가능
- match export 기능 사용 가능

## 미디어 서버 중지 후 비정상이어도 괜찮은 것

- `Media` 페이지의 gateway 상태 조회 실패
- 스트림 시작/중지/재연결 실패
- RTMP attach 정보 조회 실패
- HLS 재생 실패

## 미디어 서버를 반드시 켜야 하는 경우

- 새 스트리밍 경기 생성 직전
- OBS/외부 중계사 송출을 받을 예정일 때
- RTMP 정보를 운영자가 전달해야 할 때
- HLS 확인이 필요할 때
- `Media` 페이지 조작이 필요한 장애 대응 중일 때

## 미디어 서버 시작 절차

1. AWS EC2 콘솔에서 `live-admin-media` 선택
2. `인스턴스 상태`
3. `인스턴스 시작`
4. 상태 검사 통과 대기
5. `https://console.fineludens.kr/admin/media` 접속
6. gateway 상태와 running stream 목록 확인

## 미디어 서버 시작 후 확인

- `https://console.fineludens.kr/admin/media` 접속 가능
- RTMP/HLS 관련 버튼 응답 정상
- 필요 시 테스트 경기 1건으로 HLS 확인
- 외부 전달용 주소가 고정 IP 기준으로 유지되는지 확인

## 자동 복구 보강(운영 반영됨)

- gateway compose 서비스(`gateway-ffmpeg`, `gateway-rtmp`, `gateway-nginx`)는 `restart: unless-stopped`로 설정한다.
- 미디어 서버 부팅 시 `live-admin-gateway.service`가 `docker compose up -d`를 자동 실행하도록 유지한다.
- 이 기준이 적용돼 있으면 `System Control > Media Server Control`에서 EC2를 켠 뒤 gateway가 자동으로 올라온다.

## 운영 메모

- 앱 서버 고정 IP: `3.217.232.253`
- 미디어 서버 고정 IP: `3.227.35.90`
- 운영 콘솔 URL: `https://console.fineludens.kr/login`
- 기존 `live.fineludens.kr` 안내는 점진적으로 `console.fineludens.kr`로 교체
