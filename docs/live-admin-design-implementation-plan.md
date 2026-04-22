# FP Live Admin Design Implementation Plan

## 목적
이 문서는 [live-admin-design-principles.md](/Users/andy/Project/fp_live_analytics/live admin/docs/live-admin-design-principles.md)를 실제 코드에 적용하기 위한 구체 실행안이다.

대상 기준 파일:

- [globals.css](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/globals.css)
- [AdminShell.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/components/AdminShell.tsx)
- [dashboard/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/dashboard/page.tsx)
- [match/[id]/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/match/[id]/page.tsx)
- [media/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/media/page.tsx)
- [system/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/system/page.tsx)

---

## 1. 현재 상태 진단
지금 UI는 다음 특징을 가진다.

- 브랜드 톤은 분명하다.
- 전체가 같은 컴포넌트 계열로 정리돼 있어 기본 정돈감은 있다.
- 하지만 상태, 위험도, 기술 정보, 주요 행동의 시각적 차이가 아직 약하다.

현재 코드 기준 주요 문제:

1. 색 역할이 좁다.
거의 모든 강조가 오렌지 계열로 처리된다.

2. border 의존도가 높다.
카드, 버튼, pill, sidebar hover 모두 비슷한 선 문법을 사용한다.

3. 카드가 모두 같은 중요도로 보인다.
`card`, `metric-tile`, `match-item`이 톤 차이는 있지만 위계 차이가 크지 않다.

4. 버튼 의미가 덜 분리돼 있다.
`btn-primary`, `btn-active`, `btn-danger`, 기본 버튼의 역할 구분은 있으나
실전 사용 흐름에서 `primary / secondary / ghost / danger` 체계로 정리돼 있지는 않다.

5. 기술 정보용 보조 색이 없다.
HLS, gateway, protocol, stream meta도 오렌지-브라운 영역에 같이 묶인다.

---

## 2. Token 적용안
가장 먼저 [globals.css](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/globals.css)의 `:root` 토큰을 확장해야 한다.

### 2-1. Surface Tokens
현재:

- `--bg`
- `--bg-soft`
- `--panel`
- `--panel-strong`

권장 변경:

```css
--surface-base: #13100d;
--surface-rail: #1a1410;
--surface-workspace: rgba(23, 18, 14, 0.88);
--surface-card: rgba(28, 21, 16, 0.92);
--surface-card-strong: rgba(36, 27, 20, 0.96);
--surface-floating: rgba(42, 32, 24, 0.82);
```

적용 의도:

- sidebar/topbar는 `surface-rail`
- 페이지 기본 카드와 메인 패널은 `surface-card`
- hover/active/floating 상태는 `surface-card-strong` 또는 `surface-floating`

### 2-2. Border Tokens
현재:

- `--line`
- `--line-strong`

권장 변경:

```css
--border-soft: rgba(255, 145, 52, 0.08);
--border-ghost: rgba(255, 145, 52, 0.14);
--border-emphasis: rgba(255, 145, 52, 0.24);
--border-danger: rgba(255, 107, 107, 0.26);
--border-success: rgba(61, 220, 151, 0.24);
--border-tech: rgba(76, 214, 255, 0.22);
```

원칙:

- 기본 카드 구획에는 `border-soft` 혹은 border 없음
- 입력, 버튼, 포커스 가능 요소에만 `border-ghost`
- 상태 강조에 `border-success`, `border-danger`, `border-tech`

### 2-3. Text Tokens
현재:

- `--text`
- `--muted`

권장 변경:

```css
--text-primary: #efe5db;
--text-secondary: #cfb8a3;
--text-tertiary: #9f8771;
--text-tech: #8fd8f0;
```

### 2-4. Semantic Color Tokens
현재:

- `--accent`
- `--accent-strong`
- `--success`
- `--danger`

권장 변경:

```css
--brand: #ff7a13;
--brand-soft: rgba(255, 122, 19, 0.12);
--brand-glow: rgba(255, 122, 19, 0.26);

--success: #3ddc97;
--success-soft: rgba(61, 220, 151, 0.12);

--warning: #ffb14a;
--warning-soft: rgba(255, 177, 74, 0.12);

--danger: #ff6b6b;
--danger-soft: rgba(255, 107, 107, 0.12);

--tech: #4cd6ff;
--tech-soft: rgba(76, 214, 255, 0.12);
```

