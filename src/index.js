// Cloudflare Worker — 정적 자산 서빙 + (선택) Basic Auth 잠금
// 시크릿 BASIC_USER / BASIC_PASS 가 둘 다 설정되어 있을 때만 잠근다.
// 파이보 랩과 같은 방식이다.

export default {
  async fetch(request, env) {
    if (env.BASIC_USER && env.BASIC_PASS) {
      const denied = checkAuth(request, env);
      if (denied) return denied;
    }
    return env.ASSETS.fetch(request);
  },
};

function checkAuth(request, env) {
  const h = request.headers.get('Authorization') || '';
  if (h.startsWith('Basic ')) {
    try {
      const [user, pass] = atob(h.slice(6)).split(':');
      if (user === env.BASIC_USER && pass === env.BASIC_PASS) return null;
    } catch (e) { /* 무시 */ }
  }
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="gesture-lab"' },
  });
}
