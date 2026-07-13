# xFP 진행 현황 및 점수/가중치 산정 공유본

작성일: 2026-07-06  
대상: 원규 공유용  
예시 페르소나: `Pedri` - 실제 선수가 아니라 설명을 위한 가상의 미드필더

## 한 줄 요약

xFP(Expected Fine Play)는 FPA/FHL에서 기록한 highlight action을 `득점`, `전진`, `소유` 기대효과로 환산해 선수별 raw value를 만들고, 이를 포지션/역할별 가중치로 해석해 `0~100 score`, `6-axis radar`, `best role`로 보여주는 평가 체계다.

핵심 결정은 세 가지다.

1. 행동 정의는 포지션별로 복제하지 않고, 공통 `A01~A24` canonical action id로 관리한다.
2. FPA는 이벤트와 전후 상태를 기록하고 xFP action candidate를 만든다. 최종 점수와 역할 산정은 xFP scoring/model pack 레이어가 담당한다.
3. v0.2 산출물은 percentile 기반 구현으로 검증했고, 2026-07-06 기준 v1 점수 방향은 `absolute_score` 기준곡선 방식으로 freeze했다.

## 참고한 자료

Notion:

- `DB | Handoff` - `Handoff | fp-live-admin FPA Dual Pitch Mode, Quick DSL, xGOT 입력 UI - 2026-07-02`
- `DB | Handoff` - `Handoff | fp-live-admin FPA Model Room 및 xFP Canonical Weights - 2026-07-02`
- `DB | Document` - `xFP score`, 최종 편집 2026-07-06

Obsidian / local:

- `/Users/andy/Project/andy_obsidian/10_Projects/xFP/xFP.md`
- `/Users/andy/Project/andy_obsidian/10_Projects/xFP/Architecture/Internal Logic and Weights.md`
- `/Users/andy/Project/andy_obsidian/10_Projects/xFP/Architecture/FPA Dual Pitch Mode Schema.md`
- `/Users/andy/Project/andy_obsidian/10_Projects/xFP/Architecture/FPA Quick DSL and Canonical Logic.md`
- `/Users/andy/Project/andy_obsidian/10_Projects/xFP/Architecture/FPA xFP Action Mapping Rules.md`
- `/Users/andy/Project/andy_obsidian/10_Projects/xFP/Architecture/FPA Excel Export and Model Trace Schema.md`
- `/Users/andy/Project/andy_obsidian/10_Projects/xFP/Architecture/xFP Source Data to FPA Adapter Schema.md`
- `/Users/andy/Project/xFP/outputs/xfp_v02`

## 1. 현재까지 진행된 것

### 1.1 xFP v0.2 모델/산출물

6개 리그 이벤트 데이터를 기준으로 xFP v0.2 산출물이 만들어져 있다.

| 항목 | 값 |
|---|---:|
| 원본 입력 이벤트 | 4,238,008 rows |
| xFP scored event rows | 2,692,435 rows |
| 평가 선수 | 2,624명 |
| canonical action key | 24개 |
| role score rows | 305,838 rows |
| 최종 workbook | `/Users/andy/Project/xFP/outputs/xfp_v02/xfp_v02_player_evaluation.xlsx` |

초기 v0.2 summary에는 `22/24 action coverage` 이슈가 남아 있었지만, 이후 duel supporting rule 보강 후 현재 run metadata 기준으로는 `unique_action_keys = 24`다.

### 1.2 FPA 입력 도구 확장

2026-07-02 handoff 기준으로 FPA Live Logger는 xFP 입력을 위해 다음 방향으로 확장됐다.

- 기존 single pitch mode는 유지한다.
- dual pitch mode에서 `before_state`, `event`, `after_state`를 분리한다.
- `ally` / `opp` freeze-frame point를 찍어 pitch control proxy와 pressure context를 만들 수 있게 한다.
- `1ss2.k.f.w` 같은 quick DSL은 계속 유지하되 저장 시 canonical event로 정규화한다.
- shot 계열은 `Shot` 이벤트로 통합하고, `Goal`, `On Target`, `Blocked` 같은 결과는 result/tag로 관리한다.
- Excel export에는 `Canonical Events`, `Dual Pitch States`, `Action Candidates`, `Model Config`, `xG/EPV/Pitch Control Calculation`, `Radar`, `Role Profile` 같은 trace sheet를 포함하는 방향이다.

