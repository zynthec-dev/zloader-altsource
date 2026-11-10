// One Pages deployment, with separate public, source and admin hosts.
import { adminAPI } from "./admin-api.js";
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;
    const source = host === "source.zloader.de";
    const admin = host === "admin.zloader.de";
    const preview = host.endsWith(".pages.dev") || ["localhost", "127.0.0.1"].includes(host);
    const home = host === "zloader.de" || preview;
    let path = url.pathname;
    if ((source || preview) && path === "/install/manifest.plist") return installationManifest(request);
    if (source && path === "/") path = "/source.json";
    else if (admin) {
      if (path.startsWith("/api/")) {
        url.pathname = "/admin" + path;
        return adminAPI(new Request(url, request), env);
      }
      if (path === "/") path = "/admin/";
      else if (["/admin.css", "/base.css", "/admin.js", "/ipa-upload.js"].includes(path)) path = "/admin" + path;
      else return new Response("Not found", { status: 404 });
    } else if (home) {
      if (preview && path.startsWith("/api/")) {
        url.pathname = "/admin" + path;
        return adminAPI(new Request(url, request), env);
      }
      if (preview && path === "/admin") return Response.redirect(url.origin + "/admin/", 308);
      if (preview && (path.startsWith("/admin/") || ["/admin.css", "/base.css", "/admin.js", "/ipa-upload.js"].includes(path))) {
        if (!path.startsWith("/admin/")) path = "/admin" + path;
      } else if (path === "/") path = "/zloader/";
      else if (["/site.css", "/site.js"].includes(path)) path = "/zloader" + path;
      else return new Response("Not found", { status: 404 });
    } else if (!source) return new Response("Not found", { status: 404 });
    if (source && path !== "/source.json" && !path.startsWith("/assets/")) return new Response("Not found", { status: 404 });
    const feed = source && path === "/source.json";
    if (feed && request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    } });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: feed ? "GET, HEAD, OPTIONS" : "GET, HEAD" } });
    url.pathname = path;
    const asset = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(asset.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    if (feed) {
      headers.set("Content-Type", "application/json; charset=utf-8");
      headers.set("Cache-Control", "public, max-age=60, must-revalidate");
      headers.set("Access-Control-Allow-Origin", "*");
    }
    if (path.startsWith("/admin/")) {
      headers.set("Cache-Control", "no-cache");
      headers.set("X-Frame-Options", "DENY");
      headers.set("Content-Security-Policy", "frame-ancestors 'none'");
      headers.set("Referrer-Policy", "same-origin");
    }
    return new Response(asset.body, { status: asset.status, headers });
  },
};

// A trusted HTTPS manifest for a tokenized IPA served only on the receiving
// device's loopback interface. No fetch, upload, storage, certificate or key.
function installationManifest(request) {
  const headers = { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, {status: 405, headers: {...headers, Allow: "GET, HEAD"}});
  const fail = () => new Response(request.method === "HEAD" ? null : "Invalid manifest request", {status: 400,
    headers: {...headers, "Content-Type": "text/plain; charset=utf-8"}});
  const params = new URL(request.url).searchParams;
  const keys = ["url", "bundleid", "version", "name"];
  if ([...params.keys()].some(key => !keys.includes(key)) || keys.some(key => params.getAll(key).length !== 1)) return fail();
  const [payload, bundle, version, name] = keys.map(key => params.get(key));
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/app\.ipa$/.test(payload)) return fail();
  try { const local = new URL(payload); if (!local.port || Number(local.port) > 65535 || local.hostname !== "127.0.0.1") return fail(); } catch { return fail(); }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(bundle) || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) return fail();
  if (!name.trim() || name.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(name)) return fail();
  const xml = value => value.replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[ch]));
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
<key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${xml(payload)}</string></dict></array>
<key>metadata</key><dict><key>bundle-identifier</key><string>${xml(bundle)}</string><key>bundle-version</key><string>${xml(version)}</string><key>kind</key><string>software</string><key>title</key><string>${xml(name)}</string></dict>
</dict></array></dict></plist>`;
  return new Response(request.method === "HEAD" ? null : body, {status: 200, headers});
}
