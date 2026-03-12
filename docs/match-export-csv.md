# Match Export CSV Definition

`GET /api/matches/{match_id}/export.csv`는 매치 단위 단일 CSV 파일 1개를 반환합니다.

## Overview

- 파일 형식: CSV (`text/csv`)
- 인코딩: UTF-8
- 행 구분: `record_type`
- 주요 `record_type` 값:
  - `MATCH_META`
  - `XG_EVENT`
  - `ATTACK_LANE_EVENT`
  - `POSSESSION_SEGMENT`
  - `DOMINANCE_BIN`

## Common Columns

| Column | Type | Description |
| --- | --- | --- |
| `record_type` | string | 현재 행의 데이터 타입 |
| `match_id` | uuid string | 매치 ID |
| `match_name` | string | 매치명 |
| `exported_at` | ISO datetime | CSV 생성 시각 (UTC) |
| `match_created_at` | ISO datetime | 매치 생성 시각 (UTC) |
| `operator_id` | string | 현재 lock 보유 사용자 ID. 없으면 빈 값 |
| `current_clock_ms` | integer | export 시점 최신 경기 시계(ms) |
| `current_clock_label` | string | export 시점 최신 경기 시계(`HH:MM:SS`) |

## Event Columns

이 컬럼들은 `XG_EVENT`, `ATTACK_LANE_EVENT` 행에서 사용됩니다.

| Column | Type | Description |
| --- | --- | --- |
| `event_id` | uuid string | 이벤트 ID |
| `event_type` | string | `XG` 또는 `ATTACK_LANE` |
| `event_created_at` | ISO datetime | 이벤트 생성 시각 (UTC) |
| `event_clock_ms` | integer | 이벤트 발생 경기 시계(ms) |
| `event_clock_label` | string | 이벤트 발생 경기 시계(`HH:MM:SS`) |
| `team` | string | `HOME` 또는 `AWAY` |
| `lane` | string | 공격 방향 이벤트의 lane 값 (`LEFT`, `CENTER`, `RIGHT`) |
| `xg` | float | xG 이벤트 값 |
| `is_goal` | boolean | xG 입력 시 Goal 체크 여부 |
| `shot_x` | float | 저장된 슈팅 X 좌표(풀피치 기준, 0~105) |
| `shot_y` | float | 저장된 슈팅 Y 좌표(풀피치 기준, 0~68) |
| `is_header` | boolean | Header 체크 여부 |
| `is_weak_foot` | boolean | Weak Foot 체크 여부 |

## Possession Segment Columns

이 컬럼들은 `POSSESSION_SEGMENT` 행에서 사용됩니다.

| Column | Type | Description |
| --- | --- | --- |
| `segment_id` | uuid string | 점유 구간 ID |
| `team` | string | 해당 구간 점유 팀 (`HOME`, `AWAY`) |
| `segment_start_ms` | integer | 구간 시작 시계(ms) |
| `segment_start_label` | string | 구간 시작 시계(`HH:MM:SS`) |
| `segment_end_ms` | integer | 구간 종료 시계(ms). open segment는 export 시점 clock 사용 |
| `segment_end_label` | string | 구간 종료 시계(`HH:MM:SS`) |
| `segment_duration_ms` | integer | 구간 길이(ms) |

## Dominance Bin Columns

이 컬럼들은 `DOMINANCE_BIN` 행에서 사용됩니다.

| Column | Type | Description |
| --- | --- | --- |
| `bin_k` | integer | 3분 bin index |
| `bin_start_ms` | integer | bin 시작 시계(ms) |
| `bin_start_label` | string | bin 시작 시계(`HH:MM:SS`) |
| `bin_end_ms` | integer | bin 종료 시계(ms) |
| `bin_end_label` | string | bin 종료 시계(`HH:MM:SS`) |
| `home_poss_ms` | integer | 해당 bin의 HOME possession 누적(ms) |
| `away_poss_ms` | integer | 해당 bin의 AWAY possession 누적(ms) |
| `home_xg` | float | 해당 bin의 HOME xG 누적값 |
| `away_xg` | float | 해당 bin의 AWAY xG 누적값 |
| `dominance` | float | `-1.0` ~ `+1.0` dominance 값 |

## Null / Blank Rules

- 현재 `record_type`와 무관한 컬럼은 빈 값으로 출력됩니다.
- 예:
  - `MATCH_META` 행에는 이벤트/세그먼트/bin 컬럼이 비어 있습니다.
  - `ATTACK_LANE_EVENT` 행에는 `xg` 관련 값이 비어 있을 수 있습니다.
  - `XG_EVENT` 행에는 `lane` 값이 비어 있을 수 있습니다.

## Example

```csv
record_type,match_id,match_name,exported_at,match_created_at,operator_id,current_clock_ms,current_clock_label,event_id,event_type,event_created_at,event_clock_ms,event_clock_label,team,lane,xg,is_goal,shot_x,shot_y,is_header,is_weak_foot,segment_id,segment_start_ms,segment_start_label,segment_end_ms,segment_end_label,segment_duration_ms,bin_k,bin_start_ms,bin_start_label,bin_end_ms,bin_end_label,home_poss_ms,away_poss_ms,home_xg,away_xg,dominance
MATCH_META,match-uuid,Demo Match,2026-03-12T08:14:20,2026-03-12T08:04:13,,540000,00:09:00,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
XG_EVENT,match-uuid,Demo Match,2026-03-12T08:14:20,2026-03-12T08:04:13,,540000,00:09:00,event-uuid,XG,2026-03-12T08:10:00,525000,00:08:45,HOME,,0.12,false,88.5,34,false,true,,,,,,,,,,,,,,,,
DOMINANCE_BIN,match-uuid,Demo Match,2026-03-12T08:14:20,2026-03-12T08:04:13,,540000,00:09:00,,,,,,,,,,,,,,,,,,2,360000,00:06:00,540000,00:09:00,102000,78000,0.12,0,0.183
```