### 1.3 Model Room / canonical weights

FPA의 `Visual Reports`는 `Model Room`으로 재구성됐다.

관리 슬롯:

- xG
- xGOT
- EPV
- Pitch Control
- xFP Weights

xFP weights는 이제 `FW_Axx/MF_Axx/DF_Axx`를 별도 행동으로 보지 않는다. 이 legacy code는 기존 workbook 호환용 alias이고, 실제 행동 정의는 공통 `A01~A24`다.

예:

- `MF_A01~MF_A24 -> A01~A24`
- `FW_A04 -> A08`
- `DF_A01 -> A04`

즉, 포지션별 차이는 action을 쪼개서 만들지 않고, `position action scope`, `radar axis weight`, `role weight`에서 해석한다.

## 2. xFP의 기본 구조

xFP 행동은 네 가지 변수의 조합이다.

```text
Action = Event / Condition / Level / Outcome
```

| 변수 | 값 |
|---|---|
| Event | Pass, Cross, Shot, Defense, Dribble, Penetration, Press, Duel |
| Condition | OWN, OPP |
| Level | Direct, Indirect |
| Outcome | Goal, Progression, Possession |

엔진은 기대효과별로 다르다.

| Outcome | 엔진 | 기본 계산 |
|---|---|---|
| Goal | `fp_xG` | shot location/context 기반 기대득점 |
| Creation | `fp_xG/xAG link` | linked shot의 xG를 key pass/assist credit으로 사용 |
| Progression | `fp_EPV` | `max(0, EPV_after - EPV_before)` |
| Possession | `Pitch Control` | `max(0, PC_after - PC_before)` |

현재 full tracking이 없을 때는 Pitch Control을 proxy로 계산한다. FPA/FPC tracking이 붙으면 `pc_delta_actor`를 실제 pitch control 변화량으로 교체하는 것이 목표다.

## 3. Canonical 24 Action

| ID | Action Key | Engine |
|---|---|---|
| A01 | `Shot/OPP/Direct/Goal` | fp_xG |
| A02 | `Pass/OPP/Indirect/Goal` | linked shot xG |
| A03 | `Cross/OPP/Indirect/Goal` | linked shot xG |
| A04 | `Pass/OWN/Direct/Progression` | EPV delta |
| A05 | `Pass/OPP/Indirect/Progression` | linked teammate progression |
| A06 | `Cross/OPP/Direct/Progression` | EPV delta |
| A07 | `Dribble/OWN/Direct/Progression` | EPV delta |
| A08 | `Dribble/OPP/Direct/Progression` | EPV delta |
| A09 | `Penetration/OPP/Direct/Progression` | EPV delta |
| A10 | `Penetration/OPP/Indirect/Progression` | linked teammate progression |
| A11 | `Pass/OWN/Direct/Possession` | PC delta |
| A12 | `Pass/OPP/Direct/Possession` | PC delta |
| A13 | `Dribble/OWN/Direct/Possession` | PC delta |
| A14 | `Dribble/OPP/Direct/Possession` | PC delta |
| A15 | `Defense/OWN/Direct/Possession` | PC delta |
| A16 | `Defense/OWN/Indirect/Possession` | PC delta * support credit |
| A17 | `Defense/OPP/Direct/Possession` | PC delta |
| A18 | `Defense/OPP/Indirect/Possession` | PC delta * support credit |
| A19 | `Press/OPP/Direct/Possession` | press PC delta |
| A20 | `Press/OPP/Indirect/Possession` | press PC delta * support credit |
| A21 | `Duel/OWN/Direct/Possession` | PC delta |
| A22 | `Duel/OPP/Direct/Possession` | PC delta |
| A23 | `Duel/OWN/Indirect/Possession` | PC delta * support credit |
| A24 | `Duel/OPP/Indirect/Possession` | PC delta * support credit |

포지션 사용 범위:

- FW: 14개 action 중심
- MF: 24개 action 전체 사용
- DF: 20개 action 중심

