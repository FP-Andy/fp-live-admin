'use strict';
/**
 * 클립 다듬기 + 이어 붙이기 + 점수판 새기기 — 서버 highlight_jobs.merge_manual_clips_for_job
 * 을 그대로 옮긴 것.
 *
 * ⚠️ 이 파일은 **파이썬 원본과 같은 ffmpeg 명령을 내야 한다.** 저쪽엔 어렵게 알아낸 것들이
 * 박혀 있다 — 조각으로 나눠 굽기(한 그래프에 19개 물렸다가 6.1GB 로 OOM), 출력 픽셀포맷
 * 못 박기(yuv444p 로 빠져 모바일에서 안 열림), acrossfade 대신 afade 합성(입력 길이가 페이드
 * 길이와 같으면 인코더가 죽음), 점수판 마지막 구간을 lt/gte 로 열어 두기(between 은 끝
 * 프레임이 사라짐). 새로 짜지 말고 저쪽이 바뀌면 여기도 같이 바꿀 것.
 *
 * 명령을 '만드는 일' 과 '돌리는 일' 을 갈라 둔 이유 — 만들어진 명령줄을 파이썬 것과
 * 곧이곧대로 대조할 수 있어야 옮기다 흘린 데를 찾는다.
 */
const path = require('path');

const INTRO_SEC = 1.8;
const INTRO_FADE_SEC = 0.3;
const XFADE_SEC = 0.4;
const MERGE_PRESET = 'ultrafast';

// 점수판 기하 — scoreboard.py 와 같은 값이라야 판이 같은 자리에 앉는다.
const DESIGN_H = 182.0;
const BOARD_ASPECT = 4.94;
const LOGO_RISE = 61.01;

const f3 = (x) => Number(x).toFixed(3);

/** 파이썬 round() 와 같은 자리에서 끊는다(은행가 반올림 차이는 여기선 의미 없다). */
const r = (x) => Math.round(x);

function boardSizeForVideo(videoW, videoH, sizePct = 24.33) {
  const pct = Math.max(10, Math.min(60, Number(sizePct))) / 100;
  const byWidth = videoW * pct;
  const byHeight = videoH * 0.18 * BOARD_ASPECT;
  const w = Math.max(160, r(Math.min(byWidth, byHeight)));
  return [w, Math.max(30, r(w / BOARD_ASPECT))];
}

function boardPlacement(videoW, videoH, sizePct = 24.33, posX = 2.18, posY = 4.42, withLogo = false) {
  const [w, plateH] = boardSizeForVideo(videoW, videoH, sizePct);
  const h = plateH + (withLogo ? r(plateH * (LOGO_RISE / DESIGN_H)) : 0);
  const margin = Math.max(16, r(videoW * 0.021));
  const freeX = Math.max(0, videoW - w - 2 * margin);
  const freeY = Math.max(0, videoH - h - 2 * margin);
  const frac = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) / 100 : 0;
  };
  return [w, h, margin + r(freeX * frac(posX)), margin + r(freeY * frac(posY))];
}

/**
 * 점수판 설정과 클립별 점수 상태. 꺼져 있으면 null.
 * 골 태그는 '태깅한 그 순간' 점수를 올리므로 클립마다 pre/post/goal_at 을 낸다.
 */
