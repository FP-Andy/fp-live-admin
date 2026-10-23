// 콘솔 임베드용 게이지 렌더러. gauge_core.js(인계 패키지 "2" 정본)의 frame 을 DOM 으로 그린다.
// 렌더 로직은 패키지 web/render.js 와 동일, 부모(clips 페이지)가 postMessage 로 선택 클립을 넣어 주면 재생.
(function () {
  const {buildGauge, frameAt, formatProbability, odometerDigit} = window.XfpGauge;
  const $ = (s) => document.querySelector(s);
  const IMG = 'media/img/';
  const SIZE = {main: 70, normal: 60, ghost: 52, runner: 60, best: 74};

  // 클립이 어느 팀(home/away) 것인지는 액션 teamSide 다수결로 정한다 — away 클립을 'home' 으로
  // 두면 buildGauge 의 팀 필터에서 전부 걸러져 빈 모델이 된다.
  function pickTeam(actions) {
    const c = {};
    (actions || []).forEach((a) => { const s = a.teamSide; if (s) c[s] = (c[s] || 0) + 1; });
    return Object.keys(c).sort((x, y) => c[y] - c[x])[0] || 'home';
  }
  // 콘솔 actions[] → 게이지 clip 입력. receiver·tags·isGroupMain 은 extra 안에 있을 수 있음(콘솔 응답 구조).
  function toClip(actions, dur) {
    const ex = (a) => a.extra || {};
    const team = pickTeam(actions);
    const acts = (actions || []).map((a) => ({
      seq: a.seq,
      action: a.action,
      baseAction: a.baseAction,
      actionLabel: a.actionLabel,
      teamSide: a.teamSide,
      jersey: a.jersey != null ? String(a.jersey) : '',
      receiver: a.receiver != null ? a.receiver : (ex(a).receiver != null ? ex(a).receiver : ''),
      xfpScore: a.xfpScore != null ? a.xfpScore : null,
      xg: a.xg != null ? a.xg : null,
      xgot: a.xgot != null ? a.xgot : null,
      epv: a.epv != null ? a.epv : 0,
      stopThreat: a.stopThreat != null ? a.stopThreat : (ex(a).stopThreat != null ? ex(a).stopThreat : null),
      startOffset: a.startOffset != null ? a.startOffset : (ex(a).startOffset != null ? ex(a).startOffset : 0),
      endOffset: a.endOffset != null ? a.endOffset : (ex(a).endOffset != null ? ex(a).endOffset : 0),
      groupIndex: a.groupIndex != null ? a.groupIndex : ex(a).groupIndex,
      isGroupMain: a.isGroupMain != null ? a.isGroupMain : (ex(a).isGroupMain != null ? ex(a).isGroupMain : false),
      tags: a.tags != null ? a.tags : (ex(a).tags != null ? ex(a).tags : ''),
      actionCode: a.actionCode != null ? a.actionCode : '',
    }));
    const maxEnd = acts.reduce((m, a) => Math.max(m, a.endOffset || 0), 0);
    return {id: 'console', dur: dur && dur > 0 ? dur : maxEnd || 1, team, actions: acts};
  }

  function itemHtml(it) {
    switch (it.type) {
      case 'home': {
        const s = SIZE[it.role] || 60;
        return `<div class="ob home ${it.role}" style="left:${it.x}px;width:${s}px;height:${s}px;margin-left:${it.dx}px;opacity:${it.opacity};transform:translate(-50%,-50%) scale(${it.scale})"><img src="${IMG}player_home_hexagon.svg" alt=""><span style="font-size:${Math.round(s * 0.31)}px">${it.jersey}</span></div>`;
      }
      case 'away': return `<div class="ob away ${it.role}" style="left:${it.x}px;opacity:${it.opacity}"><img src="${IMG}player_away_circle.svg" alt=""></div>`;
      case 'ball': return `<div class="ob ball" style="left:${it.x}px;top:${it.y}px;opacity:${it.opacity}"><img src="${IMG}ball.svg" alt=""></div>`;
      case 'trail': return `<div class="trail${it.past ? ' past' : ''}" style="left:${it.x1}px;width:${it.x2 - it.x1}px;opacity:${it.opacity};background-image:url(${IMG}arrow_move_${it.kind}_tile.svg)${it.dir === -1 ? ';transform:translateY(-50%) scaleX(-1)' : ''}"></div>`;
      case 'tag': return `<span class="tag" style="left:${it.x}px">${it.text}</span>`;
      case 'burst': return `<div class="burst" style="left:${it.x}px;top:${it.y}px;width:${it.r * 2}px;height:${it.r * 2}px;opacity:${it.opacity}"></div>`;
      case 'bestSeg': return `<div class="bestseg" style="left:${it.x1}px;width:${it.x2 - it.x1}px;--sw:${(it.sweep * 140 - 20).toFixed(1)}%;opacity:${it.opacity}"></div>`;
      default: return '';
    }
  }
  function lineSvg(it) {
    const c = it.color === 'blue' ? '#4377EB' : '#04FF04';
    let s = `<line x1="${it.x1}" y1="${it.y1}" x2="${it.x2}" y2="${it.y2}" stroke="${c}" stroke-width="4" stroke-linecap="round"${it.dashed ? ' stroke-dasharray="3 9"' : ''}/>`;
    if (it.head) { const d = Math.sign(it.x2 - it.x1) || 1, x = it.x2; s += `<path d="M${x} ${it.y2} L${x - 15 * d} ${it.y2 - 9} L${x - 15 * d} ${it.y2 + 9} Z" fill="${c}"/>`; }
    return `<g opacity="${it.opacity}">${s}</g>`;
  }
  // 룰렛 숫자 — 득점확률(%)을 자리마다 0~9 띠가 굴러가며 표시
  function odometer(P) {
    const f = formatProbability(P);
    const scaled = f.value * Math.pow(10, f.decimals);
    const digits = Math.max(f.decimals + 1, String(Math.floor(scaled + 1e-6)).length);
    let h = '';
    for (let place = digits - 1; place >= 0; place--) {
      if (place === f.decimals - 1 && f.decimals) h += '<span class="odc">.</span>';
      const pos = odometerDigit(scaled, place);
      h += `<span class="odc"><span class="ods" style="transform:translateY(-${(pos * 1.2).toFixed(3)}em)">0<br>1<br>2<br>3<br>4<br>5<br>6<br>7<br>8<br>9<br>0</span></span>`;
    }
    return `<span class="odo">${h}</span><small>%</small>`;
  }

  function render(F) {
    const g = $('#gauge');
    g.style.opacity = F.opacity;
    const bg = `${IMG}card_hex_${F.accent}.svg`; if (!$('#hexbg').src.endsWith(bg)) $('#hexbg').src = bg;
    $('#ttl').textContent = F.title; $('#ttl').classList.toggle('opp', F.titleTone === 'opponent');
    $('#who').innerHTML = F.player ? `<div class="hx${F.player.gold ? ' gold' : ''}"><img src="${IMG}player_home_hexagon.svg" alt=""><span>${F.player.jersey}</span></div>${F.player.score != null ? `<span class="score${F.player.score >= 95 ? ' gold' : ''}">${F.player.score}<small>점</small></span>` : ''}` : '';
    const fill = $('#fill');
    fill.className = `fill ${F.fill.tone} ${F.fill.from}`;
    fill.style.width = `${F.fill.width}px`; fill.hidden = F.fill.width < 0.5;
    $('#goal').className = `goal ${F.goal.side} ${F.goal.state}`;
    $('#obs').innerHTML = F.items.filter((i) => i.type !== 'line').map(itemHtml).join('');
    $('#svg').innerHTML = F.items.filter((i) => i.type === 'line').map(lineSvg).join('');
    const tot = $('#total');
    tot.innerHTML = odometer(F.probability); tot.hidden = !F.showProbability;
    tot.className = `total ${F.probabilityTone}`;
    $('#pops').innerHTML = F.pops.map((p) => `<span class="pop" style="left:${p.x}px;top:${98 - 14 * (1 - Math.pow(1 - p.age, 3))}px;opacity:${1 - p.age * p.age}">+${p.value >= 10 ? Math.round(p.value) : p.value.toFixed(1)}</span>`).join('');
    const st = $('#stamp');
    st.style.opacity = F.stamp.opacity; st.querySelector('img').style.transform = `rotate(12deg) scale(${F.stamp.scale})`;
  }

  // ---------- 재생 상태
  let M = null, DUR = 1, t = 0, playing = true, last = performance.now();

  function fitCard() {
    const stage = $('.stage'); const el = $('#scale');
    if (!stage || el.hidden) return;
    const s = Math.min(1, (stage.clientWidth - 8) / 754);
    el.style.transform = `scale(${s})`;
    el.style.marginBottom = `${-252 * (1 - s)}px`;
    el.style.marginLeft = `${Math.max(0, (stage.clientWidth - 754 * s) / 2)}px`;
  }
  addEventListener('resize', fitCard);

  function loadClip(actions, dur) {
    const clip = toClip(actions, dur);
    if (!clip.actions.length) { $('#empty').hidden = false; $('#scale').hidden = true; M = null; return; }
    M = buildGauge(clip); DUR = clip.dur; t = 0; playing = true;
    $('#play').textContent = '일시정지';
    $('#empty').hidden = true; $('#scale').hidden = false;
    fitCard();
  }

  function tick(now) {
    const dt = (now - last) / 1000; last = now;
    if (M) {
      if (playing) { t += dt; if (t > DUR + 1.2) t = 0; }
      const tt = Math.min(t, DUR), F = frameAt(M, tt);
      render(F);
      $('#tc').textContent = `${tt.toFixed(1)} / ${DUR.toFixed(1)}초`;
      $('#scrub').value = DUR ? tt / DUR : 0;
    }
    requestAnimationFrame(tick);
  }

  $('#play').addEventListener('click', () => { playing = !playing; $('#play').textContent = playing ? '일시정지' : '재생'; });
  $('#scrub').addEventListener('input', (e) => { playing = false; $('#play').textContent = '재생'; t = +e.target.value * DUR; });

  addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.type === 'xfp-gauge-clip') loadClip(d.actions, d.dur);
  });
  // 부모에게 준비 완료 알림(부모가 이 신호를 받고 현재 클립을 보냄)
  try { if (parent && parent !== window) parent.postMessage({type: 'xfp-gauge-ready'}, '*'); } catch (_) {}

  requestAnimationFrame(tick);
})();