### 2-5. Radius Tokens
지금 radius 값이 여러 군데 분산돼 있다.
아래처럼 줄이는 것이 좋다.

```css
--radius-card: 24px;
--radius-panel: 18px;
--radius-control: 12px;
--radius-pill: 999px;
```

### 2-6. Shadow Tokens
현재 `--shadow` 하나만 사용 중이다.

권장 변경:

```css
--shadow-card: 0 18px 48px rgba(0, 0, 0, 0.22);
--shadow-floating: 0 24px 72px rgba(0, 0, 0, 0.28);
--shadow-none: none;
```

원칙:

- 일반 카드에는 그림자를 줄이거나 더 약하게
- hover/floating에만 그림자를 강하게

---

## 3. Component 규칙 적용안
### 3-1. Card 체계
현재 `.card` 하나로 대부분을 처리한다.
이를 역할별 modifier로 분리하는 것이 좋다.

권장 클래스:

```css
.card
.card-hero
.card-panel
.card-utility
.card-danger
```

적용 기준:

- `card-hero`: Dashboard overview, match header
- `card-panel`: 일반 작업 영역
- `card-utility`: calendar, guide, audit, 보조 정보
- `card-danger`: reset/delete/archive zone

### 3-2. Button 체계
현재:

- 기본 button
- `.btn-primary`
- `.btn-active`
- `.btn-danger`
- `.button-link`
- `.button-compact`

권장 재편:

```css
.btn
.btn-primary
.btn-secondary
.btn-ghost
.btn-danger
.btn-compact
```

해석:

- `.btn-primary`: 가장 자주 쓰는 즉시 행동
- `.btn-secondary`: 일반 조작
- `.btn-ghost`: 필터, 탭, 보조 링크
- `.btn-danger`: 삭제/중단/초기화

중요:

- `btn-active`는 "버튼 종류"보다 "선택된 상태" modifier로 바꾸는 편이 낫다.
- 예: `.is-selected`

### 3-3. Status Pill 체계
현재:

- `.status-pill`
- `.status-pill.running`
- `.status-pill.stopped`

권장 확장:

```css
.status-pill
.status-running
.status-stopped
.status-warning
.status-danger
.status-tech
.status-manual
.status-archived
```

적용 예:

- running/live stream: green
- hls pending/probe degraded: amber
- gateway detail / protocol / telemetry: cyan
- archived/manual: low emphasis neutral

### 3-4. Input 체계
현재 input/select가 기본 버튼과 같은 배경/선 문법을 가진다.

개선 방향:

- input/select는 버튼보다 한 단계 더 낮은 surface 사용
- focus 때만 brand 강조
- 설명 문장은 줄이고 라벨은 더 선명하게

### 3-5. List / Queue 체계
현재 match list는 `border-top dashed` 기반이다.

권장:

- divider를 약화하거나 gap 기반 리스트로 바꾸기
- hover 시 `surface shift`
- item 내부 구조를 `name -> state -> meta -> actions`로 고정

---

## 4. Screen별 적용안
### 4-1. Admin Shell
대상:
[AdminShell.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/components/AdminShell.tsx)

적용 포인트:

1. sidebar hover/active에 border보다 surface shift 중심 적용
2. `topbar-badge`는 세션 badge보다 role/status badge 성격 강화
3. sidebar legal은 시각적 존재감을 조금 낮추기

구체 변경:

- `.sidebar-nav a.active`에서 border 강조를 약하게
- active state는 `background + text contrast` 중심으로
- `.topbar-badge`는 더 compact 하게, 기술 상태용 작은 점 추가 가능

### 4-2. Dashboard
대상:
[dashboard/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/dashboard/page.tsx)

핵심 문제:

- hero와 form의 밀도 차이는 있지만 위계 차이는 아직 약함
- match list 액션들이 같은 무게로 보임

구체 적용:

1. overview 카드에 `card-hero` 도입
2. `metric-tile`을 일반 card보다 한 단계 낮은 surface로 정리
3. `Open`은 primary 또는 secondary 강조
4. `Export`는 ghost
5. `Archive`는 secondary
6. `Delete`는 danger
7. `mode / protocol / HLS`는 tech 색 활용

