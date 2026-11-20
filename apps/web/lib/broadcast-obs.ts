export const OBS_ITEMS: [string, string][] = [
  ['공격방향 홈', 'live/attack-direction-home'],
  ['공격방향 어웨이', 'live/attack-direction-away'],
  ['점유율', 'live/possession'],
  ['슈팅', 'live/shots-comparison'],
  ['xG', 'live/xg-comparison'],
  ['매치 도미넌스 전반', 'dominance/halftime'],
  ['매치 도미넌스 전체', 'dominance/fulltime'],
];

export function obsUrl(matchOrChannel: string, locator: string, origin: string) {
  return `${origin.replace(/\/$/, '')}/overlay/${encodeURIComponent(matchOrChannel)}/${locator}`;
}

export function obsList(matchOrChannel: string, origin: string) {
  return OBS_ITEMS.map(([label, path]) => `${label}\n${obsUrl(matchOrChannel, path, origin)}`).join('\n\n');
}
