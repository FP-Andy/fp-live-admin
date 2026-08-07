# 득점·도움 랭킹 집계 — FinePlay 백엔드 요청 스펙 (2026-08-07)

> 앱 **팀 상세 → 기록 탭**의 "득점 순위"·"도움 순위"가 전원 0으로 나오는 문제.
> 원인 분석과, 백엔드가 집계하는 방향(B안)의 구현 스펙.
> 작성: FPC(콘솔) 측. 대상: FinePlay 백엔드.

---

## 1. 지금 왜 전원 0인가

랭킹 값이 앱까지 오는 경로는 이렇습니다.

```
FPC 콜백 payload.playerProfiles[].goalProductionScore / assistProductionScore
  ↓  XfpResultIngestService:418-419   ← 받은 값을 그대로 set 할 뿐, 계산하지 않음
XfpPlayerProfileEntity.goalProductionScore / assistProductionScore
  ↓  XfpClipQueryService:158 → XfpPlayerProfileResponse.goalProduction / assistProduction
앱 api_xfp_record_repository.dart:72-73   goals = goalProduction.round()
  ↓  RecordMetric.goal / .assist → 기록 탭 "득점 순위" / "도움 순위"
```

**끊긴 곳은 맨 위입니다.** FPC 콜백 페이로드는 `analysisRequestId`·`teamId`·`pipelineVersion`·`status`·`clips` 다섯 개뿐이고 **`playerProfiles`를 보내지 않습니다.** 그래서 `goalProduction`이 계속 비어 있고, 앱은 `?? 0`으로 떨어져 전원 0이 됩니다.

## 2. 왜 백엔드 집계인가 (B안 선택 이유)

`playerProfiles`를 FPC가 채워 보내는 방법(A안)도 있지만 택하지 않았습니다.

- **랭킹은 본질적으로 누적**입니다. FPC는 분석 신청 1건(= 경기 1건)만 아는 쪽이라 누적치를 만들 수 없습니다. 경기별 값을 보내면 백엔드가 어차피 누적해야 합니다.
- 앱 필터에 **기간 선택**이 이미 있습니다 — `RecordPeriod`: 전체 / 최근 5경기 / 한달 / 3개월 / 시즌 (`player_record_filter.dart`). 경기별 스냅샷만으로는 이 필터를 만족시킬 수 없습니다.
- 필요한 원자료(클립별 선수별 액션)는 **이미 백엔드 DB에 저장돼 있습니다**(§4).

## 3. FPC가 보장하는 것 (2026-08-07 콘솔 반영)

지금까지 dual 태깅의 **결과가 태그에만 있고 액션 이름에는 반영되지 않아**, 골·유효슛·빗나간 슛이 전부 `"Shot"` 하나로, 어시스트·키패스·일반 패스가 전부 `"Pass"` 하나로 나갔습니다. 이번에 콘솔에서 승격하도록 고쳤습니다.

| 원본 (dual) | 결과 태그 | 전송되는 `action` | `actionLabel` |
|---|---|---|---|
| `Shot` | `Goal` | **`Goal`** | 골 |
| `Shot` | `On Target` | **`Shot On Target`** | 유효 슈팅 |
| `Shot` | `Blocked` | **`Blocked Shot`** | 블록된 슈팅 |
| `Shot` | (없음 / `Off Target`) | `Shot` | 슈팅 |
| `Pass` | `Assist` | **`Assist`** | 어시스트 |
| `Pass` | `Key Pass` | **`Key Pass`** | 키패스 |
| `Pass` | (그 외) | `Pass` | 패스 |

- `Fail` 태그가 붙은 행은 승격하지 않습니다(실패한 패스는 어시스트일 수 없음).
- 24코드(`actionCode`)는 승격 전후가 같습니다 — 슈팅류는 계속 `G1`, 패스류는 `G2`. **기존 채점 로직에 영향 없습니다.**

이 값이 실리는 위치는 두 곳입니다.

```jsonc
"teamView": {
  "actions": [
    { "seq": 3, "action": "Goal", "actionLabel": "골",
      "teamSide": "home", "jersey": "10",
      "playerId": "9003", "userId": 9003, "actionCode": "G1", "xg": 0.31 }
  ]
},
"involvedPlayers": [
  { "playerId": "9003", "playerName": "홍길동", "contributionRole": "SHOOTER",
    "playerView": { "jerseyNumber": "10",
      "actions": [ { "seq": 3, "action": "Goal", "actionLabel": "골", "xg": 0.31 } ] } }
]
```

## 4. 집계 스펙

### 4-1. 원자료

이미 저장돼 있는 것을 그대로 씁니다.

| 엔티티 | 쓸 것 |
|---|---|
| `XfpClipPlayerEntity` | `clipId`, `playerRef`, `userId`, **`playerViewJson`** → `.actions[].action` |
| `XfpHighlightClipEntity` | `analysisRequestId`, `teamId`, `clipKey`, `teamViewJson` |
| `XfpPlayerProfileEntity` | 결과 저장 대상. 키 = `(teamId, playerRef)` |