Pedri 예시는 미드필더이므로 `A01~A24` 전부가 후보가 될 수 있다.

## 4. 점수 산정 결정사항

### 4.1 raw xFP

raw xFP는 행동이 만든 기대효과의 원시값이다.

```text
Goal        = fp_xG
Creation    = linked shot fp_xG or xAG-like credit
Progression = max(0, EPV_after - EPV_before)
Possession  = max(0, PC_after - PC_before)
Indirect    = linked main value * credit
```

현재 주요 credit:

| 항목 | 값 |
|---|---:|
| ASSIST | 1.00 |
| CROSS_ASSIST | 1.00 |
| INDIRECT_PROGRESSION | 0.35 |
| SPACE_CREATION | 0.30 |
| PRESS | 0.35 |
| DEFENSIVE_SUPPORT | 0.30 |
| DUEL_SUPPORT | 0.25 |

v1 설계에서는 난이도 보정도 추가됐다.

- `cone`: 슛 앞의 수비/GK 차단 각도 보정
- `packing`: 패스/크로스가 수비 라인을 얼마나 통과했는지 보정
- `DCM`: 반경 10m 수적 우열 기반 맥락 보정

### 4.2 v0.2 구현 스냅샷과 v1 freeze의 차이

원규에게 공유할 때 가장 헷갈리기 쉬운 부분이다.

v0.2 구현/산출물:

- 선수별 action raw score를 만든다.
- 같은 `position_group + action_id` 안에서 percentile rank로 `NormalizedActionScore`를 만든다.
- role score는 action score의 weighted average다.
- best role raw score를 다시 같은 포지션 그룹 안에서 normal-rank T-score로 보정한다.
- 기준 집단은 `six_league_pro_2025_26_outfield`, 평균 70, 표준편차 10, 상한 99.5다.

v1 점수 방향 freeze:

- percentile을 기본 점수로 쓰지 않는다.
- 각 outcome별 고정 기준곡선으로 raw를 `0~100`에 매핑한다.
- 같은 raw는 언제나 같은 score가 되므로 cohort가 없어도 cold-start 점수 산정이 가능하다.
- percentile은 나중에 `상위 n%` 같은 보조 라벨로만 붙일 수 있다.

v1 absolute score:

```text
absolute_score(v) = 100 / (1 + exp(-k * (v - ref50)))
k = ln(85/15) / (ref_hi - ref50)
```

현재 reference:

| Outcome | ref50 | ref_hi |
|---|---:|---:|
| Goal / Creation | 0.068 | 0.188 |
| Progression | 0.0013 | 0.0083 |
| Possession | 0.030 | 0.120 |

예:

- xG `0.188`은 85점
- progression delta `0.0083`도 85점
- possession delta `0.120`도 85점

이렇게 하면 raw scale이 서로 달라도 “각 행동 종류 안에서 얼마나 좋은 행동이었나”를 같은 0~100 눈금으로 비교할 수 있다.

### 4.3 역할 점수

역할 점수는 `action score * role weight`의 weighted average다.

```text
BaseRoleScore(role) =
    sum(NormalizedActionScore(action_id_i) * RoleWeight_i)
    / sum(RoleWeight_i)

RoleScore =
    BaseRoleScore + ProductionScore * ProductionBonusWeight

BestRole =
    argmax(RoleScore)
```

production bonus는 버전별로 구분해서 말하는 것이 좋다.

- v0.2 config에는 역할별 production bonus weight가 이미 있다. 예: `MF:Advanced Playmaker = 0.08`, `MF:Mezzala = 0.07`.
- 2026-07-06 v1 score 문서는 임시 운영값으로 `FW 0.19`, `MF 0.05`, `DF 0.025`를 제시하고, 역할별 세부 CSV는 추후 구현 항목으로 남겨두었다.
- 따라서 공유 시에는 “역할별 action weight 체계는 유지하고, production bonus는 v1 구현 단계에서 최종 config로 정리한다”라고 설명하면 된다.

미드필더 역할 후보는 현재 7개다.

- Advanced Playmaker
- Anchor
- Ball Winning Midfielder
- Box To Box
- Deep-Lying Playmaker
- Mezzala
- Wide Midfielder

예를 들어 `Advanced Playmaker`는 다음 성격이다.

