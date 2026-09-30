// Supplied Queen Cup club assets. Keep Seoul and Seoul E-Land distinct.
const logos: Record<string, string> = {
  강원: 'gangwon', 경남: 'gyeongnam', 광주: 'gwangju', 김천: 'gimcheon',
  김포: 'gimpo', 김해: 'gimhae', 대구: 'daegu', 대전: 'daejeon', 부산: 'busan',
  부천: 'bucheon', 서울: 'seoul', 서울이랜드: 'seoul-eland', 성남: 'seongnam',
  수원fc: 'suwon-fc', 수원삼성: 'suwon-samsung', 안산: 'ansan', 안양: 'anyang',
  울산: 'ulsan', 인천: 'incheon', 전남: 'jeonnam', 전북: 'jeonbuk', 제주: 'jeju',
  천안: 'cheonan', 청주: 'cheongju', 충남아산: 'asan', 포항: 'pohang', 화성: 'hwaseong',
};
export function teamLogo(name: string): string | null {
  let key = name.normalize('NFC').toLowerCase().replace(/[\s·._-]/g, '');
  key = key.replace(/^fc/, '');
  if (key !== '수원fc') key = key.replace(/fc$/, '');
  key = ({서울e: '서울이랜드', 김천상무: '김천', 충북청주: '청주'} as Record<string, string>)[key] || key;
  const file = logos[key];
  return file ? `/team-logos/queen-cup/${file}.${file === 'gimhae' ? 'svg' : 'png'}` : null;
}
