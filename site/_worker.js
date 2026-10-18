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
    if (source && path === "/") path = "/source.json";
    else if (admin) {
      if (path.startsWith("/api/")) {
        url.pathname = "/admin" + path;
        return adminAPI(new Request(url, request), env);
      }
      if (path === "/") path = "/admin/";
      else if (["/admin.css", "/base.css", "/admin.js"].includes(path)) path = "/admin" + path;
      else return new Response("Not found", { status: 404 });
    } else if (home) {
      if (preview && path.startsWith("/api/")) {
        url.pathname = "/admin" + path;
        return adminAPI(new Request(url, request), env);
      }
      if (preview && path === "/admin") return Response.redirect(url.origin + "/admin/", 308);
      if (preview && (path.startsWith("/admin/") || ["/admin.css", "/base.css", "/admin.js"].includes(path))) {
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
