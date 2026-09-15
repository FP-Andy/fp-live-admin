/** Proxies may return plain text or HTML instead of the API's JSON error. */
export async function responseError(response: Response, fallback: string): Promise<string> {
  if (response.status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
  if (response.status === 413) return '파일이 너무 큽니다. 5MB 이하의 파일을 선택해 주세요.';
  if (response.status >= 500) return '서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  try {
    const data = await response.json();
    if (typeof data?.detail === 'string') return data.detail;
  } catch { /* Use a readable fallback for non-JSON responses. */ }
  return fallback;
}
