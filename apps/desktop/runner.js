'use strict';
/**
 * 실제로 ffmpeg 을 돌리는 자리 — 자르기와 합치기.
 *
 * 브라우저에서 하던 일을 그대로 내 PC 의 ffmpeg 으로 옮긴 것이라, 나오는 결과는
 * 서버에서 만들던 것과 같다. 다만 두 가지가 나아진다:
 *   · wasm 이 아니라 네이티브라 훨씬 빠르고, 원본을 통째로 메모리에 올리지 않는다.
 *   · ffprobe 로 오디오 코덱을 **미리 보고** 방식을 고른다. 브라우저는 그걸 못 해서
 *     실패하면 다음 방식으로 넘어가는 식이었다(PCM 오디오 원본이 그 경우였다).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { planMerge } = require('./merge');

const FFMPEG = require('ffmpeg-static');
const FFPROBE = require('ffprobe-static').path;

/** electron-builder 로 포장하면 asar 안이라 실행할 수 없다. 풀어 둔 자리로 바꾼다. */
const unpacked = (p) => (p ? p.replace('app.asar', 'app.asar.unpacked') : p);
const FFMPEG_BIN = unpacked(FFMPEG);
const FFPROBE_BIN = unpacked(FFPROBE);

function run(bin, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      err += text;
      // 통째로 쌓으면 긴 작업에서 수십 MB 가 된다. 끝의 몇 줄만 남긴다.
      if (err.length > 8000) err = err.slice(-8000);
      if (onLine) text.split(/\r?\n/).forEach((ln) => ln && onLine(ln));
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(Object.assign(new Error(`ffmpeg 종료 코드 ${code}`), { stderr: err }));
    });
  });
}

async function probe(args) {
  const { stdout } = await run(FFPROBE_BIN, ['-v', 'error', ...args]);
  return stdout.trim();
}

/** 클립이 원본 타임라인의 어디에서 시작하는지. -copyts 로 잘라 원본 좌표를 갖고 있다. */
async function probeStartTime(file) {
  try {
    const v = parseFloat(await probe(['-show_entries', 'format=start_time', '-of', 'default=nw=1:nk=1', file]));
    return Number.isFinite(v) ? v : 0;
  } catch {
    // 못 읽으면 0 으로 두어 클립을 통째로 쓴다. 잘못 잘라내는 것보다 낫다.
    return 0;
  }
}

async function probeVideoDims(file) {
  try {
    const text = await probe([
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'default=nw=1:nk=1', file,
    ]);
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const w = parseInt(lines[0], 10);
    const h = parseInt(lines[1], 10);
    let fps = lines[2] || '';
    if (!fps || fps === '0/0' || fps === '0') fps = '30';
    if (!Number.isFinite(w) || !Number.isFinite(h)) throw new Error('규격을 읽지 못했습니다');
    return { w, h, fps };
  } catch {
    return { w: 1280, h: 720, fps: '30' };
  }
}

async function probeAudioCodec(file) {
  try {
    return await probe([
      '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nw=1:nk=1', file,
    ]);
  } catch {
    return '';
  }
}

async function hasAudio(file) {
  return (await probeAudioCodec(file)) !== '';
}

/**
 * mp4 에 그대로 담을 수 있는 오디오인가.
 *
 * mp4 컨테이너는 담을 수 있는 코덱이 정해져 있다. SUFA 원본의 pcm_s16be 처럼 아닌 것을
 * 그대로 넣으려 하면 "Could not find tag for codec" 로 죽는다 — 이건 ffmpeg 버전 문제가
 * 아니라 컨테이너의 성질이라 최신 ffmpeg 으로도 같다. 그래서 그런 원본은 오디오만
 * 다시 인코딩한다(영상은 손대지 않으므로 화질은 그대로다).
 */
const MP4_SAFE_AUDIO = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac', 'mp2', 'opus']);

function cutCodecArgs(audioCodec) {
  if (!audioCodec) return { args: ['-c', 'copy'], note: '무손실 복사(오디오 없음)' };
  if (MP4_SAFE_AUDIO.has(audioCodec)) return { args: ['-c', 'copy'], note: '무손실 복사' };
  return { args: ['-c:v', 'copy', '-c:a', 'aac'], note: `오디오 재인코딩(${audioCodec})` };
}

/**
 * 태그 구간들을 잘라 클립 파일로 만든다.
 *
 * 브라우저와 같은 방식 — 키프레임 경계까지만 자르고 `-copyts` 로 원본 좌표를 남긴다.
 * 정확한 지점 다듬기는 합칠 때 한 번의 재인코딩으로 처리한다(두 번 굽지 않는다).
 */
