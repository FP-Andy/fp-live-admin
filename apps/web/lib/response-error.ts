import { errorFromResponse, type ErrorOptions } from './error-messages';

/**
 * Proxies may return plain text or HTML instead of the API's JSON error.
 * 서버 detail 을 꺼내 lib/error-messages 변환표를 거친 한국어를 돌려준다.
 * 원문(상태 코드·본문)은 ErrorNotice 의 "자세히"에서 볼 수 있게 기억해 둔다.
 */
export async function responseError(response: Response, fallback: string, options: Omit<ErrorOptions, 'fallback'> = {}): Promise<string> {
  if (response.status === 401) return (await errorFromResponse(response, { ...options, fixed: '로그인이 만료되었습니다. 다시 로그인해 주세요.' })).message;
  if (response.status === 413) return (await errorFromResponse(response, { ...options, fixed: '파일이 너무 큽니다. 5MB 이하의 파일을 선택해 주세요.' })).message;
  return (await errorFromResponse(response, { ...options, fallback })).message;
}
