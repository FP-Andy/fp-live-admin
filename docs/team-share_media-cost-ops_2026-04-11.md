# Fine Play Console 운영 구조 정리 및 Media 서버 비용 절감 안내

## 핵심 정리

- 현재 운영 구조는 `app 서버`와 `media 서버`가 분리되어 있다.
- `app 서버`는 로그인, 대시보드, Match Control, FPA, 수동 기록(`MANUAL`) 운영에 필요하므로 상시 켜둔다.
- `media 서버`는 RTMP/HLS 송출, `Media` 페이지의 gateway 제어, `STREAM` 경기 운영에만 필요하다.
- 따라서 `STREAM` 경기가 없고 `MANUAL` 경기만 운영하는 시간에는 `media 서버`를 꺼도 된다.
- 이를 위해 운영 콘솔 주소를 `https://console.fineludens.kr`로 정리했고, `System Control`에서 슈퍼어드민이 웹에서 직접 `media 서버`를 켜고 끌 수 있도록 기능을 붙였다.

## 문제 상황

- AWS 비용을 확인한 결과, 월 비용이 200달러 안팎까지 올라가는 구조였다.
- 원인을 보면 가장 큰 비중은 `EC2 인스턴스 상시 운영 비용`이었다.
- 특히 `media 서버`는 실제 송출이 없는 시간에도 계속 켜져 있어 비용이 누적되고 있었다.
- 운영 중 재시작 시 앱 서버나 미디어 서버의 공인 IP가 바뀔 수 있는 상태라, 도메인이나 외부 접근이 불안정해질 위험도 있었다.
- 협업사도 일부 API를 IP 기반으로 확인하고 있어, 주소 변경 시 공유가 늦으면 혼선이 생길 수 있었다.

## 해결 방안

### 1. 운영 주소 및 IP 구조 정리

- 운영 콘솔 대표 주소를 `https://console.fineludens.kr/login`으로 통일했다.
- `live-admin-app`에 Elastic IP를 연결해 고정 IP를 부여했다.
- `live-admin-media`에도 Elastic IP를 연결해 stop/start 후에도 동일 IP를 유지하도록 정리했다.

현재 기준:

- 앱 서버 고정 IP: `3.217.232.253`
- 미디어 서버 고정 IP: `3.227.35.90`

### 2. Media 서버는 필요할 때만 켜는 운영 방식 도입

- `MANUAL` 경기 운영에는 `media 서버`가 필요 없다는 점을 코드와 운영 흐름 기준으로 재확인했다.
- `STREAM` 경기, RTMP/HLS 송출, `Media` 페이지 gateway 조작이 필요한 경우에만 `media 서버`를 켜도록 운영 원칙을 정리했다.

### 3. AWS 콘솔 대신 웹에서 제어 가능하도록 개선

- `System Control`에 `Media Server Control` 기능을 추가했다.
- 슈퍼어드민은 웹에서 아래 작업이 가능하다.
  - `Start Media Server`
  - `Stop Media Server`
- 단, 안전장치를 넣었다.
  - RUNNING stream이 있으면 기본적으로 stop 차단
  - active `STREAM` match가 있으면 기본적으로 stop 차단
  - 정말 필요한 경우에만 추가 확인 후 강제 실행 가능

### 4. 제어 권한은 안전한 방식으로 분리

- 앱 서버가 직접 EC2 권한을 크게 갖는 구조 대신,
  `앱 API -> Lambda Function URL -> EC2 Start/Stop`
  구조로 연결했다.
- 즉 운영 웹에서 버튼은 누르되, 실제 AWS EC2 제어는 전용 Lambda가 담당한다.

## 기대효과

현재 확인한 운영 구조 기준:

- 앱 서버는 상시 유지
- 미디어 서버만 필요할 때 켜는 방식으로 절감

미디어 서버(`c7i-flex.xlarge`, us-east-1 기준)는 대략 시간당 `약 $0.172` 수준으로 보면 된다.

따라서 1주일 기준 절감 효과는 대략 아래처럼 기대할 수 있다.

### 시나리오 A: 하루 12시간씩 7일간 media 서버를 꺼둘 수 있는 경우

- 절감 시간: `84시간`
- 예상 절감: `약 $14.4 / 주`

### 시나리오 B: 하루 16시간씩 7일간 media 서버를 꺼둘 수 있는 경우

- 절감 시간: `112시간`
- 예상 절감: `약 $19.3 / 주`

### 시나리오 C: 수동 기록 위주 주간이라 media 서버를 대부분 꺼둘 수 있는 경우

- 절감 시간: `140시간`
- 예상 절감: `약 $24.1 / 주`

즉 실제 운영 패턴에 따라 차이는 있지만,
`manual 경기 비중이 높고 송출이 없는 시간대가 많을수록 주당 약 15~25달러 수준의 절감`을 기대할 수 있다.

월 기준으로 보면 대략 `60~100달러 안팎`까지도 절감 여지가 있다.

## 운영 방법

### 기본 원칙

- `live-admin-app`은 상시 켠다.
- `live-admin-media`는 `STREAM` 경기나 RTMP/HLS 송출이 필요할 때만 켠다.
- `MANUAL` 경기만 운영하는 날에는 `media 서버`를 꺼도 된다.

### media 서버를 꺼도 되는 경우

- 현재 라이브 송출 중인 경기가 없다.
- RTMP/SRT ingest를 기다리는 경기가 없다.
- 외부에서 HLS를 보고 있는 사용자가 없다.
- 오늘 남은 경기가 모두 `MANUAL` 운영이다.

### media 서버를 반드시 켜야 하는 경우

- 새 스트리밍 경기 생성 직전
- OBS/외부 중계사 송출을 받을 예정일 때
- RTMP 전달 정보 확인이 필요할 때
- `Media` 페이지에서 `Re-attach`, `Stop Stream`, `Clear HLS` 같은 작업이 필요할 때

### 실제 운영 순서

#### 1. STREAM 경기 있는 날

1. 경기 시작 전 `System Control`에서 `Start Media Server`
2. `Media` 페이지에서 gateway 상태 확인
3. RTMP/HLS 확인 후 운영 시작
4. 경기 종료 후 stream 정리
5. 더 이상 송출 없으면 `Stop Media Server`

#### 2. MANUAL 경기만 있는 날

1. 앱 서버는 그대로 켠다
2. `media 서버`는 꺼둔다
3. 운영자는 `console.fineludens.kr`에서 수동 기록만 진행한다

### 참고

- 운영 콘솔: `https://console.fineludens.kr/login`
- 앱 서버 고정 IP: `3.217.232.253`
- 미디어 서버 고정 IP: `3.227.35.90`

### 주의

- 현재 `MEDIA_CONTROL_TOKEN`은 초기 작업 중 노출된 값이므로, 운영 안정화 후 새 값으로 한 번 교체하는 것이 좋다.
- 협업사 API 확인 주소는 `https://console.fineludens.kr/api/v1/...` 기준으로 사용한다.
