// The football gateway advertises this fixed ingress address. The DNS alias
// reaches the same server, but operators should receive one consistent value.
export const RTMP_SERVER = 'rtmp://3.227.35.90:1935/live';

export function rtmpServerAddress(value: string): string {
  return value.replace(/^rtmp:\/\/stream\.fineludens\.kr(?::1935)?\/live\/?$/i, RTMP_SERVER);
}
