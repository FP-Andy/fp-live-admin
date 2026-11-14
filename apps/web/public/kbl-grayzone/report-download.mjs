function filenamePart(value, fallback) {
  return String(value ?? '').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
}

export function reportFilename(match) {
  let number = filenamePart(match.gameNumber, '미확인');
  if (/^\d+$/.test(number)) number = number.padStart(3, '0');
  const home = filenamePart(match.home, '홈팀');
  const away = filenamePart(match.away, '원정팀');
  return `KBL 경기${number} ${home} vs ${away} - 경기 판독 리포트.pdf`;
}

// Blob downloads also work with local servers started before the filename-header change.
export function bindReportDownload(link, caseId, onError) {
  link.addEventListener('click', async event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    try {
      const [matchResponse, pdfResponse] = await Promise.all([
        fetch(`/api/cases/${encodeURIComponent(caseId)}`), fetch(link.href)
      ]);
      if (!matchResponse.ok || !pdfResponse.ok) throw Error('경기 정보 또는 PDF를 불러오지 못했습니다.');
      const match = await matchResponse.json();
      const url = URL.createObjectURL(await pdfResponse.blob());
      const download = document.createElement('a');
      download.href = url;
      download.download = reportFilename(match);
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { onError(error.message); }
  });
}
