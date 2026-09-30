import { PDFDocument } from 'pdf-lib';

export const REPORT_WIDTH = 900;
export const REPORT_HEIGHT = REPORT_WIDTH * 297 / 210;
let fonts:Promise<string>|null=null;
export function reportFontCSS(){
  return fonts??=fetch('/scene/Giants-Bold.ttf').then(async r=>{
    if(!r.ok)throw Error('리포트 글꼴을 불러오지 못했습니다.');
    const bytes=new Uint8Array(await r.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return `@font-face{font-family:Giants;src:url(data:font/ttf;base64,${btoa(binary)}) format('truetype');font-weight:700;}`;
  }).catch(e=>{fonts=null;throw e;});
}

// A single rasterized sheet preserves Korean text, canvas maps, and transparent
// club crests identically to the editor without platform-dependent PDF fonts.
export async function reportPDF(png: string|string[], title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('Fine Play Console');
  for(const source of typeof png==='string'?[png]:png){
    const page = pdf.addPage([210 * 72 / 25.4, 297 * 72 / 25.4]);
    const image = await pdf.embedPng(source);
    page.drawImage(image, {x: 0, y: 0, width: page.getWidth(), height: page.getHeight()});
  }
  return pdf.save();
}

export function reportOverflow(sheet: HTMLElement): string[] {
  return Array.from(sheet.querySelectorAll<HTMLElement>('[data-report-text]'))
    .filter(node => node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)
    .map(node => node.dataset.reportText || '리포트 문구');
}
