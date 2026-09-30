import { PDFDocument } from 'pdf-lib';

export const REPORT_WIDTH = 900;
export const REPORT_HEIGHT = REPORT_WIDTH * 297 / 210;

// A single rasterized sheet preserves Korean text, canvas maps, and transparent
// club crests identically to the editor without platform-dependent PDF fonts.
export async function reportPDF(png: string, title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('Fine Play Console');
  const page = pdf.addPage([210 * 72 / 25.4, 297 * 72 / 25.4]);
  const image = await pdf.embedPng(png);
  page.drawImage(image, {x: 0, y: 0, width: page.getWidth(), height: page.getHeight()});
  return pdf.save();
}

export function reportOverflow(sheet: HTMLElement): string[] {
  return Array.from(sheet.querySelectorAll<HTMLElement>('[data-report-text]'))
    .filter(node => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)
    .map(node => node.dataset.reportText || '리포트 문구');
}
