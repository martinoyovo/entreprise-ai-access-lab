/** Minimal HTML error page for browser-facing auth routes. Details go to the server log only. */
export function authError(status: number, message: string) {
  const html = `<!doctype html><title>Sign-in failed</title><body style="font-family:system-ui;margin:40px">
<h1>Sign-in failed</h1><p>${message}</p><p><a href="/">Back</a></p></body>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || null;
}
