const $ = (selector, root = document) => root.querySelector(selector);
const escapeHTML = value => String(value ?? "").replace(/[&<>'"]/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[character]);

const BRANCH = "main";
const API_ROOT = new URL("./api/", import.meta.url).pathname.replace(/\/$/, "");
const state = { content: null, file: null, edit: null, settings: null, settingsFile: null, sourceSaving: false, iconPreview: null, sourceDraftPreview: null };
const sourceFields = [
  ["name", "Anzeigename", "text"],
  ["subtitle", "Kurzbeschreibung", "text"],
  ["description", "Beschreibung", "textarea"],
  ["tintColor", "Akzentfarbe", "color"]
];
const editableFields = [
  ["name", "App-Name", "text"],
  ["developerName", "Entwickler", "text"],
  ["subtitle", "Kurzbeschreibung", "text"],
  ["localizedDescription", "Ausführliche Beschreibung", "textarea"],
  ["category", "Kategorie", "select"],
  ["tintColor", "Akzentfarbe", "color"],
  ["marketingVersion", "Angezeigte Version", "text"],
  ["versionDescription", "Neu in dieser Version", "textarea"],
  ["screenshots", "Screenshot-URLs (eine pro Zeile)", "textarea"]
];

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, options = {}) {
  const response = await fetch(`${API_ROOT}/github${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-Admin-Request": "1",
      ...(typeof options.body === "string" ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    let message = `GitHub ${response.status}`;
    try { message = (await response.json()).message || message; } catch {}
    throw new ApiError(message, response.status);
  }
  return response.status === 204 ? null : response.json();
}

function decode(data) {
  const bytes = Uint8Array.from(atob(data.replace(/\n/g, "")), character => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function encodeBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

function encodeJSON(data) {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(data, null, 2) + "\n"));
}

async function load() {
  [state.file, state.settingsFile] = await Promise.all([
    api(`/contents/catalog/content.json?ref=${encodeURIComponent(BRANCH)}`),
    api(`/contents/catalog/settings.json?ref=${encodeURIComponent(BRANCH)}`)
  ]);
  state.content = decode(state.file.content);
  state.settings = decode(state.settingsFile.content);
  state.content.localApps ||= {};
  state.content.uploadedApps ||= [];
  render();
  renderSource();
}

function renderSource(iconURL = state.settings.iconURL) {
  $("#sourceName").textContent = state.settings.name;
  $("#brandName").textContent = state.settings.name;
  $("#sourceSubtitle").textContent = state.settings.subtitle || state.settings.description || "";
  $("#sourceColor").style.backgroundColor = state.settings.tintColor;
  $("#sourceColor").title = state.settings.tintColor;
  $("#sourceIcon").src = iconURL;
  $("#brandIcon").src = iconURL;
}

function openSourceEditor() {
  $("#sourceFields").innerHTML = sourceFields.map(args => field(state.settings, ...args)).join("");
  $("#sourceForm").reset();
  $("#sourceIconPreview").src = $("#sourceIcon").src;
  $("#sourceStatus").textContent = "";
  $("#sourceEditor").showModal();
}

async function saveSource() {
  if (state.sourceSaving) return;
  const form = new FormData($("#sourceForm"));
  const settings = structuredClone(state.settings);
  for (const [key] of sourceFields) settings[key] = String(form.get(key) || "").trim();
  const icon = form.get("icon");
  state.sourceSaving = true;
  $("#sourceForm").querySelectorAll("button, input, textarea").forEach(element => { element.disabled = true; });
  $("#sourceStatus").textContent = "Source wird gespeichert …";
  try {
    if (!settings.name) throw new Error("Bitte einen Anzeigenamen eingeben.");
    if (!/^#[0-9a-f]{6}$/i.test(settings.tintColor)) throw new Error("Bitte eine gültige Akzentfarbe auswählen.");
    let iconBytes;
    if (icon?.size) {
      if (icon.size > 2_000_000) throw new Error("Das Source-Icon darf maximal 2 MB groß sein.");
      iconBytes = new Uint8Array(await icon.arrayBuffer());
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => iconBytes[index] === byte)) throw new Error("Bitte ein gültiges PNG-Bild auswählen.");
      try { const image = await createImageBitmap(icon); image.close(); }
      catch { throw new Error("Das PNG-Bild konnte nicht gelesen werden."); }
    }
    // Use one commit for settings and icon so deployment never sees a partial update.
    const head = await api(`/git/ref/heads/${BRANCH}`);
    const latest = await api(`/contents/catalog/settings.json?ref=${head.object.sha}`);
    if (latest.sha !== state.settingsFile.sha) throw new Error("Die Source wurde inzwischen geändert. Bitte neu laden und deine Änderungen erneut eingeben.");
    const parent = await api(`/git/commits/${head.object.sha}`);
    const settingsBlob = await api("/git/blobs", { method: "POST", body: JSON.stringify({ content: encodeJSON(settings), encoding: "base64" }) });
    const tree = [{ path: "catalog/settings.json", mode: "100644", type: "blob", sha: settingsBlob.sha }];
    if (iconBytes) {
      const blob = await api("/git/blobs", { method: "POST", body: JSON.stringify({ content: encodeBytes(iconBytes), encoding: "base64" }) });
      tree.push({ path: "icon.png", mode: "100644", type: "blob", sha: blob.sha });
    }
    const createdTree = await api("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: parent.tree.sha, tree }) });
    const commit = await api("/git/commits", { method: "POST", body: JSON.stringify({ message: "admin: update source settings", tree: createdTree.sha, parents: [head.object.sha] }) });
    await api(`/git/refs/heads/${BRANCH}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
    state.settings = settings;
    state.settingsFile.sha = settingsBlob.sha;
    if (iconBytes) {
      if (state.iconPreview) URL.revokeObjectURL(state.iconPreview);
      state.iconPreview = URL.createObjectURL(icon);
    }
    renderSource(state.iconPreview || settings.iconURL);
    $("#sourceEditor").close();
    toast("Source gespeichert – Veröffentlichung läuft");
  } catch (error) {
    $("#sourceStatus").textContent = error.status === 409 || error.status === 422
      ? "Inzwischen wurde eine andere Änderung gespeichert. Bitte neu laden und erneut versuchen."
      : error.message;
  } finally {
    state.sourceSaving = false;
    $("#sourceForm").querySelectorAll("button, input, textarea").forEach(element => { element.disabled = false; });
  }
}

function isPinned(record) {
  return record.kind === "local" && (state.content.pinnedBundleIdentifiers || []).includes(record.key);
}

function records() {
  const local = Object.entries(state.content.localApps).map(([key, app]) => ({ kind: "local", key, app }));
  const uploaded = state.content.uploadedApps.map((app, index) => ({ kind: "uploaded", key: index, app }));
  return [...local, ...uploaded].sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || (a.app.name || "").localeCompare(b.app.name || ""));
}

