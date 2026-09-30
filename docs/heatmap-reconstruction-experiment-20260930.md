# 관측 기반 히트맵 보강: 1차 실험

2026-09-30. 상태: 로컬 실험, 운영 미적용. 모델·GPU 작업·선수 연결·기존 스냅샷은 변경하지 않았다.

## 결론

최대 3초인 같은 트랙의 공백에 앞뒤 이동 방향을 반영한 연결을 적용하는 후보가 별도 경기 검증 기준을 통과했다. 5초 이상은 설정한 위치 오차 기준을 넘었다. 확률 분포를 넓히는 후보는 짧은 공백에서 추가 이점을 보이지 않아 채택하지 않았다.

실제 누락에 적용한 보강량은 광주–경남 평균 0.84%p, 울산–전북 평균 0.95%p다. 이는 **관측률 향상이 아니라 별도로 추정한 시간의 비율**이다. 작은 공백을 채우는 효과는 있지만 장시간 미연결이나 잘못된 신원을 해결하는 결과는 아니다.

## 데이터 및 검증 범위

- 광주–경남 9차 적용 결과, 필드 선수 10명. 경기 전반부에서 709개 가림 구간으로 후보와 최대 공백 길이를 선택했다.
- 울산–전북 6차 적용 결과, 필드 선수 10명. 선택 후 다른 경기의 717개 구간에서 별도 검증했다.
- 기본 비교 1,426개 구간에서 0.5/1/2/3/5/10초를 연속으로 가렸다. 모델 선택 후 미세 공백 480개를 추가 검증해 총 1,906개다. 같은 길이의 구간은 선수별로 서로 겹치지 않는다. 서로 다른 길이끼리는 일부 관측을 공유하므로 전체 1,906개가 독립 표본은 아니다.
- 기존 관측 좌표는 **대리 기준**이다. 사람의 프레임별 신원·좌표 정답을 새로 만든 실험이 아니다. 안정적으로 관측된 구간을 가렸으므로 실제 경합·가림·오식별보다 쉬울 수 있다.
- 가린 좌표는 정답 비교에만 사용했다. 복원 함수에는 양쪽의 보이는 관측만 전달했다.
- 초기 등번호는 기존 리뷰의 식별 번호이며 실제 유니폼 번호로 재확인한 데이터는 아니다.
- 원본 입력 SHA-256, 경기 ID, 적용 버전은 결과 JSON에 기록했다.

## 비교 후보와 선택 기준

8개 후보: 직선, 앞뒤 속도를 반영한 Hermite 연결, 각 연결 주변에 0.05/0.15/0.5 m²/s 이동 분산을 둔 확률 밀도.

Hermite 후보는 앞뒤 1.2초의 실제 관측에 직선 회귀를 적용해 속도를 추정한다. 불안정한 접선이 지배하지 않도록 곡선과 직선을 1:1로 혼합한다. 같은 트랙, 양쪽 0.5초 이상 관측, 최대 이동 속도 8 m/s를 요구한다. 수치는 선수별 이름·경기 시각·트랙 ID에 맞춘 예외가 아닌 공통 실험 설정이다.

선택 전에 고정한 잠정 통과 기준: 각 길이별 30개 이상, 처리 가능 비율 60% 이상, 분포 오차 5% 이상 감소, 구간 RMSE의 95백분위 1.5 m 이하. 이 허용 오차 자체도 향후 제품 기준으로 재검토할 수 있다. 광주 데이터에서 선택한 뒤 울산 데이터에 같은 기준을 적용했다.

### 별도 경기 결과: 울산–전북

| 가린 길이 | 표본 수 | 평균 구간 RMSE | 구간 RMSE 95백분위 | 빈 구간을 유지한 경우 대비 분포 오차 감소 |
| --- | ---: | ---: | ---: | ---: |
| 0.5초 | 120 | 0.10 m | 0.18 m | 86.7% |
| 1초 | 120 | 0.13 m | 0.25 m | 87.2% |
| 2초 | 120 | 0.26 m | 0.70 m | 78.9% |
| 3초 | 120 | 0.42 m | 0.95 m | 68.9% |
| 5초 | 120 | 0.80 m | 1.69 m | 55.2% |
| 10초 | 117 | 2.11 m | 4.33 m | 30.8% |

