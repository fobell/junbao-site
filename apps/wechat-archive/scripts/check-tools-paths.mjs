// Read-only HTTP checks; use a fresh browser context separately for functional tests.
const origin = process.argv[2] ?? "https://tools.junbao.ai";
const cases = [
  ["/", 200],
  ["/wechat-article-archive?from=hub&lang=zh", 308],
  ["/wechat-article-archive/", 200],
  ["/wechat-article-archive/healthz", 200],
  ["/wechat-article-archive/api/v1/bootstrap/status", 200],
  ["/wechat-article-archive/api/v1/auth/me", 401],
  ["/wechat-article-archive/missing.js", 404],
  ["/healthz", 404],
  ["/api/v1/bootstrap/status", 404],
  ["/not-a-tool", 404],
];
for (const [path, status] of cases) {
  const r = await fetch(origin + path, {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  if (r.status !== status)
    throw new Error(`${path}: expected ${status}, got ${r.status}`);
  if (
    status === 308 &&
    r.headers.get("location") !== "/wechat-article-archive/?from=hub&lang=zh"
  )
    throw new Error("Redirect lost query parameters");
  if (
    path.startsWith("/wechat-article-archive/") &&
    !r.headers.get("cache-control")?.includes("no-store")
  )
    throw new Error("Private response can be cached");
  if (path === "/" && !(await r.text()).includes("钧宝工具箱"))
    throw new Error("Hub is missing");
  console.log(`${status} ${path}`);
}
