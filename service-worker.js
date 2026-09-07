function offlineResponse() {
  return new Response(`<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>הדוח אינו זמין כעת</title>
<style>
body{margin:0;font:16px/1.6 Heebo,"Noto Sans Hebrew",Tahoma,sans-serif;background:#f4f5f7;color:#24272c;display:grid;place-items:center;min-height:100vh;padding:24px}
main{max-width:32rem;background:#fff;border:1px solid #d9dde2;border-radius:16px;padding:24px;box-shadow:0 16px 40px rgb(36 39 44 / 0.08)}
h1{margin:0 0 12px;font-size:1.4rem}p{margin:0 0 12px}button{min-height:44px;padding:10px 16px;border:1px solid #23734e;border-radius:999px;background:#23734e;color:#fff;font:inherit;cursor:pointer}
</style>
</head>
<body>
<main>
<h1>הדוח אינו זמין כעת</h1>
<p>החיבור לרשת נכשל או שהאתר אינו זמין כרגע. הדף הזה אינו מציג עותק ישן של דוח.</p>
<button type="button" onclick="location.reload()">נסה שוב</button>
</main>
</body>
</html>`, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

addEventListener('fetch', (event) => {
  const request = event.request;
  if (!request || request.method !== 'GET' || request.mode !== 'navigate') return;

  let requestUrl;
  let scopeUrl;
  try {
    requestUrl = new URL(request.url);
    scopeUrl = new URL(registration.scope);
  } catch {
    return;
  }

  if (requestUrl.origin !== scopeUrl.origin) return;
  if (!requestUrl.pathname.startsWith(scopeUrl.pathname)) return;

  event.respondWith(
    fetch(request.url, { cache: 'no-store' }).catch(() => offlineResponse())
  );
});