추가 권장:

- `match.metadata?.ingest_protocol`
- HLS ready / pending
- running 여부

이 3개는 단순 텍스트가 아니라 semantic pill로 바꾸는 것이 좋다.

### 4-3. Match Control
대상:
[match/[id]/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/match/[id]/page.tsx)

핵심 목표:

- 헤더에서 경기 상태를 즉시 파악
- 운영 제어와 분석 입력의 성격 분리

구체 적용:

1. 상단 헤더를 `card-hero`로
2. `Clock / Possession / Lock`은 control panel
3. `xG / xGOT`는 analysis panel
4. `Reset / Archive / Delete`는 `card-danger`
5. stream 정보는 `tech` tone으로 표시

중요:

- archived/read-only 상태는 일반 muted text가 아니라 상태 배지 + 별도 notice panel로 더 분명히 보여야 한다.

### 4-4. Media
대상:
[media/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/media/page.tsx)

핵심 목표:

- 기술 제어판처럼 보여야 함

구체 적용:

1. gateway 상태는 `running / degraded / offline`으로 시각 분리
2. HLS probe는 `status-tech`와 `status-warning` 혼합 체계로 표시
3. `Re-attach`는 secondary
4. `Stop Stream`은 danger
5. `Clear HLS`는 ghost 또는 secondary

추가:

- `server`, `stream key`, `hls url` 같은 기술 메타는 텍스트 색을 `--text-tech` 계열로 분리

### 4-5. System
대상:
[system/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/system/page.tsx)

핵심 목표:

- 판단 보조 화면으로서의 질서 확립

구체 적용:

1. `Unified Health`를 alerts 중심 패널로 강화
2. `Guide`, `Safety`, `Audit`는 `card-utility`
3. severity별 스타일 클래스 추가

예:

```css
.alert-high
.alert-medium
.alert-info
```

감사 로그는 row마다 `time / actor / action / target`이 더 쉽게 읽히도록 `log-row` 스타일 시스템 추가 권장

---

## 5. 우선순위별 수정 순서
### Phase 1: 전역 토큰 정리
대상:
[globals.css](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/globals.css)

할 일:

1. semantic color token 추가
2. surface token 분리
3. border/shape/shadow token 정리
4. button/status/card base class 재정의

이 단계만 해도 전체 완성도가 눈에 띄게 올라간다.

### Phase 2: Dashboard 정리
대상:
[dashboard/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/dashboard/page.tsx)

할 일:

1. hero/card 위계 강화
2. match queue 액션 무게 재배치
3. metadata semantic pill 도입

### Phase 3: Match Control 정리
대상:
[match/[id]/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/match/[id]/page.tsx)

할 일:

1. 섹션 구분 강화
2. danger zone 분리
3. archived/read-only 상태 강화

### Phase 4: Media/System 정리
대상:

- [media/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/media/page.tsx)
- [system/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/system/page.tsx)

할 일:

1. 기술 상태 색 분리
2. alerts/audit/log hierarchy 보강
3. 운영 판단용 UI로 다듬기

---

## 6. 최소 변경으로 가장 효과 큰 항목
바로 체감되는 개선만 추리면 아래 다섯 가지다.

1. `--tech` 색 추가 후 Media/System의 기술 메타에 적용
2. `.status-pill` semantic variant 확장
3. `.btn-active`를 선택 상태 modifier로 분리
4. `.card` 계열을 hero/panel/utility로 분리
5. Dashboard의 `Open / Export / Archive / Delete` 액션 무게 재조정

---

## 7. 권장 다음 작업
이 문서를 기준으로 실제 디자인 개선을 시작한다면, 가장 좋은 첫 작업은 아래다.

1. [globals.css](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/globals.css) 토큰 리팩터링
2. [dashboard/page.tsx](/Users/andy/Project/fp_live_analytics/live admin/apps/web/app/admin/dashboard/page.tsx)만 먼저 새 규칙으로 적용
3. 충분히 마음에 들면 나머지 화면에 확장

즉, 다음 구현 턴에서는 **"전역 토큰 + Dashboard 1차 적용"** 이 가장 효율이 좋다.