function render() {
  const apps = records();
  $("#appsList").innerHTML = apps.map(({ kind, key, app }) => `<button type="button" class="admin-item" data-kind="${kind}" data-key="${escapeHTML(key)}"><span class="admin-item-mark" aria-hidden="true">IPA</span><span class="admin-item-copy"><span class="item-title">${escapeHTML(app.name || app.ipaFile || key)}</span><span class="item-description">${escapeHTML(app.marketingVersion ? `Version ${app.marketingVersion} · ` : "")}${escapeHTML(app.ipaFile || key)}</span>${app.pendingUpload ? '<span class="pin-label">Veröffentlichung läuft</span>' : ""}</span><span class="chevron" aria-hidden="true">›</span></button>`).join("") || '<div class="empty-shot">Noch keine Apps. Über „App hochladen“ kannst du die erste IPA hinzufügen.</div>';
}

function defaultApp() {
  return { name: "", developerName: "zynthec", subtitle: "", localizedDescription: "", category: "utilities", tintColor: "#147D60", marketingVersion: "", versionDescription: "", screenshots: [], ipaFile: "" };
}

function field(app, key, label, type) {
  const value = key === "screenshots" ? (app.screenshots || []).map(item => typeof item === "string" ? item : item.imageURL).join("\n") : app[key] || "";
  if (type === "textarea") return `<label class="field">${label}<textarea name="${key}">${escapeHTML(value)}</textarea></label>`;
  if (type === "select") return `<label class="field">${label}<select name="${key}">${["developer", "entertainment", "games", "lifestyle", "other", "photo-video", "social", "utilities"].map(option => `<option ${option === value ? "selected" : ""}>${option}</option>`).join("")}</select></label>`;
  return `<label class="field">${label}<input name="${key}" type="${type}" value="${escapeHTML(value)}" ${key === "name" ? "required" : ""}></label>`;
}

