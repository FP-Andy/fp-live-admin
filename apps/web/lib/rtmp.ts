// 송출 주소의 정본은 서버 설정이다. 축구는 경기별 metadata.rtmp.server_url(게이트웨이
// GATEWAY_PUBLIC_RTMP_SERVER), 농구는 녹화 응답의 server_url(RECORDING_RTMP_PUBLIC_BASE)을
// 그대로 쓴다. 미디어 서버 IP가 바뀌어도 웹을 다시 빌드하지 않게 하기 위해서다.
//
// 아래 값은 응답에 주소가 아직 없을 때(목록이 비었거나 불러오는 중)만 보여 주는 기본값이다.
// 지금 운영 값과 같게 두어 화면 동작은 그대로다.
export const DEFAULT_RTMP_SERVER = 'rtmp://3.227.35.90:1935/live';

const STREAM_DNS_ALIAS = /^rtmp:\/\/stream\.fineludens\.kr(?::1935)?\/live\/?$/i;

// DNS 별칭(stream.fineludens.kr)도 같은 서버로 가지만, 운영자에게는 축구와 같은 한 가지
// 주소를 보여 준다. 별칭이 아닌 주소(직접 지정한 값 포함)는 바꾸지 않는다.
export function rtmpServerAddress(value: string | null | undefined, canonical: string = DEFAULT_RTMP_SERVER): string {
  const address = (value || '').trim();
  if (!address) return '';
  return STREAM_DNS_ALIAS.test(address) ? canonical : address;
}

// 여러 경기 응답 중 서버가 준 첫 주소를 공통 주소로 쓴다. 하나도 없을 때만 기본값.
export function sharedRtmpServer(values: Array<string | null | undefined>): string {
  const first = values.map(value => (value || '').trim()).find(value => value && !STREAM_DNS_ALIAS.test(value));
  return first || DEFAULT_RTMP_SERVER;
}