async function cutClips({ sources, ranges, outDir, onProgress }) {
  fs.mkdirSync(outDir, { recursive: true });
  const codecBySource = new Map();
  const clips = [];

  for (let i = 0; i < ranges.length; i += 1) {
    const range = ranges[i];
    const src = sources[range.sourceIndex];
    if (!codecBySource.has(src)) codecBySource.set(src, cutCodecArgs(await probeAudioCodec(src)));
    const codec = codecBySource.get(src);

    const name = `clip_${String(i + 1).padStart(3, '0')}.mp4`;
    const out = path.join(outDir, name);
    if (onProgress) onProgress({ done: i, total: ranges.length, message: `${i + 1}번 클립 자르는 중 · ${codec.note}` });

    await run(FFMPEG_BIN, [
      '-y', '-nostats',
      '-ss', range.start.toFixed(3),
      '-i', src,
      '-to', range.end.toFixed(3),
      ...codec.args,
      '-copyts',
      out,
    ]);

    const stat = fs.statSync(out);
    if (stat.size < 1024) throw new Error(`${i + 1}번 클립을 만들지 못했습니다`);
    clips.push({
      name,
      path: out,
      size: stat.size,
      requested_start: range.start,
      requested_end: range.end,
      start_time: await probeStartTime(out),
      has_audio: await hasAudio(out),
      kind: range.kind ?? null,
      tag_offset: range.tagOffset ?? null,
    });
  }
  if (onProgress) onProgress({ done: ranges.length, total: ranges.length, message: '자르기 완료' });
  return clips;
}

/**
 * 클립들을 다듬어 하나로 합친다. merge.js 가 낸 명령을 순서대로 돌린다.
 *
 * @param o.clips      cutClips 가 낸 목록
 * @param o.workDir    조각을 구울 폴더
 * @param o.outPath    최종 mp4
 * @param o.intro      {imagePath, duration} 또는 null
 * @param o.scoreboard 점수판 설정 또는 null
 * @param o.sbImages   {"h:a": png경로} — 점수판 그림은 화면에서 그려 넘겨받는다
 * @param o.sbHasLogo  그 그림에 로고가 들어갔는가
 */
async function mergeClips(o) {
  const { clips, workDir, outPath, onProgress } = o;
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const video = await probeVideoDims(clips[0].path);

  const plan = planMerge({
    clips: clips.map((c) => ({
      path: c.path,
      // 브라우저는 키프레임까지만 자르므로 클립 앞에 여유가 붙는다. 그 여유분이
      // 요청 구간과 실제 시작점의 차이다.
      offset: Math.max(0, c.requested_start - c.start_time),
      length: c.requested_end - c.requested_start,
      hasAudio: c.has_audio,
      kind: c.kind,
      tagOffset: c.tag_offset,
    })),
    video,
    workDir,
    outPath,
    intro: o.intro || null,
    scoreboard: o.scoreboard || null,
    sbHasLogo: !!o.sbHasLogo,
    sbImage: (h, a) => {
      const found = o.sbImages && o.sbImages[`${h}:${a}`];
      if (!found) throw new Error(`점수판 그림이 없습니다 (${h}:${a})`);
      return found;
    },
  });

  // 이어 붙이기 목록은 조각을 다 구운 뒤에 쓴다(조각 이름만 적는다 — 경로에 한글이
  // 섞여도 concat 디먹서가 헷갈리지 않게 -safe 0 과 함께 상대 이름을 쓴다).
  const total = plan.commands.length;
  for (let i = 0; i < total; i += 1) {
    const cmd = plan.commands[i];
    if (cmd.args.includes('-f') && cmd.args.includes('concat')) {
      fs.writeFileSync(
        plan.concatList,
        plan.pieces.map((p) => `file '${path.basename(p)}'\n`).join(''),
        'utf8',
      );
    }
    if (onProgress) {
      onProgress({
        done: i, total,
        percent: Math.round((i / total) * 100),
        message: `${cmd.label} (${i + 1}/${total})`,
      });
    }
    try {
      await run(FFMPEG_BIN, cmd.args);
    } catch (err) {
      const tail = String(err.stderr || '').split(/\r?\n/).filter(Boolean).slice(-4).join(' / ');
      throw new Error(`${cmd.label} 실패 — ${tail || err.message}`);
    }
  }
  fs.rmSync(workDir, { recursive: true, force: true });
  if (onProgress) onProgress({ done: total, total, percent: 100, message: '완성' });
  return outPath;
}

module.exports = {
  cutClips,
  mergeClips,
  probeVideoDims,
  probeAudioCodec,
  hasAudio,
  FFMPEG_BIN,
  FFPROBE_BIN,
};