function openEditor(kind = "new", key = null) {
  const record = kind === "new" ? { kind, key, app: defaultApp() } : records().find(item => item.kind === kind && String(item.key) === String(key));
  if (!record) return;
  state.edit = { kind: record.kind, key: record.key, original: structuredClone(record.app), app: structuredClone(record.app) };
  const isNew = kind === "new";
  $("#editorTitle").textContent = isNew ? "App hochladen" : (record.app.name || "App bearbeiten");
  $("#editorFields").innerHTML = `${editableFields.map(args => field(record.app, ...args)).join("")}
    <label class="field">${isNew ? "IPA-Datei" : "Neue IPA-Version (optional)"}<input name="ipa" type="file" accept=".ipa,application/octet-stream" ${isNew ? "required" : ""}><small>Bei jeder neuen IPA entsteht ein eigener Release-Tag mit dem Text aus „Neu in dieser Version“. Browser-Upload bis 70 MB.</small></label>
    <label class="field">${isNew ? "App-Icon als PNG (optional)" : "Neues App-Icon als PNG (optional)"}<input name="icon" type="file" accept="image/png"></label>`;
  $("#deleteItem").classList.toggle("hidden", isNew || isPinned(record));
  $("#editorStatus").textContent = "";
  $("#editor").showModal();
}

function collect() {
  const form = new FormData($("#editorForm"));
  const app = state.edit.app;
  for (const [key, , type] of editableFields) {
    const value = String(form.get(key) || "").trim();
    app[key] = key === "screenshots" ? value.split("\n").map(entry => entry.trim()).filter(Boolean) : value;
  }
  return { app, ipa: form.get("ipa"), icon: form.get("icon") };
}

function releaseAssetName(filename) {
  const name = filename.trim().replace(/\s+/g, ".").replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.ipa$/i, ".ipa");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.ipa$/.test(name) || name.length > 120) throw new Error("Bitte eine IPA-Datei mit kurzem Dateinamen auswählen.");
  return name;
}

