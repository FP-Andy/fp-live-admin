# Live Admin 배포 실행 체크리스트 (AWS, 10명 동시 운영 기준)

이 문서는 비개발자 기준으로 "그대로 따라하면 배포"가 목표입니다.

## 0) 목표 구성

- 앱 서버 1대: `web + api` (Docker Compose)
- 영상 서버 1대: `rtmp + ffmpeg + hls` (Docker Compose)
- DB 1개: `RDS PostgreSQL`
- 도메인:
  - `admin.yourdomain.com` (관리자 웹)
  - `rtmp.yourdomain.com` (OBS 서버 주소)
  - `hls.yourdomain.com` (영상 재생)

---

## 1) 사전 준비

- [ ] AWS 계정 생성/결제 등록
- [ ] 도메인 준비(가비아/Route53 등)
- [ ] 운영 리전 결정 (권장: `ap-northeast-2`, 서울)
- [ ] SSH 접속용 키페어 생성 (`.pem`)

---

## 2) AWS 리소스 생성

### 2-1. EC2 2대 생성

- [ ] `EC2 #1` 앱 서버 생성
  - Ubuntu 22.04
  - 권장 사양: `t3.large` (2vCPU, 8GB)
  - 이름: `live-admin-app`
- [ ] `EC2 #2` 영상 서버 생성
  - Ubuntu 22.04
  - 권장 사양: `c6i.2xlarge` 이상 (8vCPU 이상)
  - 이름: `live-admin-media`

### 2-2. 보안그룹(Security Group) 설정

- [ ] 앱 서버 SG 인바운드
  - `22` (내 IP만)
  - `80` (전체 또는 LB만)
  - `443` (전체 또는 LB만)
- [ ] 영상 서버 SG 인바운드
  - `22` (내 IP만)
  - `1935` (OBS 송출 허용 IP)
  - `8080` (내부 확인용, 운영은 443 프록시 권장)
- [ ] DB SG 인바운드
  - `5432` (앱 서버 SG만 허용)

### 2-3. RDS PostgreSQL 생성

- [ ] 엔진: PostgreSQL 16
- [ ] 인스턴스 클래스: `db.t4g.medium` 이상
- [ ] DB 이름: `live_admin`
- [ ] 유저/비밀번호 생성 후 안전 보관
- [ ] 자동 백업 7일 이상 활성화

---

## 3) 도메인 연결

- [ ] `admin.yourdomain.com` -> 앱 서버 공인 IP
- [ ] `rtmp.yourdomain.com` -> 영상 서버 공인 IP
- [ ] `hls.yourdomain.com` -> 영상 서버 공인 IP

DNS 전파는 수분~수시간 걸릴 수 있음.

---

## 4) 서버 기본 세팅 (앱/영상 공통)

각 서버에 SSH 접속 후 실행:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release git
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker --version
docker compose version
```

- [ ] Docker 설치 확인
- [ ] Docker Compose 확인

---

## 5) 코드 배치

앱/영상 서버 모두 동일하게:

```bash
git clone <YOUR_REPO_URL>
cd "<REPO_DIR>"
```

- [ ] 리포지토리 클론 완료

---

## 6) 영상 서버 배포 (RTMP/HLS)

영상 서버에서:

```bash
cd infra/gateway
docker compose up -d --build
docker compose ps
```

검증:

```bash
curl -sS http://127.0.0.1:8090/health
curl -sS http://127.0.0.1:8081/health
```

- [ ] `gateway-ffmpeg` Up
- [ ] `gateway-rtmp` Up
- [ ] health 응답 OK

---

## 7) 앱 서버 배포 (web/api/postgres 제외 -> RDS 사용)

중요: `infra/app/docker-compose.yml`의 `postgres` 서비스는 운영에서 제거하거나 미사용 처리 권장.

앱 서버에서 환경변수 파일 작성(예: `.env.prod`):

```env
DATABASE_URL=postgresql+psycopg2://<USER>:<PASS>@<RDS_ENDPOINT>:5432/live_admin
GATEWAY_API_BASE=http://<MEDIA_SERVER_PRIVATE_IP>:8090
NEXT_PUBLIC_API_BASE=/api
NEXT_PUBLIC_DEFAULT_HLS_URL=
```

실행:

```bash
cd infra/app
docker compose --env-file .env.prod up -d --build
docker compose ps
```

검증:

```bash
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000/api/matches
```

- [ ] 앱 스택 Up
- [ ] `/health` OK
- [ ] `/api/matches` OK

---

## 8) SSL(HTTPS) 적용

권장: Nginx + Let's Encrypt(certbot)

- [ ] 앱 서버에 `admin.yourdomain.com` SSL 적용
- [ ] 필요 시 `hls.yourdomain.com` SSL 적용

검증:

- [ ] `https://admin.yourdomain.com/admin/dashboard` 접속 가능

---

## 9) 실제 송출 테스트 (OBS)

OBS 설정:

- 서버: `rtmp://rtmp.yourdomain.com/live`
- 스트림키: `<match_id>`

앱에서 매치 생성 후 RTMP 연결 확인:

- [ ] Dashboard에서 매치 생성
- [ ] Match 페이지 `HLS Stream` 영상 표시 확인
- [ ] 5분 이상 송출 후 DVR(되감기) 동작 확인

---

## 10) 운영 안정화(필수)

- [ ] EC2 재부팅 자동시작(systemd or restart policy) 설정
- [ ] CloudWatch 알람 설정
  - EC2 CPU/메모리
  - 디스크 사용률
  - 컨테이너 다운 감지
- [ ] DB 자동백업 확인
- [ ] 주 1회 복구 리허설(백업 복원 테스트)

---

## 11) 확장 계획(동접 증가 시)

- [ ] 영상 서버 2대로 확장(매치 분산)
- [ ] HLS를 S3+CDN으로 이전
- [ ] 앱 서버 2대 + 로드밸런서(ALB)

---

## 빠른 장애 체크

```bash
# 앱 서버
cd infra/app && docker compose ps
curl -sS http://127.0.0.1:3000/health

# 영상 서버
cd infra/gateway && docker compose ps
curl -sS http://127.0.0.1:8090/health
curl -sS http://127.0.0.1:8081/health
```

