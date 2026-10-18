const REPO = "zynthec-dev/zloader-altsource";
const COOKIE = "__Host-zloader-admin";
const TTL = 8 * 60 * 60;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
const unhex = value => Uint8Array.from(value.match(/../g), b => parseInt(b, 16));
const random = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const digest = async value => hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const equal = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
};
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: {
  "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers,
} });
const cookie = (value, age = TTL) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`;

export async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", iterations: 100000,
    salt: unhex(salt) }, key, 256));
}

async function tokenCipher(value, secret, decrypt = false) {
  const key = await crypto.subtle.importKey("raw", unhex(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
  if (decrypt) {
    const [iv, body] = value.split(":");
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(iv) }, key, unhex(body)));
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `${hex(iv)}:${hex(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value)))}`;
}

async function github(path, token, options = {}) {
  return fetch(`https://api.github.com${path}`, { ...options, redirect: "error", headers: {
    "Accept": "application/vnd.github+json", ...(token ? { "Authorization": `Bearer ${token}` } : {}),
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "zLoader-Source-Admin",
    "Content-Type": "application/json",
  } });
}

async function session(request, db) {
  const value = request.headers.get("Cookie")?.split(";").map(v => v.trim())
    .find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  return db.prepare("SELECT s.hash FROM admin_sessions s JOIN admin_config c ON c.id=1 AND c.revision=s.revision WHERE s.hash=? AND s.expires>?")
    .bind(await digest(value), Math.floor(Date.now() / 1000)).first();
}

async function createSession(db, revision) {
  const value = random();
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("DELETE FROM admin_sessions WHERE expires<=?").bind(now),
    db.prepare("INSERT INTO admin_sessions(hash, revision, expires) VALUES(?,?,?)")
      .bind(await digest(value), revision, now + TTL),
  ]);
  return json({ authenticated: true }, 200, { "Set-Cookie": cookie(value) });
}

async function rateLimited(request, db) {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / 900);
  const ip = await digest(request.headers.get("CF-Connecting-IP") || "unknown");
  const statement = key => db.prepare("INSERT INTO admin_attempts(key,window,count) VALUES(?,?,1) ON CONFLICT(key,window) DO UPDATE SET count=count+1 RETURNING count")
    .bind(key, window);
  const result = await db.batch([
    db.prepare("DELETE FROM admin_attempts WHERE window<?").bind(window - 1),
    statement(ip), statement("global"),
  ]);
  return result[1].results[0].count > 8 || result[2].results[0].count > 100;
}

function permitted(path, method, body) {
  if (method === "GET") return /^\/(contents\/(catalog\/(content\.json|settings\.json|assets\/[a-zA-Z0-9._-]+\.png)|icon\.png)|git\/(ref\/heads\/main|commits\/[a-f0-9]{40})|releases\/tags\/[^/]+)$/.test(path);
  if (["PUT", "DELETE"].includes(method) && /^\/contents\/(catalog\/(content\.json|assets\/[a-zA-Z0-9._-]+\.png)|icon\.png)$/.test(path)) return body.branch === "main";
  if (method === "DELETE") return /^\/releases\/assets\/\d+$/.test(path);
  if (method === "PATCH" && path === "/git/refs/heads/main") return body.force === false && /^[a-f0-9]{40}$/.test(body.sha);
  if (method !== "POST") return false;
  if (path === "/git/blobs") return body.encoding === "base64";
  if (path === "/git/commits") return Array.isArray(body.parents) && body.parents.length === 1 && /^[a-f0-9]{40}$/.test(body.tree);
  if (path === "/git/trees") return Array.isArray(body.tree) && body.tree.length > 0 && body.tree.every(entry =>
    /^(catalog\/(content\.json|settings\.json|assets\/[a-zA-Z0-9._-]+\.png)|icon\.png)$/.test(entry.path)
    && entry.mode === "100644" && entry.type === "blob" && /^[a-f0-9]{40}$/.test(entry.sha));
  return false;
}

