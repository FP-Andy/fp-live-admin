# Media Control Lambda

이 Lambda는 `System Control`의 `Start Media Server` / `Stop Media Server` 버튼이 호출하는 외부 control endpoint 예시입니다.

## 입력

POST body:

```json
{
  "action": "status" | "start" | "stop",
  "instance_id": "i-xxxxxxxx",
  "instance_name": "live-admin-media",
  "confirmed_live_action": false
}
```

## 환경변수

- `MEDIA_INSTANCE_ID`
- `MEDIA_INSTANCE_NAME`
- `MEDIA_CONTROL_TOKEN`
- `MEDIA_CONTROL_ALLOWED_ORIGIN`

## IAM

`iam-policy.json`에서 `REPLACE_MEDIA_INSTANCE_ID`를 실제 media EC2 인스턴스 ID로 바꿔 연결합니다.

## 배포 메모

1. Lambda 함수 생성
2. Python 3.12 런타임 선택
3. `lambda_function.py` 업로드
4. 환경변수 설정
5. Function URL 생성
6. Function URL 인증은 `NONE`으로 두고 `MEDIA_CONTROL_TOKEN`으로 보호하거나, IAM 인증 방식을 별도로 구성
7. 앱 서버 `.env`에 아래 값을 설정

```env
MEDIA_CONTROL_URL=https://your-function-url.lambda-url.us-east-1.on.aws/
MEDIA_CONTROL_TOKEN=your-shared-secret
MEDIA_INSTANCE_ID=i-xxxxxxxx
MEDIA_INSTANCE_NAME=live-admin-media
```
