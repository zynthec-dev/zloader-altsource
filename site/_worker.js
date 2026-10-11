// Cloudflare Pages: public zLoader site, JSON source and password-only admin.
import { adminAPI } from "./admin-api.js";
const PREFIX = "/zloader";
const CANONICAL = "https://zynthec.com" + PREFIX;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Transitional compatibility for the Source URL embedded in zLoader 0.7.50.
    // Remove the old custom domain after the app has migrated, not before.
    if (url.hostname === "zloader.zynthec.com") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      if (url.pathname === "/" || url.pathname === "/source.json") return Response.redirect(CANONICAL + "/source.json" + url.search, 308);
      if (url.pathname.startsWith("/assets/") || url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return Response.redirect(CANONICAL + url.pathname + url.search, 308);
      return new Response("Not found", { status: 404 });
    }
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + "/")) {
      return new Response("Not found", { status: 404 });
    }
    let path = url.pathname.slice(PREFIX.length) || "/";
    if (path === "/admin") return Response.redirect(CANONICAL + "/admin/" + url.search, 308);
    // Fetch the directory, not index.html: Pages redirects index.html to its
    // pretty URL, which would otherwise loop when requested through this alias.
    if (path === "/") path = "/zloader/";
    if (path === "/site.css" || path === "/site.js") path = "/zloader" + path;
    url.pathname = path;
    const internal = new Request(url, request);
    if (path.startsWith("/admin/api/")) return adminAPI(internal, env);
    if (path !== "/source.json") {
      if (!path.startsWith("/assets/") && !path.startsWith("/admin/") && !["/zloader/", "/zloader/site.css", "/zloader/site.js"].includes(path)) return new Response("Not found", { status: 404 });
      const asset = await env.ASSETS.fetch(internal);
      const headers = new Headers(asset.headers);
      headers.set("X-Content-Type-Options", "nosniff");
      if (path.startsWith("/admin/")) {
        headers.set("Cache-Control", "no-cache");
        headers.set("X-Frame-Options", "DENY");
        headers.set("Content-Security-Policy", "frame-ancestors 'none'");
        headers.set("Referrer-Policy", "same-origin");
      }
      return new Response(asset.body, { status: asset.status, headers });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
    }
    url.pathname = "/source.json";
    const asset = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(asset.headers);
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=60, must-revalidate");
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(asset.body, { status: asset.status, headers });
  },
};