위치 오차는 가려둔 기존 CV 좌표 대비 값이다. 실측 위치나 신원 정확도 향상을 뜻하지 않는다. 분포 오차는 가린 구간과 양쪽 문맥을 합친 창에서 정규화된 체류 분포의 total variation이다. 1 m 격자, 0.75 m 공간 평활화를 모든 후보·기준에 동일 적용했다. 분모는 같은 구간을 비워 둔 지도의 오차다. 선수별 전체 경기 히트맵의 오차가 위 비율만큼 줄었다는 의미가 아니다.

## 실제 누락에 적용한 결과

| 경기 | 기존 평균 유효 관측 | 별도 추정 보강 | 선수 1명당 평균 보강 시간 |
| --- | ---: | ---: | ---: |
| 광주–경남 | 90.56% | 0.84%p | 7.78초 |
| 울산–전북 | 76.99% | 0.95%p | 8.78초 |

연결이 끊긴 첫부분·끝부분은 외삽하지 않는다. 다른 트랙 ID 사이, 같은 ID가 다른 선수에게 배정된 구간, 팀 충돌·중복 신원·코트 밖 관측이 있는 구간도 보강하지 않는다. 실제 관측의 grid/positions/coverage는 불변이다. estimatedGrid, inferredSeconds, 공백별 근거와 제외 사유를 별도 보관한다. 추정 좌표는 거리·속도·FPA 이벤트에 사용하지 않는다.

실제 보강의 상당수가 0.5초 미만이라 선택한 모델을 바꾸지 않은 채 목표 0.05초(실제 프레임 간격으로 반올림)와 0.2초를 추가로 검증했다. 광주·울산 각각 길이별 120개, 총 480개에서 동일 기준을 통과했다. 울산의 평균 구간 RMSE는 각각 0.053 m, 0.072 m였다. 이것도 CV 좌표를 가린 비교이므로 실제 가림·신원 오류 장면의 영상 대조를 대체하지 않는다.

남은 공백에는 양쪽 문맥 부족으로 제외한 시간이 선수당 평균 약 24초씩 있다. 이는 다음 실험 후보이며 전부 복원할 수 있다는 뜻은 아니다. 여러 작은 누락이 섞인 문맥에서 실제 관측만으로 속도를 추정해도 안정적인지 검증할 가치가 있다. 트랙 ID가 달라지는 연결은 신원 확인을 먼저 강화해야 한다.

## 산출물과 재현

- 알고리즘: `apps/web/public/fpa-cv/heatmap-reconstruction.mjs` (기존 제품에서 import하지 않음)
- 원본 리뷰 재집계: `scripts/fpa-cv-export-heatmap-experiment.mjs`
- 가림 실험: `scripts/fpa-cv-heatmap-reconstruction-experiment.mjs`
- 로컬 비교 화면: `scripts/fpa-cv-heatmap-reconstruction-preview.html`
- 서버: `scripts/preview-heatmap-reconstruction.mjs`
- 검증: `scripts/test-fpa-cv-heatmap-reconstruction.mjs`
- 수치 요약: `docs/heatmap-reconstruction-results-20260930.json`

```sh
node scripts/fpa-cv-export-heatmap-experiment.mjs /path/to/gwangju-input.json /tmp/heatmap-reconstruction/gwangju.json
node scripts/fpa-cv-export-heatmap-experiment.mjs /path/to/ulsan-input.json /tmp/heatmap-reconstruction/ulsan.json
node scripts/fpa-cv-heatmap-reconstruction-experiment.mjs /tmp/heatmap-reconstruction/gwangju.json /tmp/heatmap-reconstruction/ulsan.json /tmp/heatmap-reconstruction/results
node scripts/preview-heatmap-reconstruction.mjs /tmp/heatmap-reconstruction/results 4358
node scripts/test-fpa-cv-heatmap-reconstruction.mjs
node scripts/test-fpa-cv-heatmaps.mjs
```

비교 화면은 기존과 보강 지도를 같은 색 강도로 표시한다. 관측률/추정 비율/미복원 비율을 분리하고 경기·선수를 선택할 수 있다. 브라우저에서 2경기 전환, 선수 10명 선택, 캔버스 렌더, 콘솔 오류 없음 확인.

확률 밀도 후보의 참고 원리: Horne et al. (2007), [Analyzing animal movements using Brownian bridges](https://doi.org/10.1890/06-0957.1). 이 실험은 해당 논문의 풋살 성능 재현이나 모델 그대로의 구현이 아니라, 끝점 조건부 위치 분산 아이디어를 연결 후보에 적용한 비교다.