function scoreboardPlan(config, clipMeta, lengths) {
  if (!config || typeof config !== 'object' || !config.enabled) return null;
  const asInt = (key) => {
    const n = parseInt(config[key], 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  };
  let home = asInt('start_home');
  let away = asInt('start_away');
  const pre = [];
  const post = [];
  const goalAt = [];
  clipMeta.forEach((info, k) => {
    pre.push([home, away]);
    const kind = String(info?.kind || '');
    if (kind === 'home_goal') home += 1;
    else if (kind === 'away_goal') away += 1;
    post.push([home, away]);
    // 태그 시점을 못 받은 옛 클립은 클립 한가운데로 본다(그래도 순서는 맞는다).
    const raw = Number(info?.tag_offset);
    const at = Number.isFinite(raw) ? raw : lengths[k] / 2;
    goalAt.push(Math.max(0, Math.min(lengths[k], at)));
  });
  return { config, pre, post, goalAt };
}

/**
 * 합치기에 쓸 ffmpeg 명령들을 만든다. 실제로 돌리지는 않는다.
 *
 * @param {object} o
 *   o.clips       [{path, offset, length, hasAudio, kind, tagOffset}] — 합칠 순서대로
 *   o.video       {w, h, fps}  — 첫 클립 규격(모든 조각을 여기 맞춘다)
 *   o.workDir     조각을 구울 폴더
 *   o.outPath     최종 mp4
 *   o.intro       {imagePath, duration} 또는 null
 *   o.scoreboard  태깅 화면이 보낸 설정 또는 null
 *   o.sbImage     (home, away) => PNG 경로. 점수판 그림은 바깥에서 굽는다.
 *   o.sbHasLogo   그 그림에 로고가 들어갔는가. 로고가 있으면 판보다 세로가 길어
 *                 자리를 그 높이로 잡아야 위에 붙였을 때 로고가 잘리지 않는다.
 *                 '설정에 logo_url 이 있는가' 가 아니라 **실제로 그렸는가** 다 —
 *                 서버 쪽도 해독에 실패하면 로고 없이 간다.
 * @returns {{commands: {label:string,args:string[]}[], pieces:string[], concatList:string, outPath:string}}
 */
function planMerge(o) {
  const { clips, video, workDir, outPath, intro, sbImage } = o;
  const used = clips.length;
  if (!used) throw new Error('합칠 클립이 없습니다.');

  const vw = video.w;
  const vh = video.h;
  const vfps = video.fps;
  const lengths = clips.map((c) => c.length);
  const hasSound = clips.map((c) => !!c.hasAudio);

  const encode = [
    '-c:v', 'libx264', '-preset', MERGE_PRESET, '-crf', '23',
    // 체인 앞쪽의 format=yuv420p 는 xfade 의 '입력' 링크만 묶는다. 출력 링크는 인코더와
    // 다시 협상해 yuv444p 로 빠지는데 그건 모바일 하드웨어 디코더가 못 읽는다.
    '-pix_fmt', 'yuv420p', '-r', String(vfps),
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
  ];

  const normV = `scale=${vw}:${vh}:force_original_aspect_ratio=decrease,`
    + `pad=${vw}:${vh}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${vfps},format=yuv420p`;

  // 경계마다 걸 크로스페이드 길이. 양쪽 클립의 1/3 을 넘지 않게 두면 어떤 클립도
  // 앞뒤 페이드를 뺀 본체가 반드시 남는다. 너무 짧으면 하드컷.
  const fades = [];
  for (let k = 0; k < used - 1; k += 1) {
    const d = Math.min(XFADE_SEC, lengths[k] / 3, lengths[k + 1] / 3);
    fades.push(d <= 0.02 ? 0 : d);
  }
  const headFade = (k) => (k > 0 ? fades[k - 1] : 0);
  const tailFade = (k) => (k < used - 1 ? fades[k] : 0);

  const sb = scoreboardPlan(o.scoreboard, clips.map((c) => ({ kind: c.kind, tag_offset: c.tagOffset })), lengths);
  let sbX = 0;
  let sbY = 0;
  if (sb) {
    const cfg = sb.config;
    const [, , x, y] = boardPlacement(
      vw, vh,
      Number(cfg.size_pct) || 28,
      Number(cfg.pos_x) || 0,
      Number(cfg.pos_y) || 0,
      !!o.sbHasLogo,
    );
    sbX = x;
    sbY = y;
  }

  const scoreAt = (k, relT) => (relT >= sb.goalAt[k] ? sb.post[k] : sb.pre[k]);

  /** 경계 후보로 조각을 나누고, 점수가 같은 이웃 구간은 도로 합친다. */
  const makeSegments = (cuts, scoreOf) => {
    if (!sb) return [];
    const edges = [...new Set(cuts.map((c) => Number(c.toFixed(3))))].sort((a, b) => a - b);
    const out = [];
    for (let i = 0; i < edges.length - 1; i += 1) {
      const a = edges[i];
      const b = edges[i + 1];
      if (b - a <= 0.001) continue;
      const score = scoreOf((a + b) / 2);
      const last = out[out.length - 1];
      if (last && last.score[0] === score[0] && last.score[1] === score[1]) last.b = b;
      else out.push({ score, a, b });
    }
    return out;
  };

  /**
   * 점수판 입력·필터 체인. 구간이 하나면 enable 없이 통째로.
   * 여러 개면 마지막 구간은 lt/gte 로 열어 둔다 — between 은 끝 프레임이 부동소수
   * 오차로 살짝 넘어가면 점수판이 한 프레임 사라진다.
   */
  const overlayArgs = (base, segs, idxStart) => {
    if (!segs.length) return { ins: [], chains: [], label: base, idx: idxStart };
    const ins = [];
    const chains = [];
    let cur = base;
    let idx = idxStart;
    const last = segs.length - 1;
    segs.forEach((seg, i) => {
      ins.push('-i', String(sbImage(seg.score[0], seg.score[1])));
      const label = `sb${i}`;
      let enable = '';
      if (last === 0) enable = '';
      else if (i === 0) enable = `:enable='lt(t,${f3(seg.b)})'`;
      else if (i === last) enable = `:enable='gte(t,${f3(seg.a)})'`;
      else enable = `:enable='between(t,${f3(seg.a)},${f3(seg.b)})'`;
      chains.push(`[${cur}][${idx}:v]overlay=${sbX}:${sbY}${enable}[${label}]`);
      cur = label;
      idx += 1;
    });
    return { ins, chains, label: cur, idx };
  };

  const clipInput = (k, start, dur) => ['-ss', f3(start), '-t', f3(dur), '-i', String(clips[k].path)];

  /**
   * 무음 트랙 입력. 필요한 길이보다 넉넉히 만들고 -shortest 로 영상에 맞춰 자른다.
   * 딱 맞는 길이로 주면 오디오가 한 프레임도 내지 못한 채 EOF 로 끝나 인코더가 죽는다.
   */
  const silence = (dur) => ['-f', 'lavfi', '-t', f3(dur + 1.0),
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];

  const commands = [];
  const pieces = [];
  const pieceName = (suffix) => `p${String(pieces.length).padStart(3, '0')}_${suffix}.mp4`;

  // ── 인트로 사진 — 하드컷으로 맨 앞에(크로스페이드는 클립끼리만) ──
  if (intro && intro.imagePath && intro.duration > 0) {
    const out = path.join(workDir, 'p000_intro.mp4');
    commands.push({
      label: '인트로',
      args: [
        '-y', '-nostats',
        '-loop', '1', '-t', f3(intro.duration), '-i', String(intro.imagePath),
        ...silence(intro.duration),
        '-filter_complex',
        `[0:v]scale=${vw}:${vh}:force_original_aspect_ratio=decrease,`
        + `pad=${vw}:${vh}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${vfps},format=yuv420p,`
        + `fade=t=in:st=0:d=${f3(INTRO_FADE_SEC)}[v]`,
        '-map', '[v]', '-map', '1:a', '-shortest', ...encode, out,
      ],
    });
    pieces.push(out);
  }

  for (let k = 0; k < used; k += 1) {
    const { offset, length } = clips[k];
    const goalRef = sb ? sb.goalAt[k] : 0;

    // ── 본체: 앞뒤 페이드 몫을 뺀 구간 ──
    const bodyStart = offset + headFade(k);
    const bodyDur = length - headFade(k) - tailFade(k);
    const out = path.join(workDir, pieceName(`body${String(k).padStart(3, '0')}`));
    const args = ['-y', '-nostats', ...clipInput(k, bodyStart, bodyDur)];
    let nextInput = 1;
    let audioMap;
    if (hasSound[k]) {
      audioMap = '0:a';
    } else {
      args.push(...silence(bodyDur));
      audioMap = `${nextInput}:a`;
      nextInput += 1;
    }
    const chains = [`[0:v]${normV}[v0]`];
    // 조각 시간 0 이 클립 시간 head_fade 에 해당하므로 골 시점도 그만큼 당겨서 본다.
    const segs = sb
      ? makeSegments([0, bodyDur, goalRef - headFade(k)], (tau) => scoreAt(k, tau + headFade(k)))
      : [];
    const ov = overlayArgs('v0', segs, nextInput);
    args.push(...ov.ins);
    args.push(
      '-filter_complex', [...chains, ...ov.chains].join(';'),
      '-map', `[${ov.label}]`, '-map', audioMap,
      ...(hasSound[k] ? [] : ['-shortest']),
      ...encode, out,
    );
    commands.push({ label: `본체 ${k + 1}`, args });
    pieces.push(out);

    // ── 전환: 이 클립 꼬리 + 다음 클립 머리 ──
    const d = tailFade(k);
    if (d <= 0) continue;
    const nxt = k + 1;
    const xout = path.join(workDir, pieceName(`x${String(k).padStart(3, '0')}`));
    const xargs = [
      '-y', '-nostats',
      ...clipInput(k, offset + length - d, d),
      ...clipInput(nxt, clips[nxt].offset, d),
    ];
    const xchains = [
      `[0:v]${normV}[xa]`,
      `[1:v]${normV}[xb]`,
      `[xa][xb]xfade=transition=fade:duration=${f3(d)}:offset=0[v0]`,
    ];
    // 무음 클립이 섞이면 걸 스트림이 없다. 그쪽만 무음을 만들어 준다.
    let aLeft = '0:a';
    let aRight = '1:a';
    let extra = 2;
    if (!hasSound[k]) {
      xargs.push(...silence(d));
      aLeft = `${extra}:a`;
      extra += 1;
    }
    if (!hasSound[nxt]) {
      xargs.push(...silence(d));
      aRight = `${extra}:a`;
      extra += 1;
    }

    // 전환 조각의 조각시간 τ 는 왼쪽 클립의 (length-d+τ) 이자 오른쪽 클립의 τ 다.
    const transSegs = sb
      ? makeSegments(
        [0, d, sb.goalAt[k] - (length - d), sb.goalAt[nxt]],
        (tau) => {
          const l = scoreAt(k, length - d + tau);
          const rr = scoreAt(nxt, tau);
          return (l[0] + l[1]) >= (rr[0] + rr[1]) ? l : rr;
        },
      )
      : [];
    const xov = overlayArgs('v0', transSegs, extra);
    xargs.push(...xov.ins);
    // acrossfade 는 첫 입력의 길이가 페이드 길이와 '같으면' 한 프레임도 내지 못하고 죽는다.
    // 전환 조각은 정확히 d 초만 잘라 쓰므로 항상 그 조건에 걸린다. 같은 결과를 내는
    // 페이드아웃+페이드인 합성으로 바꾼다(acrossfade 기본 곡선 tri 도 afade 와 같은 선형).
    const afmt = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
    xchains.push(
      `[${aLeft}]${afmt},apad,atrim=duration=${f3(d)},asetpts=N/SR/TB,`
      + `afade=t=out:st=0:d=${f3(d)}[la]`,
    );
    xchains.push(
      `[${aRight}]${afmt},apad,atrim=duration=${f3(d)},asetpts=N/SR/TB,`
      + `afade=t=in:st=0:d=${f3(d)}[ra]`,
    );
    xchains.push('[la][ra]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[a]');
    xargs.push(
      '-filter_complex', [...xchains, ...xov.chains].join(';'),
      '-map', `[${xov.label}]`, '-map', '[a]',
      ...((hasSound[k] && hasSound[nxt]) ? [] : ['-shortest']),
      ...encode, xout,
    );
    commands.push({ label: `전환 ${k + 1}`, args: xargs });
    pieces.push(xout);
  }

  // ── 이어 붙이기: 디먹서라 한 번에 한 조각만 연다(메모리 일정) ──
  const concatList = path.join(workDir, 'concat.txt');
  commands.push({
    label: '이어 붙이기',
    args: [
      '-y', '-nostats',
      '-f', 'concat', '-safe', '0', '-i', concatList,
      // 영상은 그대로 복사(재인코딩 없음). 오디오만 다시 인코딩해 조각 경계의
      // AAC 프라이밍 간극으로 '틱' 소리가 나지 않게 한다.
      '-c:v', 'copy', '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart',
      outPath,
    ],
  });

  return { commands, pieces, concatList, outPath };
}

module.exports = {
  planMerge,
  scoreboardPlan,
  boardPlacement,
  boardSizeForVideo,
  INTRO_SEC,
  INTRO_FADE_SEC,
  XFADE_SEC,
  MERGE_PRESET,
};
