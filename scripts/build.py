#!/usr/bin/env python3
"""Build the zynthec-altstore-source feed and admin page."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import os
import plistlib
import re
import shutil
import sys
import zipfile
from urllib.parse import urljoin
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "catalog"
DIST = ROOT / "dist"


def asset_base(settings: dict[str, Any]) -> str:
    source_url = settings["sourceURL"].rstrip("/")
    return urljoin(source_url, "./") if source_url.endswith(".json") else source_url + "/"


def read_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def plist_from_ipa(ipa: Path) -> tuple[dict[str, Any], str]:
    with zipfile.ZipFile(ipa) as archive:
        candidates = [name for name in archive.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)]
        if not candidates:
            raise ValueError(f"{ipa.name}: keine App-Info.plist gefunden")
        info_path = candidates[0]
        return plistlib.loads(archive.read(info_path)), info_path.rsplit("/", 1)[0]


def extract_icon(ipa: Path, app_path: str, info: dict[str, Any], output: Path) -> None:
    candidates: list[str] = []
    icons = info.get("CFBundleIcons", {}).get("CFBundlePrimaryIcon", {}).get("CFBundleIconFiles", [])
    icons += info.get("CFBundleIconFiles", [])
    with zipfile.ZipFile(ipa) as archive:
        names = archive.namelist()
        for icon in reversed(icons):
            candidates += [f"{app_path}/{icon}", f"{app_path}/{icon}.png", f"{app_path}/{icon}@3x.png", f"{app_path}/{icon}@2x.png"]
        candidates += [name for name in names if name.startswith(app_path + "/AppIcon") and name.endswith(".png")]
        selected = next((name for name in candidates if name in names), None)
        if selected:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(archive.read(selected))


def filename_version(ipa: Path, app_name: str) -> str | None:
    """Return the user-facing version suffix from ``App Name-version.ipa``."""
    stem = ipa.stem
    prefix = f"{app_name}-"
    if stem.casefold().startswith(prefix.casefold()):
        return stem[len(prefix):] or None
    if "-" in stem:
        return stem.split("-", 1)[1] or None
    return None


def ipa_app(ipa: Path, settings: dict[str, Any], content: dict[str, Any]) -> dict[str, Any]:
    info, app_path = plist_from_ipa(ipa)
    bundle_id = info["CFBundleIdentifier"]
    file_override = next((app for app in content.get("uploadedApps", []) if app.get("ipaFile") == ipa.name), {})
    override = {**file_override, **content.get("localApps", {}).get(bundle_id, {})}
    embedded_name = info.get("CFBundleDisplayName") or info.get("CFBundleName") or ipa.stem
    name = override.get("name", embedded_name)
    version = str(info.get("CFBundleShortVersionString", "1.0"))
    marketing_version = override.get("marketingVersion") or filename_version(ipa, name) or version
    build = str(info.get("CFBundleVersion", "1"))
    release_name = ipa.name
    repo = settings["githubRepository"]
    tag = override.get("releaseTag") or settings.get("releaseTag", "apps")
    output_icon = DIST / "assets" / "apps" / f"{bundle_id}.png"
    icon_file = override.get("iconFile")
    if icon_file:
        source_icon = ROOT / icon_file
        if not source_icon.is_file():
            raise ValueError(f"{ipa.name}: Icon-Datei nicht gefunden: {icon_file}")
        output_icon.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_icon, output_icon)
    else:
        extract_icon(ipa, app_path, info, output_icon)
    if not output_icon.exists():
        shutil.copy2(ROOT / "icon.png", output_icon)
    stat = ipa.stat()
    version_item = {
        "version": version,
        "marketingVersion": marketing_version,
        "buildVersion": build,
        "date": dt.datetime.fromtimestamp(stat.st_mtime, dt.timezone.utc).date().isoformat(),
        "localizedDescription": override.get("versionDescription", "Neue Version von " + name),
        "downloadURL": override.get("downloadURL", f"https://github.com/{repo}/releases/download/{tag}/{release_name}"),
        "size": stat.st_size,
        "minOSVersion": str(info.get("MinimumOSVersion", "15.0")),
        "sha256": hashlib.sha256(ipa.read_bytes()).hexdigest(),
    }
    return {
        "name": name,
        "bundleIdentifier": bundle_id,
        "developerName": override.get("developerName", "zynthec"),
        "subtitle": override.get("subtitle", "Eine App von zynthec."),
        "localizedDescription": override.get("localizedDescription", "Direkt von zynthec veröffentlicht."),
        "iconURL": f"{asset_base(settings)}assets/apps/{bundle_id}.png",
        "tintColor": override.get("tintColor", settings["tintColor"]),
        "category": override.get("category", "other"),
        "screenshots": override.get("screenshots", []),
        "versions": [version_item],
        "appPermissions": override.get("appPermissions", {"entitlements": [], "privacy": {}}),
        "_origin": {"name": "zynthec", "url": settings["sourceURL"]},
    }


def normalize_app(app: dict[str, Any], origin: dict[str, str]) -> dict[str, Any] | None:
    required = ("name", "bundleIdentifier", "developerName", "downloadURL")
    if "versions" not in app and all(app.get(key) is not None for key in required):
        app = dict(app)
        app["versions"] = [{
            "version": str(app.pop("version", "1.0")),
            "buildVersion": str(app.pop("buildVersion", app.pop("versionCode", "1"))),
            "date": app.pop("versionDate", dt.date.today().isoformat()),
            "localizedDescription": app.pop("versionDescription", "Aktualisierung aus der Original-Source."),
            "downloadURL": app.pop("downloadURL"),
            "size": int(app.pop("size", 0)),
            "minOSVersion": str(app.pop("minOSVersion", "15.0")),
        }]
    if not app.get("bundleIdentifier") or not app.get("versions"):
        return None
    result = dict(app)
    result.setdefault("subtitle", f"Von {result.get('developerName', origin['name'])}")
    result.setdefault("localizedDescription", result["subtitle"])
    result.setdefault("iconURL", asset_base({"sourceURL": origin["url"]}) + "assets/source-icon.png")
    result.setdefault("category", "other")
    result.setdefault("screenshots", result.pop("screenshotURLs", []))
    result.setdefault("appPermissions", {"entitlements": [], "privacy": {}})
    result["_origin"] = origin
    return result


def build() -> None:
    settings = read_json(CATALOG / "settings.json")
    content = read_json(CATALOG / "content.json")
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(ROOT / "site", DIST)
    admin_page = DIST / "admin" / "index.html"
    admin_page.write_text(admin_page.read_text(encoding="utf-8").replace("{{SOURCE_NAME}}", html.escape(settings["name"])), encoding="utf-8")
    (DIST / "assets").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "icon.png", DIST / "assets" / "source-icon.png")
    # Only catalogued files are published; ignored local IPAs and old releases stay private to this build.
    selected = content.get("localApps", {})
    excluded = set(content.get("excludedBundleIdentifiers", []))
    configured_apps = [*selected.values(), *content.get("uploadedApps", [])]
    selected_files = {app.get("ipaFile") for app in configured_apps if app.get("ipaFile")}
    paths = []
    available_bundle_ids = set()
    for path in sorted(ROOT.glob("*.ipa")):
        if path.name not in selected_files:
            continue
        info, _ = plist_from_ipa(path)
        if info["CFBundleIdentifier"] in excluded:
            continue
        available_bundle_ids.add(info["CFBundleIdentifier"])
        preferred = selected.get(info["CFBundleIdentifier"], {}).get("ipaFile")
        if preferred and path.name != preferred:
            continue
        paths.append(path)
    for bundle_id, metadata in selected.items():
        preferred = metadata.get("ipaFile")
        if bundle_id in available_bundle_ids and preferred and not (ROOT / preferred).is_file():
            raise ValueError(f"{bundle_id}: configured IPA not found: {preferred}")
    missing_files = selected_files - {path.name for path in paths}
    if missing_files:
        raise ValueError("configured IPA not found: " + ", ".join(sorted(missing_files)))
    local = [ipa_app(path, settings, content) for path in paths]
    manual = [app for app in (normalize_app(app, {"name": "zynthec", "url": settings["sourceURL"]}) for app in content.get("manualApps", [])) if app and app["bundleIdentifier"] not in excluded]
    merged: dict[str, dict[str, Any]] = {}
    for app in manual + local:
        if app["bundleIdentifier"] not in excluded:
            merged[app["bundleIdentifier"]] = app
    pinned = content.get("pinnedBundleIdentifiers", [])
    missing_pins = set(pinned) - set(merged)
    if missing_pins:
        raise ValueError("pinned apps missing from source: " + ", ".join(sorted(missing_pins)))
    pin_order = {identifier: index for index, identifier in enumerate(pinned)}
    apps = sorted(merged.values(), key=lambda app: (
        pin_order.get(app["bundleIdentifier"], len(pinned)), app["name"].casefold()))
    feed_apps = [{key: value for key, value in app.items() if not key.startswith("_")} for app in apps]
    feed = {
        "name": settings["name"], "identifier": settings["identifier"],
        "subtitle": settings["subtitle"], "description": settings["description"],
        "sourceURL": settings["sourceURL"], "website": settings["website"],
        "iconURL": settings["iconURL"], "tintColor": settings["tintColor"],
        "featuredApps": pinned,
        "apps": feed_apps, "news": content.get("news", [])
    }
    write_json(DIST / "source.json", feed)
    landing_page = DIST / "zloader" / "index.html"
    if landing_page.is_file():
        zloader = next((app for app in feed_apps if app["bundleIdentifier"] == "com.zynthec.zLoader"), None)
        latest = zloader["versions"][0] if zloader else {}
        download = latest.get("downloadURL", "https://github.com/zynthec-dev/zloader-app/releases")
        label = "zLoader " + latest.get("marketingVersion", latest.get("version", ""))
        if latest.get("minOSVersion"):
            label += " — iOS " + latest["minOSVersion"] + "+"
        landing_page.write_text(landing_page.read_text(encoding="utf-8")
                                .replace("{{ZLOADER_DOWNLOAD_URL}}", html.escape(download, quote=True))
                                .replace("{{ZLOADER_ICON_URL}}", html.escape(zloader["iconURL"] if zloader else settings["iconURL"], quote=True))
                                .replace("{{ZLOADER_DOWNLOAD_LABEL}}", html.escape(label, quote=True)), encoding="utf-8")
    print(f"Built {len(apps)} apps ({len(local)} local, {len(manual)} manual) into {DIST}")


if __name__ == "__main__":
    argparse.ArgumentParser().parse_args()
    try:
        build()
    except (KeyError, ValueError, zipfile.BadZipFile) as exc:
        print(f"build error: {exc}", file=sys.stderr)
        raise SystemExit(1)