```text
(2*A01 + 5*A02 + 3*A04 + 4*A05 + 2*A08 + 2*A10 + 4*A12 + 2*A14 + 1*A20) / 25
```

축구적으로는 슈팅 자체보다 `A02` 찬스메이킹, `A04/A05` 전진 패스, `A12/A14` 상대 진영 소유 안정의 비중이 높다. 그래서 Pedri 같은 창조형 미드필더 예시에 잘 맞는다.

## 5. Pedri 페르소나 예시

Pedri는 가상의 중앙/공격형 미드필더다.

설정:

- 포지션 그룹: MF
- 플레이 스타일: 라인 사이에서 공을 받고, 짧은 전진 패스와 운반으로 팀의 전진을 만든다.
- 강점: key pass, carry progression, 상대 진영 possession security
- 보통: 슈팅 볼륨, 직접 득점 위협
- 부가 기여: counterpress, second-ball duel

예시 action:

| Action | 상황 | raw 해석 |
|---|---|---|
| A02 | through ball이 슛으로 연결 | Creation |
| A04 | 자기 진영에서 전진 패스 | Progression |
| A08 | 상대 진영에서 라인 사이 운반 | Progression |
| A12 | 상대 진영 압박 속 패스 유지 | Possession |
| A14 | 드리블 후 소유 안정 | Possession |
| A19 | counterpress 직접 회수 | Possession |
| A21 | 자기 진영 second-ball duel win | Possession |
| A01 | zone 14 낮은 볼륨 슈팅 | Goal |

실행 코드:

```bash
python3 scripts/xfp_pedri_score_example.py
```

예시 출력 요약:

```text
Best role: Advanced Playmaker (68.4)

Advanced Playmaker: base=62.6, production_bonus=5.8, total=68.4
Mezzala: base=58.6, production_bonus=5.0, total=63.7
Wide Midfielder: base=57.4, production_bonus=4.3, total=61.7
Box To Box: base=56.9, production_bonus=4.3, total=61.3
```

해석:

- Pedri의 `A02`, `A04`, `A08`, `A12`가 높게 나오므로 Advanced Playmaker가 가장 높다.
- Mezzala도 높지만, Wide Midfielder나 Box To Box보다 중앙 창조형 패턴이 더 강하다.
- 슈팅 점수는 낮아도, xFP는 단순 득점/슈팅 카운트가 아니라 전진과 찬스 연결까지 보기 때문에 창조형 MF가 설명된다.

## 6. 원규에게 강조하면 좋은 메시지

1. xFP는 “선수 능력치”를 임의로 매기는 것이 아니라, 각 행동이 득점 가능성을 얼마나 움직였는지 공통 단위로 바꾸는 체계다.
2. FPA는 입력 도구이고, xFP는 scoring/model layer다. FPA는 action candidate와 evidence를 만들고, xFP가 점수/역할/레이더를 산정한다.
3. canonical action은 전 포지션 공통 `A01~A24`다. 포지션 차이는 action 복제가 아니라 role/radar weight로 표현한다.
4. 현재 산출물은 v0.2 기준으로 이미 6개 리그, 2,624명, 24 action coverage까지 검증됐다.
5. 2026-07-06 v1에서는 consumer score를 percentile이 아니라 absolute reference curve로 고정하는 방향이 freeze됐다.
6. full tracking 전까지 Pitch Control은 proxy라고 분명히 말해야 한다.
7. 내부 weight와 세부 산식은 기술 자산이다. 외부 공유 문서에는 개념, 검증 수치, 큰 흐름만 노출한다.

## 7. 남은 과제

- 시간창 소급 링킹 구현: pass/cross -> shot 15초, indirect progression 8초.
- in-domain data로 `ref50/ref_hi` 기준치 재산정.
- possession reference는 full batch 분포를 보고 provisional 상태에서 확정.
- FPA/FPC tracking 기반 실제 Pitch Control delta 구현.
- `one_on_one`, press tag, freeze-frame 입력을 클립툴에 반영.
- role별 `axis_requiredness`와 missing-action absence policy를 앱 표시단에 연결.
- Model Room upload/download에 schema validation과 version notes 규칙 추가.
