const enc = new TextEncoder();
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const hourKey = () => new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jerusalem" }).slice(0, 13);
async function bump(env, key) {
  const row = await env.DB.prepare("INSERT INTO usage (key, n) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n").bind(key).first();
  return row.n;
}
const sessionToken = (env) => hmacHex(env.APP_PASSWORD, "workout-session-v1");
async function authed(env, req) {
  const m = /(?:^|;\s*)session=([0-9a-f]+)/.exec(req.headers.get("cookie") || "");
  return !!m && safeEqual(m[1], await sessionToken(env));
}
async function login(env, req) {
  const failKey = "loginfail:" + hourKey();
  const row = await env.DB.prepare("SELECT n FROM usage WHERE key = ?").bind(failKey).first();
  if (row && row.n >= 10) return json({ error: "too_many_attempts" }, 429);
  const body = await req.json().catch(() => ({}));
  const given = await hmacHex("pw-check", String(body.password ?? ""));
  const real = await hmacHex("pw-check", env.APP_PASSWORD);
  if (!safeEqual(given, real)) {
    await bump(env, failKey);
    return json({ error: "unauthorized" }, 401);
  }
  const token = await sessionToken(env);
  return json({ ok: true }, 200, {
    "set-cookie": `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000`
  });
}
const KEY_RE = /^[A-Za-z0-9:_.-]{1,128}$/;
const MAX_VALUE = 9e5;
const MAX_BODY = 1e6;
async function kvList(env) {
  const { results } = await env.DB.prepare("SELECT key, value, updated FROM kv ORDER BY key").all();
  return json({ items: results });
}
async function kvPut(env, req, key) {
  const text = await req.text();
  if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!body || typeof body.value !== "string" || !Number.isFinite(body.updated)) return json({ error: "bad_request" }, 400);
  if (body.value.length > MAX_VALUE) return json({ error: "too_large" }, 413);
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated WHERE excluded.updated >= kv.updated"
  ).bind(key, body.value, Math.trunc(body.updated)).run();
  return json({ ok: true });
}
export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    try {
      if (!env.APP_PASSWORD) return json({ error: "not_configured" }, 503);
      if (path === "/api/login" && req.method === "POST") return await login(env, req);
      if (!await authed(env, req)) return json({ error: "unauthorized" }, 401);
      if (path === "/api/kv" && req.method === "GET") return await kvList(env);
      const m = path.match(/^\/api\/kv\/([^/]+)$/);
      if (m && req.method === "PUT") {
        const key = decodeURIComponent(m[1]);
        if (!KEY_RE.test(key)) return json({ error: "bad_request" }, 400);
        return await kvPut(env, req, key);
      }
      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "server_error" }, 500);
    }
  }
};
