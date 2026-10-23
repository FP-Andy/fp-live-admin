// xFP 직선 씬모션 게이지 — 로직 코어 (화면과 무관한 순수 함수)
//
//   const model = buildGauge(clip);      // 콘솔 클립 결과(actions[]) → 장면 모델. 클립당 한 번
//   const frame = frameAt(model, t);     // 영상 시각 t(초) → 그 순간 게이지에 그릴 것 전부
//
// 좌표: 막대(가로 676 × 세로 84) 기준 px. 막대 가운데 줄 y = 42. 렌더러가 실제 크기에 맞게 늘리면 됨.
// frame 은 이미 움직임 반전까지 끝난 좌표라서(골대는 늘 오른쪽) 렌더러는 받은 대로만 그리면 된다.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XfpGauge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- 상수
  const W = 676, H = 84, Y = 42;          // 막대 크기, 가운데 줄
  const INSET = 34;                        // 에셋은 막대 양끝 34px 안쪽에서만
  const GK_PX = W - 22;                    // 골키퍼 자리(골대 입구)
  const NET = W + 17;                      // 골대 한가운데(막대 오른쪽 밖)
  const PROB_K = 50;                       // 확률 → 막대 길이 로그 눈금 log(1+50p)/log(51)
  const BASE_P = 0.03;                     // 슈팅 없는 공격·값 없는 수비의 출발 확률
  const MIN_GAP = 0.11;                    // 플레이 사이 최소 간격(선수 겹침 방지)
  const RUN_GAP = 0.18;                    // 침투 선수가 공보다 앞서 달리는 거리
  const GOAL_DELAY = 0.6, SHOT_MOVE = 0.8, MOVE_MAX = 3, HOLD = 0.3, THREAT_RISE = 1.5, DRAIN = 0.8;

  const DEF = new Set(['Intercept', 'Clear', 'Cutout', 'Tackle', 'Block', 'Save', 'Interception', 'Clearance', 'Defense', 'Duel', 'Press']);
  const HOLD_ACT = new Set(['Tackle', 'Intercept', 'Interception', 'Duel']);  // 우리가 공을 가짐 (압박은 아님)
  const RENAME = {'세이브': '선방', '컷아웃': '패스 차단'};

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const easeIO = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const easeO = (u) => 1 - Math.pow(1 - u, 3);
  const easeIn = (u) => u * u * u;
  const X = (u) => INSET + clamp(u, 0, 1) * (W - INSET * 2);
  const Lp = (p) => Math.log(1 + PROB_K * clamp(p, 0, 1)) / Math.log(1 + PROB_K);
  const label = (a) => RENAME[a.actionLabel] || a.actionLabel;
  // 진행 중 제목: 결과를 미리 말하지 않음(어시스트·키패스 → 패스, 골·유효·막힌 슈팅 → 슈팅)
  const liveLabel = (a) => (a.baseAction === 'Pass' ? '패스' : a.baseAction === 'Shot' ? '슈팅' : label(a));

  // ---------- 수비 모델
  // 공 결과: hold = 우리가 가짐 / out = 밖으로 사라짐 / loose = 근처로 흘러 다음 우리 수비가 이어받음
  // 걷어내는 액션(클리어·컷아웃·블록·펀칭)은 마지막이면 out, 뒤에 우리 수비가 이어지면 loose
  function defModel(G, recovery) {
    const g0 = G[0], a0 = g0.main, A0 = a0.baseAction;
    const D = {G, recovery};
    // 압박(Press): 상대 위협을 깎는 수비(공은 안 뺏음). 상대가 공을 몰고 오는 걸(dribble) 둘러쌈
    D.press = A0 === 'Press';
    D.approach = D.press ? 'dribble'
      : A0 === 'Save' || (A0 === 'Block' && a0.xg != null) ? 'shot'
      : A0 === 'Tackle' ? 'dribble'
      : ['Intercept', 'Interception', 'Cutout'].includes(A0) ? 'pass' : 'loose';
    const threat = A0 === 'Save' ? (a0.xgot || a0.xg) : A0 === 'Block' ? a0.xg : null;
    D.save = A0 === 'Save';
    // 상대 득점 확률(골 확률 subtext용, 막대 높이와 별개): 막은 슈팅 xG(선방은 xGOT), 그 밖은 막아 낸 EPV, 없으면 기본값
    D.P = threat != null ? threat : a0.epv > 0 ? a0.epv : BASE_P;
    // 수비 막대 높이 = 모멘텀 = 막은 지점의 우리 골 근접도(stopThreat, 0~1 선형 위치. 1=골라인 앞, 0=먼 중원).
    // 실데이터는 _defense_turnover_value 의 theirs(끊은 지점 상대 EPV)/정규화 위치에서 올 값. 없으면(구데이터) 기존 로직 폴백
    D.level = a0.stopThreat != null ? clamp(a0.stopThreat, 0, 1)
      : D.save ? 0.96 : threat != null ? clamp(0.5 + threat * 2.5, 0.55, 0.88) : 0.65;
    D.tD = g0.s + clamp((g0.e - g0.s) * 0.3, 1.0, THREAT_RISE);  // 상대 접근은 최소 1초
    // 압박 잔여 위협(부분 drain): 압박이 셀수록(xfpScore↑) 더 깎여 잔여↓. 뒤에 공 획득 액션이 이어지면 0까지(winT)
    D.residual = D.press ? clamp(0.5 - (a0.xfpScore || 50) / 100 * 0.4, 0.15, 0.5) : 0;
    G.forEach((g, i) => {
      const A = g.main.baseAction, last = i === G.length - 1, punch = /Punch/.test(g.main.tags || '');
      const hold = HOLD_ACT.has(A) || (A === 'Save' && !punch), isP = A === 'Press';
      g.out = isP ? 'loose' : hold ? 'hold' : last ? (recovery ? 'hold' : 'out') : 'loose';  // 압박은 공 유지(loose)
      g.tAct = i === 0 ? D.tD : g.s + 0.5;
    });
    D.winT = D.press && G.length > 1 ? G[1].tAct : null;  // 압박 뒤 획득: 그때부터 0까지 이어서 drain
    D.endT = G[G.length - 1].tAct + 0.7;
    if (D.press) D.endT = Math.max(D.endT, (D.winT != null ? D.winT : D.tD) + DRAIN + 0.2);
    return D;
  }

  // ---------- 클립 → 모델
  // clip = {dur, actions:[{seq, action, baseAction, actionLabel, jersey, receiver, xfpScore, xg, xgot, epv,
  //          startOffset, endOffset, groupIndex, isGroupMain, tags}]}
  function buildGauge(clip) {
    // away 클립도 살리기: 액션 teamSide 다수결로 team 결정(없으면 clip.team||'home'). clip.team 직접 사용 금지
    const sideCount = {};
    for (const a of clip.actions) { const s = a.teamSide; if (s) sideCount[s] = (sideCount[s] || 0) + 1; }
    const team = Object.keys(sideCount).sort((x, y) => sideCount[y] - sideCount[x])[0] || clip.team || 'home';
    const acts0 = clip.actions.filter((a) => (a.teamSide || team) === team);
    const by = new Map();
    for (const a of acts0) { if (!by.has(a.groupIndex)) by.set(a.groupIndex, []); by.get(a.groupIndex).push(a); }
    const all = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, acts]) => {
      const main = acts.find((a) => a.isGroupMain) || acts[0];
      const s = Math.min(...acts.map((a) => a.startOffset)), e = Math.max(...acts.map((a) => a.endOffset));
      const isShot = acts.some((a) => a.baseAction === 'Shot'), isDef = DEF.has(main.baseAction);
      // 실패 액션(비슈팅): tags 에 Fail. 슈팅 실패는 기존 miss/blocked 가 담당하므로 제외
      const fail = !isShot && /Fail/.test(main.tags || '');
      // 크로스는 패스와 똑같이 그리고 제목만 '크로스'
      const type = isShot ? 'shot' : ['Pass', 'Cross'].includes(main.baseAction) ? 'pass' : isDef ? 'carry' : 'dribble';
      const runners = acts.filter((a) => a !== main && a.baseAction === 'Penetration');
      return {acts, main, s, e, isShot, isDef, fail, type, runners, move: isShot ? SHOT_MOVE : Math.min(MOVE_MAX, e - s)};
    });
    // 빈 모델 가드(퇴화 입력: 살아남은 액션 없음) → 크래시 대신 안전 반환
    if (!all.length) return {dur: clip.dur, all: [], G: [], best: null, lead: 0, kind: 'attack', empty: true, result: ''};
    const best = acts0.reduce((b, a) => ((a.xfpScore || 0) > (b.xfpScore || 0) ? a : b), acts0[0]);
    const M = {dur: clip.dur, all, best, lead: 0};
    if (!all.some((g) => !g.isDef)) {
      const D = defModel(all, false), a0 = all[0].main;
      return Object.assign(M, {kind: 'defense', def: D, G: all, endT: D.endT, praise: true,
        result: a0.baseAction === 'Save' ? '선방 성공' : `${label(a0)} 성공`});
    }
    // 공격. 수비로 시작하면 앞 수비 부분(recovery)은 움직임만 좌우 반전한 수비로 그림(골대·필드는 그대로)
    let lead = 0; while (lead < all.length && all[lead].isDef && !all[lead].isShot) lead++;
    const G = all.slice(lead);
    const shotG = [...G].reverse().find((g) => g.isShot), shot = shotG && shotG.acts.find((a) => a.baseAction === 'Shot');
    const goal = !!(shot && shot.action === 'Goal');
    const blocked = !!(shot && !goal && (shot.action === 'Blocked Shot' || /Blocked/.test(shot.tags || '')));
    const miss = !!(shot && !goal && !blocked && /Off Target|Fail/.test(shot.tags || ''));
    const onT = !!(shot && !goal && !blocked && !miss);
    // 통합 득점 확률 P: 플레이마다 EPV 변화만큼 → 슈팅 순간 xG → 날아가는 동안 xGOT → 골 100%
    // 콘솔 EPV는 변화량뿐이라 출발점 = 슈팅 xG − 앞 플레이 EPV 합(슈팅 없으면 BASE_P)
    const ep = (g) => (g.main.epv != null ? g.main.epv : 0), nonShot = G.filter((g) => !g.isShot);
    let p = Math.max(0.005, shot && shot.xg != null ? shot.xg - nonShot.reduce((a, g) => a + ep(g), 0) : BASE_P);
    let u = Lp(p);
    G.forEach((g) => {
      g.pa = p; g.a = u;
      if (!g.isShot) { p = Math.max(0.001, p + ep(g)); u = Math.max(u + MIN_GAP, Lp(p)); g.pb = p; g.b = u; return; }
      const xg = shot.xg != null ? shot.xg : p, xgot = shot.xgot != null ? shot.xgot : 0;
      g.pa = xg; g.pxgot = Math.max(xg, xgot); g.pb = goal ? 1 : onT ? g.pxgot : xg;
      g.ux = Math.max(u + 0.04, Lp(g.pxgot)); g.b = goal ? 1 : onT ? g.ux : u;
    });
    // 슈팅 자리가 모자라면 앞부분을 줄임
    const mx = Math.max(0, ...nonShot.map((g) => g.b)), lim = shot ? 0.8 : 0.95;
    if (mx > lim) {
      const sc = lim / mx;
      G.forEach((g) => { g.a *= sc; if (!g.isShot) g.b *= sc; else { g.ux = Math.max(g.a + 0.04, g.ux); if (!goal) g.b = onT ? g.ux : g.a; } });
    }
    if (lead) {
      // 수비 후 공격(recovery): 영상대로 공 획득(=공격 출발점)을 막대 중앙(미드필드 전환점)에 두도록
      // 공격 전체를 오른쪽으로 민다. 확률 숫자는 그대로, 공간 위치만 중앙에서 출발하게.
      // 오른쪽 한계(슛 0.8 / 그 외 0.95)는 넘지 않는 선에서만 민다.
      const limR = shot ? 0.8 : 0.95;
      const maxB = Math.max(...G.map((g) => (g.b != null ? g.b : g.a)));
      const shift = clamp(0.5 - G[0].a, 0, Math.max(0, limR - maxB));
      if (shift > 0) G.forEach((g) => { g.a += shift; if (g.b != null) g.b += shift; if (g.ux != null) g.ux += shift; });
      M.rec = defModel(all.slice(0, lead), true); M.lead = lead;
      M.rec.level = clamp(1 - G[0].a, 0.3, 0.92);  // 반전 후 수비 선수 자리 = 공격 출발점(이제 중앙)
      M.attackFrom = Math.max(G[0].s, M.rec.G[lead - 1].tAct + 0.6);
      G[0].s0 = M.attackFrom;
    }
    G.forEach((g) => { if (g.s0 == null) g.s0 = g.s; });
    const endT = Math.max(...G.map((g) => g.s0 + g.move)) + (goal ? GOAL_DELAY : 0);
    const lastG = G[G.length - 1];
    return Object.assign(M, {kind: 'attack', G, goal, blocked, miss, onT, endT, praise: goal,
      result: goal ? '득점 성공' : onT ? '유효 슈팅' : blocked ? '슈팅 막힘' : miss ? '슈팅'
        : lastG.fail ? `${label(lastG.main)} 실패` : `${label(lastG.main)} 성공`});
  }

  // ---------- 그릴 것(items)
  // home  {x, jersey, role: main|normal|ghost|runner|best, opacity, scale, dx}  우리 선수(주황 육각, 안 숫자 = 등번호)
  // away  {x, role: lead|normal|beat, opacity}                                  상대(파란 원)
  // ball  {x, y, opacity}
  // trail {x1, x2, kind: dribble|penetrate, past, opacity}                        꽉 찬/빈 화살표 발자취(타일 반복)
  // line  {x1, y1, x2, y2, color: green|blue, dashed, head, opacity}              패스선·슈팅 궤적
  // tag   {x, text}                                                              '도움'
  // bestSeg {x1, x2, sweep, opacity}                                             최고 플레이 칸 금빛
  const home = (x, jersey, role, o = {}) => ({type: 'home', x, jersey: jersey == null ? '' : String(jersey), role, opacity: 1, scale: 1, dx: 0, ...o});
  const away = (x, role, opacity = 1) => ({type: 'away', x, role, opacity});
  const ball = (x, y = Y, opacity = 1, grey = false) => ({type: 'ball', x, y, opacity, ...(grey ? {grey: true} : {})});
  const trail = (kind, x1, x2, o = {}) => (x2 - x1 < 8 ? null : {type: 'trail', kind, x1, x2, past: false, opacity: 1, ...o});
  const line = (x1, y1, x2, y2, o = {}) => ({type: 'line', x1, y1, x2, y2, color: 'green', dashed: false, head: false, opacity: 1, ...o});

  function attackFrame(M, t) {
    const G = M.G, items = [];
    let k = 0; G.forEach((g, i) => { if (t >= g.s0) k = i; });
    const g = G[k], f = clamp((t - g.s0) / Math.max(0.05, g.move), 0, 1), ef = g.isShot ? f : easeIO(f);
    const ramp = k !== 0 ? 1 : M.lead ? easeO(clamp((t - g.s0) / 0.5, 0, 1)) : t < g.s0 ? easeO(clamp((t - (g.s0 - 0.3)) / 0.5, 0, 1)) : 1;
    const front = (g.a + (g.b - g.a) * ef) * ramp;
    let bl = null, fillPx = null, toneOv = null, Pov = null;
    // 지난 장면 선수: 마지막 자리에 흐리게
    const ghost = new Map();
    G.slice(0, k).forEach((p) => { if (p.type === 'pass') { ghost.set(p.main.jersey, p.a); if (p.main.receiver) ghost.set(p.main.receiver, p.b); } else ghost.set(p.main.jersey, p.b); });
    const active = new Set([g.main.jersey, g.main.receiver, ...g.runners.map((r) => r.jersey)].filter(Boolean));
    ghost.forEach((u, j) => { if (!active.has(j)) items.push(home(X(u), j, 'ghost', {opacity: 0.4})); });
    // '도움'은 골이 들어간 뒤에만
    if (M.goal && t >= M.endT - GOAL_DELAY) G.forEach((p) => p.acts.forEach((a) => { if (a.action === 'Assist') items.push({type: 'tag', x: X(p.a) + 18, text: '도움'}); }));
    // 지난 발자취(흐리게)
    G.slice(0, k).forEach((p) => {
      if (p.type === 'dribble') items.push(trail('dribble', X(p.a), X(p.b) - 30, {past: true, opacity: 0.3}));
      else if (p.type === 'pass') items.push(line(X(p.a), Y, X(p.b), Y, {head: true, opacity: 0.35}));
      if (p.runners.length) items.push(trail('penetrate', X(Math.min(0.96, p.a + RUN_GAP)) - 30, X(Math.min(0.96, p.b + RUN_GAP)) - 30, {past: true, opacity: 0.3}));
    });
    // 지금 플레이
    if (g.fail) {
      // 실패 액션: 정상 그림을 중간(cut)에서 끊고, 소유 상실 → 회색 톤 + drain, 공은 회색으로 흘러 사라짐
      const cut = 0.45, upeak = Math.min(0.96, g.a + 0.12);
      const prog = f < cut ? easeIO(f / cut) : 1, upos = g.a + (upeak - g.a) * prog;
      const r = f < cut ? 0 : (f - cut) / (1 - cut), eo = easeO(r);
      if (g.type === 'pass') {  // 초록선이 리시버 앞에서 끊김(머리 없음), 소유 상실하며 흐려짐
        items.push(home(X(g.a), g.main.jersey, 'main'));
        items.push(line(X(g.a), Y, X(upos), Y, {head: false, opacity: 1 - eo}));
      } else {  // 드리블 발자취가 중단
        if (g.type === 'dribble') items.push(trail('dribble', X(g.a), X(upos) - 30, {opacity: 1 - 0.5 * eo}));
        items.push(home(X(upos), g.main.jersey, 'main'));
      }
      const bb = g.type === 'pass' ? upos : Math.min(1, upos + 0.045);
      const bx = f < cut ? X(bb) : X(g.type === 'pass' ? upeak : Math.min(1, upeak + 0.045)) + 60 * eo;
      bl = ball(bx, Y, 1 - eo, f >= cut);  // cut 뒤 회색으로 흘러 사라짐
      fillPx = f < cut ? X(upos) : X(upeak) * (1 - eo);
      toneOv = f < cut ? null : 'miss';   // 끊긴 뒤 회색
      Pov = g.pa * (1 - eo) * ramp;       // 소유 상실 → drain
    } else if (g.type === 'pass') {
      items.push(home(X(g.a), g.main.jersey, 'main'));
      if (g.main.receiver) items.push(home(X(g.b), g.main.receiver, 'normal'));
      items.push(line(X(g.a), Y, X(front), Y, {head: f >= 0.98}));
    } else if (g.type === 'shot') {
      items.push(home(X(g.a), g.main.jersey, 'main'));
      const x0 = X(g.a) + 30;
      if (M.goal) {
        const bx = x0 + (NET - x0) * f; bl = ball(bx); fillPx = X(g.a + (g.ux - g.a) * f);
        items.push(line(x0, Y, bx, Y, {dashed: true}));
      } else if (M.onT) {  // 골대 앞 상대 골키퍼에 막힘
        const bx = x0 + (GK_PX - 30 - x0) * f;
        items.push(away(GK_PX, 'lead')); bl = ball(bx); fillPx = X(g.a + (g.b - g.a) * f);
        items.push(line(x0, Y, bx, Y, {dashed: true}));
      } else if (M.blocked) {  // 상대 수비에 맞고 튕겨 사라짐
        const bp = x0 + (X(1) - x0) * 0.55, hit = 0.55, r = (f - hit) / (1 - hit);
        const bx = f < hit ? x0 + (bp - 28 - x0) * (f / hit) : bp - 28 - 70 * easeO(r);
        items.push(away(bp, 'lead'));
        bl = ball(bx, f < hit ? Y : Y - 30 * easeO(r), f < hit ? 1 : 1 - r);
        fillPx = Math.min(bp - 28, x0 + (bp - 28 - x0) * Math.min(1, f / hit));
        items.push(line(x0, Y, fillPx, Y, {dashed: true}));
      } else {  // 빗나감: 골대 위로 비켜 사라짐
        const bx = x0 + (W + 46 - x0) * f, by = Y - 52 * easeIn(f);
        bl = ball(bx, by, 1 - clamp((f - 0.7) / 0.3, 0, 1));
        items.push(line(x0, Y, bx, by, {dashed: true}));
      }
    } else {
      if (g.type === 'dribble') items.push(trail('dribble', X(g.a), X(front) - 30));
      items.push(home(X(front), g.main.jersey, 'main'));
    }
    // 침투: 한 자리에 겹쳐 함께 달림. 맨 위 = 공 받는 선수(없으면 xFP 최고). 공 주인이 정해지면 나머지는 사라짐
    if (g.runners.length) {
      const nx = G[k + 1];
      const got = (r) => !!((nx && (nx.main.jersey === r.jersey || nx.main.receiver === r.jersey)) || g.main.receiver === r.jersey);
      const order = [...g.runners].sort((p, q) => (got(p) - got(q)) || ((p.xfpScore || 0) - (q.xfpScore || 0)));
      const r0 = Math.min(0.96, g.a + RUN_GAP), ru = Math.min(0.96, front + RUN_GAP);
      const out = 1 - clamp((t - (g.s0 + g.move)) / 0.4, 0, 1), tf = g.runners.some(got) ? 1 : out;
      if (tf > 0) items.push(trail('penetrate', X(r0) - 30, X(ru) - 30, {opacity: tf}));
      order.forEach((r, i) => {
        const fade = got(r) ? 1 : out;
        if (fade > 0) items.push(home(X(ru), i === order.length - 1 ? r.jersey : '', 'runner', {opacity: fade, dx: -(order.length - 1 - i) * 13}));
      });
    }
    items.push(bl || ball(X(g.type === 'dribble' || g.type === 'carry' ? Math.min(1, front + 0.045) : front)));
    // 막대
    const done = M.goal && t >= M.endT, ended = t >= M.endT + HOLD;
    const fill = done ? {from: 'left', width: W, tone: 'done'}
      : {from: 'left', width: fillPx != null ? fillPx : front >= 0.999 ? W : X(front), tone: toneOv || ((M.miss || M.blocked) && ended ? 'miss' : 'attack')};
    // 확률
    let P;
    if (Pov != null) P = Pov;
    else if (!g.isShot) P = (g.pa + (g.pb - g.pa) * ef) * ramp;
    else if (M.goal) P = t < M.endT ? g.pa + (g.pxgot - g.pa) * f : g.pxgot + (1 - g.pxgot) * easeO(clamp((t - M.endT) / 0.5, 0, 1));
    else if (M.onT) P = g.pa + (g.pb - g.pa) * f;
    else P = g.pa;
    // +N 팝업: 칸이 다 찬 순간부터 1초. 실패 액션은 득점 기여 없음 → 제외
    const ups = G.filter((q) => !q.isShot && !q.fail).map((q) => ({t: q.s0 + q.move, x: X(q.b), n: (q.pb - q.pa) * 100}));
    const sg = G[G.length - 1];
    if (sg.isShot && (M.goal || M.onT)) ups.push({t: sg.s0 + sg.move, x: X(Math.min(0.8, sg.ux)), n: (sg.pxgot - sg.pa) * 100});
    if (M.goal) ups.push({t: M.endT, x: X(0.8), n: (1 - sg.pxgot) * 100});
    const pops = ups.filter((q) => t >= q.t && t < q.t + 1 && q.n >= 0.05).map((q) => ({x: q.x - 20, value: q.n, age: t - q.t}));
    return {k, g, items: items.filter(Boolean), fill, ended, pre: false, P, pops, tone: 'attack'};
  }

  function defenseFrame(D, t) {
    const G = D.G, g0 = G[0], L = D.level, a0 = g0.main, items = [];
    let k = 0; G.forEach((g, i) => { if (t >= g.s) k = i; });
    const s0 = Math.max(0.06, L - 0.32);  // 상대 공격 시작 자리
    if (t < D.tD) {  // 상대가 다가옴
      const p = easeIO(clamp((t - g0.s) / Math.max(0.3, D.tD - g0.s), 0, 1));
      let bu;
      if (D.approach === 'shot') { bu = s0 + 0.04 + ((D.save ? 1 : L) - s0 - 0.04) * p; items.push(away(X(s0), 'lead'), line(X(s0) + 26, Y, X(bu), Y, {color: 'blue', dashed: true})); }
      else if (D.approach === 'dribble') { bu = s0 + (L - 0.03 - s0) * p; items.push(away(X(bu - 0.05), 'lead')); }
      else if (D.approach === 'pass') { bu = s0 + 0.04 + (L - s0 - 0.04) * p; items.push(away(X(s0), 'lead'), away(X(Math.min(0.95, L + 0.15)), 'normal'), line(X(s0) + 26, Y, X(bu), Y, {color: 'blue'})); }
      else { bu = s0 + (L - s0) * p; items.push(away(X(s0), 'normal')); }
      if (D.save || (!D.press && t > D.tD - 0.45)) items.push(home(D.save ? GK_PX : X(L), a0.jersey, 'normal'));  // 골키퍼는 처음부터 골대 앞(압박은 tD에 수렴 시작)
      items.push(ball(X(bu)));
      return {k: 0, g: g0, items, fill: {from: 'left', width: X(bu), tone: 'threat'}, ended: false, pre: true, P: D.P * p, pops: [], tone: 'opponent'};
    }
    // 드레인 레벨(막대·확률 공통). 압박은 잔여까지만 깎고(부분), 뒤에 획득(winT)이 이어지면 0까지
    let level;
    if (D.press) {
      const f1 = easeO(clamp((t - D.tD) / DRAIN, 0, 1));
      level = 1 - f1 * (1 - D.residual);
      if (D.winT != null) level *= 1 - easeO(clamp((t - D.winT) / DRAIN, 0, 1));
    } else {
      level = 1 - easeO(clamp((t - D.tD) / DRAIN, 0, 1));
    }
    // 압박 수렴: 공은 상대가 유지, 주황 육각 여러 명(2~3)이 압박 지점으로 모이며 위협이 부분 drain
    if (D.press && k === 0) {
      const pc = easeO(clamp((t - D.tD) / 0.6, 0, 1)), Lx = Math.min(0.95, L);
      items.push(away(X(Lx), 'lead', 0.9));  // 상대는 공을 가진 채 남음(안 뺏음)
      const offs = [[-0.22, -15], [0.18, 15], [-0.12, 0]], n = Math.min(3, g0.acts.length >= 2 ? g0.acts.length : 3);
      for (let i = 0; i < n; i++) {
        const sx = clamp(L + offs[i][0], 0.04, 0.96), x = sx + (L - sx) * pc;
        items.push(home(X(x), i === 0 ? a0.jersey : '', i === 0 ? 'main' : 'normal', {dx: offs[i][1] * pc}));
      }
      items.push(ball(X(Lx) + 20, Y, 0.95));  // 공은 상대 발 앞(전진하던 쪽)
      const fw = level <= 0.0005 ? 0 : X(L * level);
      return {k: 0, g: g0, items, fill: {from: 'left', width: fw, tone: 'drain'}, ended: !D.recovery && t >= D.endT + HOLD,
        pre: false, P: D.P * level, pops: [], tone: 'opponent'};
    }
    const fadeOpp = clamp(1 - (t - D.tD) / 0.8, 0, 1);  // 막힌 상대는 흐려졌다 사라짐
    if (!D.press && fadeOpp > 0) items.push(away(X(Math.min(0.95, D.approach === 'pass' ? L + 0.15 : L + 0.06)), 'beat', 0.3 * fadeOpp));
    // 수비 액션을 차례로 따라가며 공 자리를 정함. 지금 액션 선수만 보임
    let spot = L, b = {x: (D.save ? GK_PX : X(L)) + 26, opacity: 1}, gone = false;
    G.forEach((g, i) => {
      if (i > k) return;
      const here = i === 0 ? L : spot, on = t >= g.tAct, e = clamp((t - g.tAct) / 0.6, 0, 1);
      if (i === k) items.push(home(i === 0 && D.save ? GK_PX : X(here), g.main.jersey, 'main'));
      if (gone) return;
      const hx0 = i === 0 && D.save ? GK_PX : X(here);
      if (!on) { b = {x: hx0 - 30, opacity: 1}; return; }
      if (g.out === 'hold') { b = {x: hx0 - 34, opacity: 1}; spot = here; }  // 우리 소유: 공은 말 앞(상대가 오던 쪽)
      else if (g.out === 'loose') { const to = Math.max(0.08, here - 0.14); spot = to; b = {x: hx0 + (X(to) - hx0) * easeO(e), opacity: 1}; }
      else { const from = hx0 - 26, to = -60; b = {x: from + (to - from) * easeIn(e), opacity: 1 - e}; if (e >= 1) gone = true; }
    });
    if (!gone && b.opacity > 0.02) items.push(ball(b.x, Y, b.opacity));
    // 수비 후 공격(recovery): 공 획득 순간 주황 글로우 링이 획득 선수(막대 중앙) 뒤에서 펄스 후 사라짐(영상).
    if (D.recovery) {
      const gl = clamp(1 - (t - D.tD) / 1.0, 0, 1);
      if (gl > 0.02) items.unshift({type: 'glow', x: X(D.level), opacity: gl, scale: 1.0 + 0.5 * (1 - gl)});
    }
    let fillW, P;
    if (D.press) { fillW = level <= 0.0005 ? 0 : X(L * level); P = D.P * level; }  // 압박 후 획득 단계: 잔여→0 이어서 drain
    else { const d = clamp((t - D.tD) / DRAIN, 0, 1); fillW = d >= 1 ? 0 : X(L * (1 - easeO(d))); P = d >= 1 ? 0 : D.P * (1 - easeO(d)); }
    return {k, g: G[k], items, fill: {from: 'left', width: fillW, tone: 'drain'}, ended: !D.recovery && t >= D.endT + HOLD,
      pre: false, P, pops: [], tone: 'opponent'};
  }

  // 수비로 시작하는 공격의 수비 부분: 움직임만 좌우 반전(상대가 오른쪽에서 왼쪽으로). 골대·필드는 그대로: x → W − x
  function mirrorFrame(r) {
    const mx = (x) => W - x;
    r.items = r.items.map((it) => {
      const o = {...it};
      if ('x' in o) o.x = mx(o.x);
      if (o.type === 'trail') { const a = mx(it.x2), b = mx(it.x1); o.x1 = a; o.x2 = b; o.dir = -1; }
      if (o.type === 'line') { o.x1 = mx(it.x1); o.x2 = mx(it.x2); }
      if (o.type === 'home') o.dx = -o.dx;
      return o;
    });
    r.fill = {...r.fill, from: 'right'};
    r.pops = r.pops.map((p) => ({...p, x: mx(p.x)}));
    return r;
  }

  // ---------- 한 순간의 게이지
  // 반환: {opacity, phase, mirror, cut, accent, title, titleTone, player, probability, probabilityTone, fill, goal, items, pops, stamp}
  function frameAt(M, t) {
    // 빈 모델 가드: 그릴 게 없으면 크래시 말고 투명한 빈 frame 반환
    if (M.empty || !M.all.length) {
      return {opacity: 0, phase: 'attack', mirror: false, cut: 0, accent: 'orange', title: '', titleTone: 'normal',
        player: null, probability: 0, probabilityTone: 'white', fill: {from: 'left', width: 0, tone: 'attack'},
        goal: {side: 'right', state: 'normal'}, items: [], pops: [], stamp: {opacity: 0, scale: 1}};
    }
    const opacity = clamp((t - Math.max(0, M.all[0].s - 0.3)) / 0.25, 0, 1) * clamp((M.dur - 0.05 - t) / 0.3, 0, 1);
    let r, phase;
    if (M.kind === 'defense') { r = defenseFrame(M.def, t); phase = 'defense'; }
    else if (M.rec && t < M.attackFrom) { r = mirrorFrame(defenseFrame(M.rec, t)); phase = 'recovery'; }
    else { r = attackFrame(M, t); r.k += M.lead; phase = 'attack'; }
    const mirror = phase === 'recovery';
    // 수비 후 공격(recovery): 영상대로 — fill 은 주황·왼쪽에서(상대 위협 바를 우리 색으로),
    // 득점확률은 흰색, 카드는 "상대 공격" 접근 구간만 파랑·획득부터 주황.
    if (phase === 'recovery') r.fill = {...r.fill, from: 'left', tone: 'attack'};
    // 끝: 최고 플레이 칸 금빛 + 그 선수 육각 튐
    if (r.ended && M.kind === 'attack') {
      const e = t - (M.endT + HOLD), p = M.G.find((g) => g.acts.includes(M.best));
      if (p) {
        const pop = clamp(e / 0.35, 0, 1), u = p.type === 'pass' || p.type === 'shot' ? p.a : p.b;
        r.items.push({type: 'bestSeg', x1: X(p.a), x2: X(p.a) + Math.max(10, X(p.b) - X(p.a)), sweep: clamp(e / 0.7, 0, 1), opacity: clamp(e / 0.15, 0, 1)});
        r.items.push(home(X(u), M.best.jersey, 'best', {scale: pop < 1 ? 0.6 + 0.7 * easeO(pop) - 0.3 * pop * pop : 1}));
      }
    }
    // 제목·선수 점수(숫자는 한 번에 하나)
    let title, player = null;
    if (r.ended) {
      // 끝 점수: 마지막 액션 선수가 이 장면 최고 점수 선수면 그 점수 유지, 아니면 최고 선수로
      const last = r.g.main, keep = last.jersey === M.best.jersey && last.xfpScore != null, e = keep ? last : M.best;
      // 끝 제목 = 보여지는 선수(e)의 액션으로 맞춤(player와 같은 액션을 가리키게).
      // 단 슈팅 결과 헤드라인(득점·유효·막힘·빗나감)은 장면의 슛 결과라 그대로 둔다.
      // 접미사(성공/실패)는 'e의 실제 결과' 기준. 장면은 실패로 끝났어도 e가 성공이면 중립 라벨(실패 안 붙임)
      const shotHeadline = !!(M.goal || M.onT || M.blocked || M.miss);
      const eGroup = (M.G || []).find((q) => q.main === e || q.acts.includes(e));
      const eFail = eGroup ? !!eGroup.fail : !!r.g.fail;
      title = shotHeadline ? M.result
        : eFail ? `${label(e)} 실패`
        : M.kind === 'attack' && r.g.fail ? label(e)
        : `${label(e)} 성공`;
      player = e.xfpScore != null ? {jersey: String(e.jersey), score: e.xfpScore, gold: true} : null;
    } else if (r.pre) { title = '상대 공격'; }
    else {
      const a = r.g.main;
      // 실패 비(非)슛 액션은 재생 구간 제목에도 '실패'를 붙임(슛은 자체 결과 워딩 있어 제외, 수비 제외)
      title = M.kind === 'attack' && r.g.fail && !r.g.isShot ? `${liveLabel(a)} 실패` : liveLabel(a);
      player = {jersey: String(a.jersey), score: a.xfpScore != null ? a.xfpScore : null, gold: a.xfpScore >= 95};
    }
    const P = clamp(r.P || 0, 0, 1);
    const sf = M.praise && t >= M.endT ? t - M.endT : -1;
    const stamp = sf < 0 ? {opacity: 0, scale: 1} : {opacity: clamp(sf / (0.22 * 0.6), 0, 1), scale: sf < 0.22 ? 2.2 - 1.32 * easeIn(sf / 0.22) : 0.88 + 0.12 * easeO(clamp((sf - 0.22) / 0.2, 0, 1))};
    // 골대는 늘 오른쪽(필드는 뒤집지 않음). 수비만 있는 장면 = 우리 골(파랑), 수비로 시작하는 공격 = 우리가 노릴 상대 골(흰색)
    const goalState = phase === 'defense' ? 'own' : M.goal && t >= M.endT - GOAL_DELAY ? 'scored' : 'normal';
    return {
      opacity, phase, mirror, cut: r.k,
      // 카드 색(디자이너 10/21): 수비 장면 = 파랑(육각 무늬·제목), 공격 = 주황.
      // 수비 후 공격(recovery)은 영상대로: "상대 공격" 접근 구간만 파랑, 획득부터 주황.
      accent: phase === 'attack' ? 'orange' : phase === 'recovery' ? (r.pre ? 'blue' : 'orange') : 'blue',
      title, titleTone: phase === 'attack' ? 'normal' : phase === 'recovery' && !r.pre ? 'home' : 'opponent', player,
      // recovery 득점확률은 흰색(영상). 수비만 있는 장면은 기존대로 파랑.
      probability: P, probabilityTone: P >= 0.9995 ? 'gold' : (r.tone === 'opponent' && phase !== 'recovery') ? 'blue' : 'white',
      fill: r.fill, goal: {side: 'right', state: goalState},
      items: r.items, pops: r.pops, stamp,
    };
  }

  // ---------- 숫자 표시 규칙(룰렛)
  // 10% 미만은 소수 한 자리, 100%는 정수. 값이 바뀌는 동안 자리마다 0~9 띠가 굴러감
  function formatProbability(P) {
    const pct = clamp(P, 0, 1) * 100;
    if (pct >= 99.95) return {text: '100', decimals: 0, value: 100};
    if (pct < 0.05) return {text: '0', decimals: 0, value: 0};
    const d = pct < 10 ? 1 : 0;
    return {text: pct.toFixed(d), decimals: d, value: pct};
  }
  // 룰렛 한 자리의 위치(0~10, 소수점은 굴러가는 중): 오른쪽부터 place = 0,1,2…  scaled = 값 × 10^decimals
  function odometerDigit(scaled, place) {
    const p = Math.pow(10, place);
    if (place === 0) return scaled % 10;
    const roll = clamp((scaled % p) - (p - 1), 0, 1);
    return (Math.floor(scaled / p) % 10) + roll;
  }

  return {buildGauge, frameAt, formatProbability, odometerDigit, consts: {W, H, Y, INSET, GK_PX, NET, PROB_K, BASE_P, MIN_GAP}};
});
