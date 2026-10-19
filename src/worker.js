const enc = new TextEncoder();
// API answers carry personal data: never cached, never sniffed as another type
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers } });
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
// Failed logins are limited per device (IP) — 10 an hour — so a stranger guessing cannot lock the owner out,
// plus a global ceiling of 50 an hour against guessing from many addresses.
const FAIL_PER_IP = 10, FAIL_ALL = 50;
async function count(env, key) {
  const row = await env.DB.prepare("SELECT n FROM usage WHERE key = ?").bind(key).first();
  return row ? row.n : 0;
}
async function login(env, req) {
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const allKey = "loginfail:" + hourKey(), ipKey = allKey + ":" + ip;
  if (await count(env, ipKey) >= FAIL_PER_IP || await count(env, allKey) >= FAIL_ALL) return json({ error: "too_many_attempts" }, 429);
  const body = await req.json().catch(() => ({}));
  const given = await hmacHex("pw-check", String(body.password ?? ""));
  const real = await hmacHex("pw-check", env.APP_PASSWORD);
  if (!safeEqual(given, real)) {
    await bump(env, ipKey);
    await bump(env, allKey);
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
  // A time in the future would win every later write (a wrong phone clock, or someone with a stolen session
  // dating junk to the year 3000): clamp to now, and let a row already dated in the future be overwritten.
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated WHERE excluded.updated >= kv.updated OR kv.updated > ?"
  ).bind(key, body.value, Math.min(Math.trunc(body.updated), now), now).run();
  return json({ ok: true });
}
// Cloud backups: full snapshots (gzip + base64, made by the app) in their own table, never touched by
// the key/value sync, so a bad value that syncs cannot overwrite them. The newest BACKUP_KEEP are kept.
// A stolen session must not be able to push every good backup out with junk: at most BACKUP_PER_DAY new
// backups a day, and besides the newest BACKUP_KEEP the newest backup older than 7 days and older than 30 days
// are always kept (new backups can never be dated in the past).
const BACKUP_KEEP = 12, BACKUP_PER_DAY = 4, DAY_MS = 864e5;
const MAX_BACKUP = 1.9e6; // D1 rows are limited to 2 MB
async function ensureBackups(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, created INTEGER NOT NULL, size INTEGER NOT NULL, keys INTEGER NOT NULL, data TEXT NOT NULL)"
  ).run();
}
async function backupCreate(env, req) {
  const text = await req.text();
  if (text.length > MAX_BACKUP) return json({ error: "too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!body || typeof body.data !== "string" || !Number.isFinite(body.size) || !Number.isFinite(body.keys)) return json({ error: "bad_request" }, 400);
  await ensureBackups(env);
  const dayKey = "backup:" + hourKey().slice(0, 10);
  if (await count(env, dayKey) >= BACKUP_PER_DAY) return json({ error: "too_many_backups" }, 429);
  await bump(env, dayKey);
  const row = await env.DB.prepare("INSERT INTO backups (created, size, keys, data) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(Date.now(), Math.trunc(body.size), Math.trunc(body.keys), body.data).first();
  const now = Date.now();
  await env.DB.prepare(
    "DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY created DESC, id DESC LIMIT ?)" +
    " AND id NOT IN (SELECT id FROM backups WHERE created < ? ORDER BY created DESC, id DESC LIMIT 1)" +
    " AND id NOT IN (SELECT id FROM backups WHERE created < ? ORDER BY created DESC, id DESC LIMIT 1)"
  ).bind(BACKUP_KEEP, now - 7 * DAY_MS, now - 30 * DAY_MS).run();
  return json({ ok: true, id: row.id });
}
async function backupList(env) {
  await ensureBackups(env);
  const { results } = await env.DB.prepare("SELECT id, created, size, keys FROM backups ORDER BY created DESC, id DESC").all();
  return json({ items: results });
}
async function backupGet(env, id) {
  await ensureBackups(env);
  const row = await env.DB.prepare("SELECT id, created, data FROM backups WHERE id = ?").bind(id).first();
  return row ? json(row) : json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    try {
      if (!env.APP_PASSWORD) return json({ error: "not_configured" }, 503);
      if (path === "/api/login" && req.method === "POST") return await login(env, req);
      if (!await authed(env, req)) return json({ error: "unauthorized" }, 401);
      if (path === "/api/kv" && req.method === "GET") return await kvList(env);
      if (path === "/api/backups" && req.method === "GET") return await backupList(env);
      if (path === "/api/backups" && req.method === "POST") return await backupCreate(env, req);
      const b = path.match(/^\/api\/backups\/(\d+)$/);
      if (b && req.method === "GET") return await backupGet(env, Number(b[1]));
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