export async function adminAPI(request, env) {
  if (!env.ADMIN_DB || !/^[a-f0-9]{64}$/.test(env.ADMIN_ENCRYPTION_KEY || "")) {
    return json({ message: "Der Passwortzugang ist serverseitig noch nicht eingerichtet." }, 503);
  }
  const url = new URL(request.url);
  const route = url.pathname.slice("/admin/api/".length);
  const mutating = request.method !== "GET";
  if (mutating && (request.headers.get("Origin") !== url.origin || request.headers.get("X-Admin-Request") !== "1")) {
    return json({ message: "Nicht erlaubte Anfrage." }, 403);
  }
  const db = env.ADMIN_DB;
  try {
    const config = await db.prepare("SELECT * FROM admin_config WHERE id=1").first();
    const signedIn = config && await session(request, db);
    const connected = !!(env.GITHUB_TOKEN || config?.github_token);
    if (route === "status" && request.method === "GET") return json({ initialized: !!config, authenticated: !!signedIn, connected });
    if (route === "logout" && request.method === "POST") {
      if (signedIn) await db.prepare("DELETE FROM admin_sessions WHERE hash=?").bind(signedIn.hash).run();
      return json({ authenticated: false }, 200, { "Set-Cookie": cookie("", 0) });
    }
    if (["login", "password"].includes(route) && request.method === "POST") {
      if (route === "password" && !signedIn) return json({ message: "Bitte anmelden." }, 401);
      if (await rateLimited(request, db)) return json({ message: "Zu viele Versuche. Bitte in 15 Minuten erneut versuchen." }, 429, { "Retry-After": "900" });
      if (Number(request.headers.get("Content-Length") || 0) > 8192) return json({ message: "Anfrage zu groß." }, 413);
      const text = await request.text();
      if (text.length > 8192) return json({ message: "Anfrage zu groß." }, 413);
      const body = JSON.parse(text);
      if (typeof body.password !== "string" || body.password.length > 256) return json({ message: "Ungültiges Passwort." }, 400);
      if (route === "login") {
        if (!config || !equal(await passwordHash(body.password, config.salt), config.password_hash)) return json({ message: "Passwort ist nicht korrekt." }, 401);
        return createSession(db, config.revision);
      }
      if (body.password.length < 12) return json({ message: "Das neue Passwort muss mindestens 12 Zeichen lang sein." }, 400);
      const salt = random();
      const hash = await passwordHash(body.password, salt);
      if (typeof body.currentPassword !== "string" || body.currentPassword.length > 256
          || !equal(await passwordHash(body.currentPassword, config.salt), config.password_hash)) return json({ message: "Das aktuelle Passwort ist nicht korrekt." }, 401);
      const result = await db.prepare("UPDATE admin_config SET salt=?,password_hash=?,revision=revision+1 WHERE id=1 AND revision=?")
        .bind(salt, hash, config.revision).run();
      if (!result.meta.changes) return json({ message: "Der Zugang wurde inzwischen geändert. Bitte erneut anmelden." }, 409);
      await db.prepare("DELETE FROM admin_sessions").run();
      return createSession(db, config.revision + 1);
    }
    if (route.startsWith("github/") || route === "github") {
      if (!signedIn) return json({ message: "Bitte anmelden." }, 401);
      if (request.headers.get("X-Admin-Request") !== "1") return json({ message: "Nicht erlaubte Anfrage." }, 403);
      const path = route.slice("github".length);
      const bodyText = mutating ? await request.text() : undefined;
      const body = bodyText ? JSON.parse(bodyText) : {};
      if (!permitted(path, request.method, body)) return json({ message: "Dieser Zugriff ist nicht Teil der App-Verwaltung." }, 403);
      if (!connected) {
        if (request.method !== "GET") return json({ message: "Speichern ist noch nicht verfügbar: Die Repository-Verbindung muss serverseitig eingerichtet werden." }, 503);
        // Public catalog viewing does not require a credential or a rate-limited API lookup.
        if (/^\/contents\/catalog\/(content|settings)\.json$/.test(path)) {
          const ref = url.searchParams.get("ref") || "main";
          if (!/^(main|[a-f0-9]{40})$/.test(ref)) return json({ message: "Ungültiger Stand." }, 400);
          const raw = await fetch(`https://raw.githubusercontent.com/${REPO}/${ref}${path.slice("/contents".length)}`);
          if (!raw.ok) return json({ message: "Der Katalog konnte nicht geladen werden." }, raw.status);
          const bytes = new Uint8Array(await raw.arrayBuffer());
          const header = encoder.encode(`blob ${bytes.length}\0`);
          const blob = new Uint8Array(header.length + bytes.length);
          blob.set(header); blob.set(bytes, header.length);
          const sha = hex(await crypto.subtle.digest("SHA-1", blob));
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          return json({ sha, content: btoa(binary), encoding: "base64" });
        }
      }
      const token = env.GITHUB_TOKEN || (config.github_token ? await tokenCipher(config.github_token, env.ADMIN_ENCRYPTION_KEY, true) : "");
      const upstream = await github(`/repos/${REPO}${path}${url.search}`, token, { method: request.method, body: bodyText });
      return new Response(upstream.body, { status: upstream.status, headers: {
        "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      } });
    }
    return json({ message: "Nicht gefunden." }, 404);
  } catch {
    return json({ message: "Die Anfrage konnte nicht verarbeitet werden. Bitte erneut versuchen." }, 500);
  }
}