**권장 소스는 `XfpClipPlayerEntity.playerViewJson.actions`** 입니다 — 이미 선수 단위로 갈려 있어 `playerRef` 기준 그룹핑이 바로 됩니다.

`XfpHighlightClipEntity.teamViewJson.actions`를 쓰는 것도 가능하지만, 그 배열에는 **상대 팀 액션도 포함**되므로 `playerId`가 있는 행만 골라야 합니다(상대 팀 선수는 라인업 매칭 대상이 아니라 `playerId`가 없습니다).

### 4-2. 계산 규칙

```
득점(goals)   = 그 선수의 액션 중 action == "Goal"   인 것의 개수
도움(assists) = 그 선수의 액션 중 action == "Assist" 인 것의 개수
```

- 한 클립 안에서 같은 선수가 여러 번 나올 수 있으므로 **액션 단위로 셉니다**(클립 단위 아님).
- 문자열 완전 일치로 판정하십시오. `actionLabel`(한글)은 표시용이라 판정 기준으로 쓰지 마십시오.

### 4-3. 저장

`XfpPlayerProfileEntity`의 기존 필드를 채웁니다.

| 필드 | 값 |
|---|---|
| `goalProductionScore` | 득점 카운트 |
| `assistProductionScore` | 도움 카운트 |

**앱은 수정할 필요가 없습니다.** `api_xfp_record_repository.dart:72-73`이 `goalProduction`/`assistProduction`을 `.round()`해서 `goals`/`assists`로 쓰고 있어, 정수 카운트를 Double로 실어도 그대로 동작합니다.

> ⚠️ 이름이 `...Score`인데 카운트를 넣는 게 걸린다면, 별도 정수 필드(`goals`/`assists`)를 신설하는 쪽이 의미상 깨끗합니다. 다만 그 경우 **앱 리포지토리도 함께 고쳐야** 합니다. 나중에 진짜 "생산성 점수"를 도입할 계획이 있다면 지금 필드를 나눠 두는 편이 낫습니다.

### 4-4. 기간 필터

앱의 `RecordPeriod`(전체·최근 5경기·한달·3개월·시즌)를 지원하려면 집계 시 **클립 → 분석신청 → 경기일** 조인이 필요합니다. `XfpHighlightClipEntity.analysisRequestId`로 거슬러 올라가면 됩니다.

전체 기간만 먼저 채우고 기간별은 후속으로 해도 앱은 동작합니다(현재 기본 필터가 전체).

## 5. 반드시 지켜야 할 것

- **재계산이지 증분이 아닙니다.** 클립은 `clipKey` 멱등키로 upsert되고, 재전송하면 그 클립의 액션이 **전체 교체**됩니다. 집계를 증분으로 더하면 재전송 때마다 골이 불어납니다. 매번 현재 상태에서 다시 세십시오.
- **하이라이트만(basic) 신청 클립은 액션이 없습니다.** `teamView`·`involvedPlayers`가 통째로 빠져 오므로 집계에 0으로 기여합니다. 정상입니다.
- **상대 팀 선수는 제외됩니다.** `playerId`가 없어 `XfpClipPlayerEntity`에 들어가지 않습니다.

## 6. 기존 데이터 백필

승격 규칙 이전에 저장된 클립은 백엔드 DB에 `action: "Shot"` / `"Pass"`로 남아 있습니다. **콘솔에서 해당 매치를 재전송하면** 승격된 이름으로 덮어써집니다(콘솔이 DB의 태그를 읽어 되살립니다 — 콘솔 쪽 마이그레이션은 불필요).

백필 대상 경기 목록이 필요하면 알려주십시오.

## 7. 검증 방법

1. 골이 있는 클립을 콘솔에서 재전송.
2. `XfpClipPlayerEntity.playerViewJson`에 `"action": "Goal"`이 들어왔는지 확인.
3. 집계 후 `XfpPlayerProfileEntity.goalProductionScore` 확인.
4. 앱 팀 상세 → 기록 탭 → "득점 순위"에 반영되는지 확인.

같은 매치를 두 번 재전송해도 **카운트가 늘지 않아야** 합니다(§5 재계산 규칙).

---

## 부록 — 근거 위치

| 사실 | 위치 |
|---|---|
| 백엔드는 받은 값만 저장 | `XfpResultIngestService.java:418-419` |
| 프로필 응답 필드 | `XfpPlayerProfileResponse.java:20-21` |
| 앱의 goals/assists 매핑 | `FinePlay_App/lib/data/repository/team/api_xfp_record_repository.dart:72-73` |
| 앱 랭킹 정렬 기준 | `lib/data/mock/xfp_mock_source.dart:132-135`, `player_record_filter.dart` |
| 콘솔 액션 승격 규칙 | `fp-live-admin/apps/api/app/fineplay_fpa.py` `canonical_action_name()` |
| 콘솔 페이로드 조립 | `fp-live-admin/apps/api/app/main.py` `_build_clip_result_payload()` |