function releaseTag(app) {
  const slug = value => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "app";
  const date = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `app-${slug(app.name)}-v${slug(app.marketingVersion)}-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

async function stageIPA(file, app) {
  if (file.size > 70_000_000) throw new Error("Diese IPA ist größer als 70 MB. Bitte über den GitHub-Workflow mit direkter HTTPS-Datei-URL veröffentlichen.");
  if (!app.marketingVersion || !app.versionDescription) throw new Error("Für eine neue IPA sind Versionsnummer und Änderungstext erforderlich.");
  const name = releaseAssetName(file.name);
  const content = encodeBytes(new Uint8Array(await file.arrayBuffer()));
  const result = await api("/git/blobs", { method: "POST", body: JSON.stringify({ content, encoding: "base64" }) });
  return { name, tag: releaseTag(app), sha: result.sha, size: file.size };
}

async function deleteIPA(filename, tag = "apps") {
  if (!filename) return;
  let release;
  try { release = await api(`/releases/tags/${encodeURIComponent(tag)}`); } catch (error) { if (error.status === 404) return; throw error; }
  const asset = release.assets.find(item => item.name === filename);
  if (asset) await api(`/releases/assets/${asset.id}`, { method: "DELETE" });
}

function safeAssetName(app, file) {
  const stem = (app.name || app.ipaFile || "app").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
  return `catalog/assets/admin-${stem}.png`;
}

async function putFile(path, bytes, message) {
  let sha;
  try { sha = (await api(`/contents/${path}?ref=${encodeURIComponent(BRANCH)}`)).sha; } catch (error) { if (error.status !== 404) throw error; }
  await api(`/contents/${path}`, { method: "PUT", body: JSON.stringify({ message, content: encodeBytes(bytes), branch: BRANCH, ...(sha ? { sha } : {}) }) });
}

async function deleteFile(path) {
  if (!path) return;
  try {
    const file = await api(`/contents/${path}?ref=${encodeURIComponent(BRANCH)}`);
    await api(`/contents/${path}`, { method: "DELETE", body: JSON.stringify({ message: `admin: remove icon ${path}`, sha: file.sha, branch: BRANCH }) });
  } catch (error) { if (error.status !== 404) throw error; }
}

async function commitContent(message) {
  const result = await api("/contents/catalog/content.json", { method: "PUT", body: JSON.stringify({ message, content: encodeJSON(state.content), sha: state.file.sha, branch: BRANCH }) });
  state.file.sha = result.content.sha;
}

async function save() {
  const { app, ipa, icon } = collect();
  const isNew = state.edit.kind === "new";
  $("#editorStatus").textContent = ipa?.size ? "IPA wird sicher bei GitHub zwischengespeichert …" : "Änderungen werden gespeichert …";
  try {
    if (ipa?.size) {
      const staged = await stageIPA(ipa, app);
      app.ipaFile = staged.name;
      app.releaseTag = staged.tag;
      app.pendingUpload = { sha: staged.sha, tag: staged.tag, size: staged.size };
    }
    if (icon?.size) {
      const path = safeAssetName(app, icon);
      await putFile(path, new Uint8Array(await icon.arrayBuffer()), `admin: update icon for ${app.name}`);
      app.iconFile = path;
    }
    if (isNew) state.content.uploadedApps.push(app);
    else if (state.edit.kind === "local") state.content.localApps[state.edit.key] = app;
    else state.content.uploadedApps[Number(state.edit.key)] = app;
    await commitContent(`admin: ${isNew ? "add" : "update"} app ${app.name}`);
    $("#editor").close();
    render();
    toast(ipa?.size ? "IPA vorgemerkt – GitHub erstellt Release und Source" : "App gespeichert – Deployment läuft");
  } catch (error) {
    $("#editorStatus").textContent = error.message;
    await load();
  }
}

async function remove() {
  if (isPinned(state.edit)) {
    $("#editorStatus").textContent = "zLoader bleibt dauerhaft in dieser Source. Eine neue IPA kann über diesen Eintrag hochgeladen werden.";
    return;
  }
  if (!confirm(`„${state.edit.app.name || "Diese App"}“ samt IPA wirklich entfernen?`)) return;
  $("#editorStatus").textContent = "App und IPA werden entfernt …";
  try {
    await deleteIPA(state.edit.app.ipaFile, state.edit.app.releaseTag);
    await deleteFile(state.edit.app.iconFile);
    if (state.edit.kind === "local") delete state.content.localApps[state.edit.key];
    else state.content.uploadedApps.splice(Number(state.edit.key), 1);
    await commitContent(`admin: remove app ${state.edit.app.name}`);
    $("#editor").close();
    render();
    toast("App entfernt – Deployment läuft");
  } catch (error) {
    $("#editorStatus").textContent = error.message;
    await load();
  }
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  setTimeout(() => element.classList.remove("show"), 2800);
}

async function auth(action, body) {
  const response = await fetch(`${API_ROOT}/${action}`, {
    method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-Admin-Request": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || "Anmeldung fehlgeschlagen.");
  return payload;
}

async function showDashboard() {
  const status = await auth("status");
  $("#changePassword").classList.remove("hidden");
  await load();
  $("#serverStatus").classList.toggle("hidden", status.connected);
  $("#addApp").disabled = !status.connected;
  $("#editSource").disabled = !status.connected;
  $("#appsList").querySelectorAll("button").forEach(button => { button.disabled = !status.connected; });
  $("#loginPanel").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");
  $("#logout").classList.remove("hidden");
}

$("#loginForm").onsubmit = async event => {
  event.preventDefault();
  $("#connect").disabled = true;
  $("#loginStatus").textContent = "Admin-Zugang wird geprüft …";
  try {
    const password = $("#password").value;
    await auth("login", { password });
    $("#loginForm").reset();
    await showDashboard();
  } catch (error) { $("#loginStatus").textContent = error.message; }
  finally { $("#connect").disabled = false; }
};

$("#logout").onclick = async () => {
  try { await auth("logout", {}); location.reload(); }
  catch (error) { toast(error.message); }
};
$("#changePassword").onclick = () => { $("#passwordForm").reset(); $("#passwordStatus").textContent = ""; $("#passwordEditor").showModal(); };
$("#cancelPassword").onclick = () => $("#passwordEditor").close();
$("#passwordEditor").addEventListener("close", () => $("#passwordForm").reset());
$("#passwordForm").onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const button = event.target.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    if (form.get("password") !== form.get("confirmation")) throw new Error("Die Passwörter stimmen nicht überein.");
    await auth("password", { password: form.get("password"), currentPassword: form.get("currentPassword") });
    $("#passwordEditor").close();
    toast("Passwort geändert. Andere Sitzungen wurden abgemeldet.");
  } catch (error) { $("#passwordStatus").textContent = error.message; }
  finally { button.disabled = false; }
};
$("#addApp").onclick = () => openEditor();
$("#editSource").onclick = openSourceEditor;
$("#sourceForm").addEventListener("submit", event => { event.preventDefault(); saveSource(); });
$("#cancelSource").onclick = () => $("#sourceEditor").close();
$("#sourceEditor").addEventListener("cancel", event => { if (state.sourceSaving) event.preventDefault(); });
$("#sourceForm input[name='icon']").addEventListener("change", event => {
  if (state.sourceDraftPreview) URL.revokeObjectURL(state.sourceDraftPreview);
  const file = event.target.files[0];
  state.sourceDraftPreview = file ? URL.createObjectURL(file) : null;
  $("#sourceIconPreview").src = state.sourceDraftPreview || $("#sourceIcon").src;
});
$("#sourceEditor").addEventListener("close", () => {
  if (state.sourceDraftPreview) URL.revokeObjectURL(state.sourceDraftPreview);
  state.sourceDraftPreview = null;
});
document.addEventListener("click", event => {
  const item = event.target.closest("[data-kind]");
  if (item) openEditor(item.dataset.kind, item.dataset.key);
  if (event.target.closest(".dialog-close")) event.target.closest("dialog").close();
});
$("#editorForm").addEventListener("submit", event => { event.preventDefault(); if (event.submitter?.value === "cancel") { $("#editor").close(); return; } save(); });
$("#deleteItem").onclick = remove;
$("#cancelEditor").onclick = () => $("#editor").close();

// Remove credentials persisted by the old token-based panel.
try { sessionStorage.removeItem("zynthecAdmin"); } catch {}
async function initializeLogin() {
  try {
    const status = await auth("status");
    if (status.authenticated) { await showDashboard(); return; }
    if (!status.initialized) {
      $("#loginStatus").textContent = "Der Admin-Zugang muss serverseitig eingerichtet werden.";
      return;
    }
    $("#connect").disabled = false;
  } catch (error) { $("#loginStatus").textContent = error.message; }
}
initializeLogin();


// Appearance is a local UI preference and contains no authentication data.
const appearance = $("#appearance");
function applyAppearance(value) {
  if (value === "light" || value === "dark") document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
}
try {
  const savedAppearance = localStorage.getItem("zynthecAppearance");
  if (["light", "dark", "system"].includes(savedAppearance)) appearance.value = savedAppearance;
} catch { /* Storage may be unavailable in private/restricted browsing. */ }
applyAppearance(appearance.value);
appearance.addEventListener("change", () => {
  applyAppearance(appearance.value);
  try { localStorage.setItem("zynthecAppearance", appearance.value); } catch { /* In-memory choice still works. */ }
});
