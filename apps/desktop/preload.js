'use strict';
/**
 * 화면(렌더러)과 앱(메인) 사이의 유일한 통로.
 *
 * 화면 코드는 `window.fhlLocal` 이 있으면 '로컬 앱 안' 이라고 판단하고, 서버로
 * 보내던 것들(잡 만들기·클립 올리기·합치기)을 여기로 돌린다. 없으면 지금까지처럼
 * 서버로 간다 — 그래서 콘솔과 앱이 같은 화면 코드 한 벌을 쓴다.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('fhlLocal', {
  info: () => ipcRenderer.invoke('local:info'),
  reveal: (filePath) => ipcRenderer.invoke('local:reveal', filePath),

  /**
   * <input type="file"> 로 고른 파일의 실제 경로.
   * 원본은 수 GB 라 브라우저처럼 메모리로 읽어서는 안 되고, ffmpeg 에 경로로 넘긴다.
   */
  pathForFile: (file) => webUtils.getPathForFile(file),

  /** 새 작업 자리를 만든다. 클립·조각·결과가 다 여기 들어간다. */
  createJob: () => ipcRenderer.invoke('local:createJob'),

  /** 태그 구간들을 잘라 클립 파일로. ranges: [{sourceIndex,start,end,kind,tagOffset}] */
  cut: (jobId, sources, ranges) => ipcRenderer.invoke('local:cut', { jobId, sources, ranges }),

  /** 점수판 그림들을 저장한다. images: {"홈:원정": dataURL} → {"홈:원정": 파일경로} */
  saveScoreboards: (jobId, images) => ipcRenderer.invoke('local:saveScoreboards', { jobId, images }),

  /** 인트로 사진을 저장한다. dataURL → 파일경로 */
  saveIntro: (jobId, dataUrl) => ipcRenderer.invoke('local:saveIntro', { jobId, dataUrl }),

  /** 클립들을 다듬어 하나로 합친다. 완성된 mp4 경로를 돌려준다. */
  merge: (jobId, options) => ipcRenderer.invoke('local:merge', { jobId, options }),

  /** 진행 상황 구독. 돌려주는 함수를 부르면 구독을 끊는다. */
  onProgress: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('local:progress', listener);
    return () => ipcRenderer.removeListener('local:progress', listener);
  },
});
