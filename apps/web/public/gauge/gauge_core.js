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

  const DEF = new Set(['Intercept', 'Clear', 'Cutout', 'Tackle', 'Block', 'Save', 'Interception', 'Clearance', 'Defense', 'Duel']);
  const HOLD_ACT = new Set(['Tackle', 'Intercept', 'Interception', 'Duel']);  // 우리가 공을 가짐
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
    D.approach = A0 === 'Save' || (A0 === 'Block' && a0.xg != null) ? 'shot'
      : A0 === 'Tackle' ? 'dribble'
      : ['Intercept', 'Interception', 'Cutout'].includes(A0) ? 'pass' : 'loose';
    const threat = A0 === 'Save' ? (a0.xgot || a0.xg) : A0 === 'Block' ? a0.xg : null;
    D.save = A0 === 'Save';
    // 상대 득점 확률: 막은 슈팅 xG(선방은 xGOT), 그 밖은 막아 낸 EPV(콘솔 승계값), 없으면 기본값
    D.P = threat != null ? threat : a0.epv > 0 ? a0.epv : BASE_P;
    D.level = D.save ? 0.96 : threat != null ? clamp(0.5 + threat * 2.5, 0.55, 0.88) : 0.65;
    D.tD = g0.s + clamp((g0.e - g0.s) * 0.3, 1.0, THREAT_RISE);  // 상대 접근은 최소 1초
    G.forEach((g, i) => {
      const A = g.main.baseAction, last = i === G.length - 1, punch = /Punch/.test(g.main.tags || '');
      const hold = HOLD_ACT.has(A) || (A === 'Save' && !punch);
      g.out = hold ? 'hold' : last ? (recovery ? 'hold' : 'out') : 'loose';
      g.tAct = i === 0 ? D.tD : g.s + 0.5;
    });
    D.endT = G[G.length - 1].tAct + 0.7;
    return D;
  }

  // ---------- 클립 → 모델
  // clip = {dur, actions:[{seq, action, baseAction, actionLabel, jersey, receiver, xfpScore, xg, xgot, epv,
  //          startOffset, endOffset, groupIndex, isGroupMain, tags}]}
  function buildGauge(clip) {
    const acts0 = clip.actions.filter((a) => (a.teamSide || 'home') === (clip.team || 'home'));
    const by = new Map();
    for (const a of acts0) { if (!by.has(a.groupIndex)) by.set(a.groupIndex, []); by.get(a.groupIndex).push(a); }
    const all = [...by.entries()].sort((a, b) => a[0] - b[0]).map(([, acts]) => {
      const main = acts.find((a) => a.isGroupMain) || acts[0];
      const s = Math.min(...acts.map((a) => a.startOffset)), e = Math.max(...acts.map((a) => a.endOffset));
      const isShot = acts.some((a) => a.baseAction === 'Shot'), isDef = DEF.has(main.baseAction);
      // 크로스는 패스와 똑같이 그리고 제목만 '크로스'
      const type = isShot ? 'shot' : ['Pass', 'Cross'].includes(main.baseAction) ? 'pass' : isDef ? 'carry' : 'dribble';
      const runners = acts.filter((a) => a !== main && a.baseAction === 'Penetration');
      return {acts, main, s, e, isShot, isDef, type, runners, move: isShot ? SHOT_MOVE : Math.min(MOVE_MAX, e - s)};
    });
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
      M.rec = defModel(all.slice(0, lead), true); M.lead = lead;
      // 반전 후 공을 지킨 자리 = 공격 출발점. 걷어낸 공이 흘러 다음 선수가 받으면(loose) 그만큼 앞(오른쪽)에서 끝나므로 미리 당겨 둠
      const nLoose = M.rec.G.filter((g) => g.out === 'loose').length;
      M.rec.level = clamp(1 - G[0].a + 0.14 * nLoose, 0.3, 0.92);
      // 공을 뺏자마자(0.6초 뒤) 주황 공격 시작 — 중간에 멈추지 않게. 첫 공격 플레이가 원래 끝나는 시각까지 이어서 움직임(10/22)
      M.steal = M.rec.G[lead - 1].tAct;  // 공을 뺏은 순간: 여기서부터 주황 게이지가 0에서 차오름(10/22)
      const g0 = G[0], won = M.steal + 0.6;
      if (g0.isShot) M.attackFrom = Math.max(g0.s, won);
      else { const end = g0.s + g0.move; M.attackFrom = Math.min(won, end - 0.6); g0.move = Math.max(0.6, end - M.attackFrom); }
      G[0].s0 = M.attackFrom;
    }
    G.forEach((g) => { if (g.s0 == null) g.s0 = g.s; });
    const endT = Math.max(...G.map((g) => g.s0 + g.move)) + (goal ? GOAL_DELAY : 0);
    return Object.assign(M, {kind: 'attack', G, goal, blocked, miss, onT, endT, praise: goal,
      result: goal ? '득점 성공' : onT ? '유효 슈팅' : blocked ? '슈팅 막힘' : miss ? '슈팅' : `${label(G[G.length - 1].main)} 성공`});
  }

  // ---------- 그릴 것(items)
  // home  {x, jersey, role: main|normal|ghost|runner|best, opacity, scale, dx}  우리 선수(주황 육각, 안 숫자 = 등번호)
  // away  {x, role: lead|normal|beat, opacity}                                  상대(파란 원)
  // ball  {x, y, opacity}
  // trail {x1, x2, kind: dribble|penetrate, past, opacity}                        꽉 찬/빈 화살표 발자취(타일 반복)
  // line  {x1, y1, x2, y2, color: green|blue, dashed, head, opacity}              패스선·슈팅 궤적
  // tag   {x, text}                                                              '도움'
  // bestSeg {x1, x2, sweep, opacity}                                             최고 플레이 칸 금빛
  // burst {x, y, r, opacity}                                                     뺏는 순간 퍼지는 주황 링(반지름 r)
  const home = (x, jersey, role, o = {}) => ({type: 'home', x, jersey: jersey == null ? '' : String(jersey), role, opacity: 1, scale: 1, dx: 0, ...o});
  const away = (x, role, opacity = 1) => ({type: 'away', x, role, opacity});
  const ball = (x, y = Y, opacity = 1) => ({type: 'ball', x, y, opacity});
  const trail = (kind, x1, x2, o = {}) => (x2 - x1 < 8 ? null : {type: 'trail', kind, x1, x2, past: false, opacity: 1, ...o});
  const line = (x1, y1, x2, y2, o = {}) => ({type: 'line', x1, y1, x2, y2, color: 'green', dashed: false, head: false, opacity: 1, ...o});

  function attackFrame(M, t) {
    const G = M.G, items = [];
    let k = 0; G.forEach((g, i) => { if (t >= g.s0) k = i; });
    const g = G[k], f = clamp((t - g.s0) / Math.max(0.05, g.move), 0, 1), ef = g.isShot ? f : k === 0 && M.lead ? 1 - (1 - f) * (1 - f) : easeIO(f);  // 뺏은 직후 공격은 바로 치고 나감
    const ramp = k !== 0 ? 1 : M.lead ? 1 : t < g.s0 ? easeO(clamp((t - (g.s0 - 0.3)) / 0.5, 0, 1)) : 1;
    // pos = 선수·공 자리, front = 막대 채움(장면 시작 때만 0부터 차오름). 선수는 차오름을 따라 움직이지 않음
    const pos = g.a + (g.b - g.a) * ef, front = pos * ramp;
    let bl = null, fillPx = null;
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
    if (g.type === 'pass') {
      items.push(home(X(g.a), g.main.jersey, 'main'));
      if (g.main.receiver) items.push(home(X(g.b), g.main.receiver, 'normal'));
      items.push(line(X(g.a), Y, X(pos), Y, {head: f >= 0.98}));
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
      if (g.type === 'dribble') items.push(trail('dribble', X(g.a), X(pos) - 30));
      items.push(home(X(pos), g.main.jersey, 'main'));
    }
    // 침투: 한 자리에 겹쳐 함께 달림. 맨 위 = 공 받는 선수(없으면 xFP 최고). 공 주인이 정해지면 나머지는 사라짐
    if (g.runners.length) {
      const nx = G[k + 1];
      const got = (r) => !!((nx && (nx.main.jersey === r.jersey || nx.main.receiver === r.jersey)) || g.main.receiver === r.jersey);
      const order = [...g.runners].sort((p, q) => (got(p) - got(q)) || ((p.xfpScore || 0) - (q.xfpScore || 0)));
      const r0 = Math.min(0.96, g.a + RUN_GAP), ru = Math.min(0.96, pos + RUN_GAP);
      const out = 1 - clamp((t - (g.s0 + g.move)) / 0.4, 0, 1), tf = g.runners.some(got) ? 1 : out;
      if (tf > 0) items.push(trail('penetrate', X(r0) - 30, X(ru) - 30, {opacity: tf}));
      order.forEach((r, i) => {
        const fade = got(r) ? 1 : out;
        if (fade > 0) items.push(home(X(ru), i === order.length - 1 ? r.jersey : '', 'runner', {opacity: fade, dx: -(order.length - 1 - i) * 13}));
      });
    }
    // 몰고 가는 공은 선수 육각 오른쪽에 30px 붙음(뺏을 때와 같은 자리 → 끊김 없음)
    items.push(bl || ball(g.type === 'dribble' || g.type === 'carry' ? Math.min(X(1), X(pos) + 30) : X(pos)));
    // 막대
    const done = M.goal && t >= M.endT, ended = t >= M.endT + HOLD;
    const fill = done ? {from: 'left', width: W, tone: 'done'}
      : {from: 'left', width: fillPx != null ? fillPx : front >= 0.999 ? W : X(front), tone: (M.miss || M.blocked) && ended ? 'miss' : 'attack'};
    // 확률
    let P;
    if (!g.isShot) P = (g.pa + (g.pb - g.pa) * ef) * ramp;
    else if (M.goal) P = t < M.endT ? g.pa + (g.pxgot - g.pa) * f : g.pxgot + (1 - g.pxgot) * easeO(clamp((t - M.endT) / 0.5, 0, 1));
    else if (M.onT) P = g.pa + (g.pb - g.pa) * f;
    else P = g.pa;
    // +N 팝업: 칸이 다 찬 순간부터 1초
    const ups = G.filter((q) => !q.isShot).map((q) => ({t: q.s0 + q.move, x: X(q.b), n: (q.pb - q.pa) * 100}));
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
      // 공은 처음 자리에서 우리 선수 앞(30px)까지 같은 박자로 와서 정확히 뺏는 순간에 닿음(게이지 멈춤·링 효과와 동시)
      const a = D.approach === 'shot' || D.approach === 'pass' ? s0 + 0.04 : s0, bx = X(a) + ((D.save ? GK_PX : X(L)) - 30 - X(a)) * p;
      let bu;
      if (D.approach === 'shot') { bu = s0 + 0.04 + ((D.save ? 1 : L) - s0 - 0.04) * p; items.push(away(X(s0), 'lead'), line(X(s0) + 26, Y, bx, Y, {color: 'blue', dashed: true})); }
      else if (D.approach === 'dribble') { bu = s0 + (L - 0.03 - s0) * p; items.push(away(bx - 30, 'lead')); }
      else if (D.approach === 'pass') { bu = s0 + 0.04 + (L - s0 - 0.04) * p; items.push(away(X(s0), 'lead'), line(X(s0) + 26, Y, bx, Y, {color: 'blue'})); if (!D.recovery) items.push(away(X(Math.min(0.95, L + 0.15)), 'normal')); }  // 수비로 시작하는 공격: 상대는 모두 오른쪽에서만
      else { bu = s0 + (L - s0) * p; items.push(away(X(s0), 'normal')); }
      if (D.save || t > D.tD - 0.45) items.push(home(D.save ? GK_PX : X(L), a0.jersey, 'normal'));  // 골키퍼는 처음부터 골대 앞
      items.push(ball(bx));
      return {k: 0, g: g0, items, fill: {from: 'left', width: X(bu), tone: 'threat'}, ended: false, pre: true, P: D.P * p, pops: [], tone: 'opponent'};
    }
    const d = clamp((t - D.tD) / DRAIN, 0, 1);
    const fadeOpp = clamp(1 - (t - D.tD) / 0.8, 0, 1);  // 막힌 상대는 흐려졌다 사라짐
    // 막힌 상대: 수비로 시작하는 공격이면 우리 선수 바로 앞(반전 후 오른쪽)에서 흐려짐
    if (fadeOpp > 0) items.push(away(X(D.recovery ? Math.max(0.04, L - 0.06) : Math.min(0.95, D.approach === 'pass' ? L + 0.15 : L + 0.06)), 'beat', 0.3 * fadeOpp));
    // 수비 액션을 차례로 따라가며 공 자리를 정함. 지금 액션 선수만 보임
    let spot = L, b = {x: (D.save ? GK_PX : X(L)) + 26, opacity: 1}, gone = false;
    G.forEach((g, i) => {
      if (i > k) return;
      const here = i === 0 ? L : spot, on = t >= g.tAct, e = clamp((t - g.tAct) / 0.6, 0, 1);
      // 뺏는(막는) 순간 효과: 우리 말이 0.35초 동안 살짝 커졌다 돌아오고, 주황 링이 0.55초 동안 퍼지며 사라짐(10/22)
      const hit = t - g.tAct, hxPos = i === 0 && D.save ? GK_PX : X(here);
      if (i === k) items.push(home(hxPos, g.main.jersey, 'main', {scale: hit >= 0 && hit < 0.35 ? 1 + 0.28 * (1 - easeO(hit / 0.35)) : 1}));
      if (hit >= 0 && hit < 0.55) items.push({type: 'burst', x: hxPos, y: Y, r: 34 + 46 * easeO(hit / 0.55), opacity: 1 - hit / 0.55});
      if (gone) return;
      const hx0 = i === 0 && D.save ? GK_PX : X(here);
      if (!on) { b = {x: hx0 - 30, opacity: 1}; return; }
      if (g.out === 'hold') { b = {x: hx0 - 30, opacity: 1}; spot = here; }  // 우리 소유: 공은 말 앞(상대가 오던 쪽)
      else if (g.out === 'loose') { const to = Math.max(0.08, here - 0.14); spot = to; b = {x: hx0 + (X(to) - hx0) * easeO(e), opacity: 1}; }
      else { const from = hx0 - 26, to = -60; b = {x: from + (to - from) * easeIn(e), opacity: 1 - e}; if (e >= 1) gone = true; }
    });
    if (!gone && b.opacity > 0.02) items.push(ball(b.x, Y, b.opacity));
    return {k, g: G[k], items, fill: {from: 'left', width: d >= 1 ? 0 : X(L * (1 - easeO(d))), tone: 'drain'}, ended: !D.recovery && t >= D.endT + HOLD,
      pre: false, P: d >= 1 ? 0 : D.P * (1 - easeO(d)), pops: [], tone: 'opponent'};
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
    const opacity = clamp((t - Math.max(0, M.all[0].s - 0.3)) / 0.25, 0, 1) * clamp((M.dur - 0.05 - t) / 0.3, 0, 1);
    let r, phase;
    if (M.kind === 'defense') { r = defenseFrame(M.def, t); phase = 'defense'; }
    // 수비로 시작하는 공격의 수비 부분: 상대·공 움직임만 보이고 파란 막대·확률 숫자는 없음(재형님 10/22). 뺏은 뒤 주황이 0부터
    else if (M.rec && t < M.attackFrom) {
      r = mirrorFrame(defenseFrame(M.rec, t)); phase = 'recovery';
      // 상대가 다가오는 동안 주황 막대·확률이 미리 차오르다가 뺏는 순간 우리 선수 자리에서 딱 멈춤(링 효과와 동시, 10/22)
      const t0 = Math.max(0, M.all[0].s - 0.3), u = easeIO(clamp((t - t0) / Math.max(0.3, M.steal - t0), 0, 1));
      r.fill = {from: 'left', width: u > 0 ? X(M.G[0].a * u) : 0, tone: 'attack'}; r.P = M.G[0].pa * u; if (u > 0) r.tone = 'attack';
    }
    else { r = attackFrame(M, t); r.k += M.lead; phase = 'attack'; }
    const mirror = phase === 'recovery';
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
      title = M.result; player = e.xfpScore != null ? {jersey: String(e.jersey), score: e.xfpScore, gold: true} : null;
    } else if (r.pre) { title = '상대 공격'; }
    else { const a = r.g.main; title = liveLabel(a); player = {jersey: String(a.jersey), score: a.xfpScore != null ? a.xfpScore : null, gold: a.xfpScore >= 95}; }
    const P = clamp(r.P || 0, 0, 1);
    const sf = M.praise && t >= M.endT ? t - M.endT : -1;
    const stamp = sf < 0 ? {opacity: 0, scale: 1} : {opacity: clamp(sf / (0.22 * 0.6), 0, 1), scale: sf < 0.22 ? 2.2 - 1.32 * easeIn(sf / 0.22) : 0.88 + 0.12 * easeO(clamp((sf - 0.22) / 0.2, 0, 1))};
    // 골대는 늘 오른쪽(필드는 뒤집지 않음). 수비만 있는 장면 = 우리 골(파랑), 수비로 시작하는 공격 = 우리가 노릴 상대 골(흰색)
    const ours = phase === 'attack' || (phase === 'recovery' && t >= M.steal);  // 우리 공이 된 뒤 = 주황 카드
    const goalState = phase === 'defense' ? 'own' : M.goal && t >= M.endT - GOAL_DELAY ? 'scored' : 'normal';
    return {
      opacity, phase, mirror, cut: r.k,
      // 카드 색(디자이너 10/21): 수비 장면 = 파랑(육각 무늬·제목), 공격 = 주황
      accent: ours ? 'orange' : 'blue',
      title, titleTone: ours ? 'normal' : 'opponent', player,
      probability: P, showProbability: true, probabilityTone: P >= 0.9995 ? 'gold' : r.tone === 'opponent' ? 'blue' : 'white',
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
