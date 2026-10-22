#!/usr/bin/env python3
"""Publish browser-staged IPAs, then download only catalogued release assets."""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import io
import json
import os
import plistlib
import re
import secrets
import shutil
import subprocess
import tempfile
import urllib.request
from urllib.parse import quote
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CONTENT = ROOT / "catalog" / "content.json"
SETTINGS = ROOT / "catalog" / "settings.json"
ASSET_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\.ipa\Z")
RELEASE_TAG = re.compile(r"app-[a-z0-9-]+-v[a-z0-9._-]+-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\Z")
SHA = re.compile(r"[a-f0-9]{40}\Z")
MAX_BROWSER_IPA_BYTES = 200_000_000
MAX_IPA_CHUNK_BYTES = 8_000_000


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def apps(content: dict[str, Any]) -> list[tuple[str | None, dict[str, Any]]]:
    return [*content.get("localApps", {}).items(), *((None, app) for app in content.get("uploadedApps", []))]


def selected_assets(content: dict[str, Any], default_tag: str) -> list[tuple[str, str]]:
    result: list[tuple[str, str]] = []
    for _, app in apps(content):
        filename = app.get("ipaFile", "")
        tag = app.get("releaseTag") or default_tag
        if not isinstance(filename, str) or not ASSET_NAME.fullmatch(filename):
            raise ValueError(f"Invalid IPA filename: {filename!r}")
        if not isinstance(tag, str) or not (tag == default_tag or RELEASE_TAG.fullmatch(tag)):
            raise ValueError(f"Invalid release tag: {tag!r}")
        result.append((tag, filename))
    if len(result) != len(set(result)):
        raise ValueError("The same release asset is assigned to multiple apps")
    return result


def validate_pending(app: dict[str, Any], default_tag: str) -> tuple[list[dict[str, Any]], str, int, str]:
    pending = app["pendingUpload"]
    sha, tag, size = pending.get("sha"), pending.get("tag"), pending.get("size")
    filename = app.get("ipaFile", "")
    chunks = pending.get("chunks")
    if chunks is None:
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise ValueError("Invalid staged IPA SHA")
        if type(size) is not int or not 0 < size <= 70_000_000:
            raise ValueError("Invalid legacy staged IPA size")
        chunks = [{"sha": sha, "size": size}]
    else:
        if "sha" in pending or not isinstance(chunks, list) or not 1 <= len(chunks) <= 25:
            raise ValueError("Invalid staged IPA chunks")
        if any(not isinstance(chunk, dict) or not isinstance(chunk.get("sha"), str)
               or not SHA.fullmatch(chunk["sha"]) or type(chunk.get("size")) is not int
               or not 0 < chunk["size"] <= MAX_IPA_CHUNK_BYTES for chunk in chunks):
            raise ValueError("Invalid staged IPA chunk metadata")
        if sum(chunk["size"] for chunk in chunks) != size:
            raise ValueError("Staged IPA chunk sizes do not match IPA")
    if not isinstance(tag, str) or not RELEASE_TAG.fullmatch(tag) or tag == default_tag:
        raise ValueError("Invalid staged IPA release tag")
    if tag != app.get("releaseTag"):
        raise ValueError("Staged IPA tag does not match app metadata")
    if not isinstance(filename, str) or not ASSET_NAME.fullmatch(filename):
        raise ValueError("Invalid staged IPA filename")
    if type(size) is not int or not 0 < size <= MAX_BROWSER_IPA_BYTES:
        raise ValueError("Invalid staged IPA size")
    if not app.get("name") or not app.get("marketingVersion") or not app.get("versionDescription"):
        raise ValueError("App name, version and change notes are required for an IPA update")
    return chunks, tag, size, filename


def fetch_blob(repo: str, sha: str, token: str) -> bytes:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/git/blobs/{sha}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.load(response)
    if payload.get("encoding") != "base64":
        raise ValueError("GitHub did not return a base64 Git blob")
    data = base64.b64decode(payload["content"], validate=False)
    actual_sha = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
    if actual_sha != sha:
        raise ValueError("Staged IPA checksum does not match its Git blob SHA")
    return data


def ipa_bundle_id(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        info_paths = [name for name in archive.namelist() if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)]
        if len(info_paths) != 1:
            raise ValueError("IPA must contain exactly one app Info.plist")
        info = plistlib.loads(archive.read(info_paths[0]))
    return info["CFBundleIdentifier"]


def normalize_ipa(data: bytes) -> bytes:
    """Remove Finder metadata which sideloaders can mistake for app bundles."""
    def metadata(name: str) -> bool:
        return any(part == "__MACOSX" or part == ".DS_Store" or part.startswith("._")
                   for part in name.split("/"))

    with zipfile.ZipFile(io.BytesIO(data)) as source:
        if not any(metadata(entry.filename) for entry in source.infolist()):
            return data
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as target:
            target.comment = source.comment
            for entry in source.infolist():
                if not metadata(entry.filename):
                    # Keep compression, permissions (including executable bits),
                    # symlink attributes and every actual app file unchanged.
                    target.writestr(entry, source.read(entry))
    return output.getvalue()


def staged_source_archive(app: dict[str, Any], repo: str, token: str) -> tuple[str, bytes] | None:
    pending = app.get("pendingSourceArchive")
    if pending is None:
        return None
    name, sha, size, digest = (pending.get(key) for key in ("name", "sha", "size", "sha256"))
    if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*-source\.zip", name)
            or type(size) is not int or not 0 < size <= 100_000_000
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)):
        raise ValueError("Invalid staged corresponding-source metadata")
    chunks = pending.get("chunks")
    if chunks is None:
        if not isinstance(sha, str) or not SHA.fullmatch(sha):
            raise ValueError("Invalid corresponding-source blob SHA")
        chunks = [{"sha": sha, "size": size}]
    if (sha is not None and "chunks" in pending) or not isinstance(chunks, list) or not 1 <= len(chunks) <= 4:
        raise ValueError("Invalid corresponding-source chunks")
    if any(not isinstance(chunk, dict) or not isinstance(chunk.get("sha"), str)
           or not SHA.fullmatch(chunk["sha"]) or type(chunk.get("size")) is not int
           or not 0 < chunk["size"] <= 100_000_000 for chunk in chunks):
        raise ValueError("Invalid corresponding-source chunk metadata")
    if sum(chunk["size"] for chunk in chunks) != size:
        raise ValueError("Corresponding-source chunk sizes do not match archive")
    pieces = [fetch_blob(repo, chunk["sha"], token) for chunk in chunks]
    if any(len(piece) != chunk["size"] for piece, chunk in zip(pieces, chunks)):
        raise ValueError("Corresponding-source chunk size mismatch")
    data = b"".join(pieces)
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Corresponding-source checksum or size mismatch")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sum(entry.file_size for entry in archive.infolist()) > 1_000_000_000:
            raise ValueError("Corresponding-source archive is too large")
        if archive.testzip() is not None:
            raise ValueError("Corrupt corresponding-source archive")
        if not any(name.endswith("/LICENSE") for name in archive.namelist()):
            raise ValueError("Corresponding-source archive is missing its license")
    return name, data


def publish_pending(content: dict[str, Any], repo: str, default_tag: str, token: str) -> bool:
    changed = False
    for bundle_id, app in apps(content):
        if "pendingUpload" not in app:
            continue
        chunks, tag, size, filename = validate_pending(app, default_tag)
        pieces = []
        for chunk in chunks:
            piece = fetch_blob(repo, chunk["sha"], token)
            if len(piece) != chunk["size"]:
                raise ValueError(f"Staged IPA chunk size mismatch: {filename}")
            pieces.append(piece)
        data = b"".join(pieces)
        del pieces
        if len(data) != size:
            raise ValueError(f"Staged IPA size mismatch: {filename}")
        data = normalize_ipa(data)
        embedded_bundle_id = ipa_bundle_id(data)
        if bundle_id is not None and embedded_bundle_id != bundle_id:
            raise ValueError(f"IPA bundle ID does not match catalog entry: {filename}")
        if embedded_bundle_id in content.get("excludedBundleIdentifiers", []):
            raise ValueError(f"Excluded app cannot be uploaded: {embedded_bundle_id}")
        if bundle_id is None:
            app["bundleIdentifier"] = embedded_bundle_id
        source_archive = staged_source_archive(app, repo, token)
        with tempfile.TemporaryDirectory(prefix="source-ipa-") as folder:
            path = Path(folder) / filename
            path.write_bytes(data)
            existing = subprocess.run(
                ["gh", "release", "view", tag, "--repo", repo],
                capture_output=True, text=True, check=False,
            )
            if existing.returncode:
                subprocess.run(
                    ["gh", "release", "create", tag, "--repo", repo,
                     "--title", f"{app['name']} {app['marketingVersion']}",
                     "--notes", app.get("releaseNotes") or app["versionDescription"], "--target", "main", *(["--draft"] if source_archive else [])],
                    check=True,
                )
            if source_archive:
                source_name, source_data = source_archive
                source_path = Path(folder) / source_name
                source_path.write_bytes(source_data)
                subprocess.run(["gh", "release", "upload", tag, str(source_path), "--repo", repo, "--clobber"], check=True)
            subprocess.run(["gh", "release", "upload", tag, str(path), "--repo", repo, "--clobber"], check=True)
            if source_archive:
                # Keep the new binary private until both assets are uploaded.
                subprocess.run(["gh", "release", "edit", tag, "--repo", repo, "--draft=false", "--latest"], check=True)
                app["sourceArchive"] = {
                    "name": source_name, "size": len(source_data),
                    "sha256": hashlib.sha256(source_data).hexdigest(),
                    "downloadURL": f"https://github.com/{repo}/releases/download/{tag}/{source_name}",
                }
                del app["pendingSourceArchive"]
        del app["pendingUpload"]
        app.pop("releaseNotes", None)
        app["releaseAsset"] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                               "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
        changed = True
    if changed:
        CONTENT.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return changed


def download_selected(content: dict[str, Any], repo: str, default_tag: str) -> None:
    releases: dict[str, dict[str, Any]] = {}
    for tag, filename in selected_assets(content, default_tag):
        app = next(app for _, app in apps(content)
                   if app["ipaFile"] == filename and (app.get("releaseTag") or default_tag) == tag)
        pinned = app.get("releaseAsset")
        if pinned is not None:
            if (type(pinned.get("size")) is not int or pinned["size"] <= 0
                    or not re.fullmatch(r"[a-f0-9]{64}", pinned.get("sha256", ""))):
                raise ValueError("Invalid pinned release asset metadata")
            asset = {"name": filename, "size": pinned["size"],
                     "digest": "sha256:" + pinned["sha256"], "updated_at": pinned["updatedAt"],
                     "browser_download_url": f"https://github.com/{repo}/releases/download/{quote(tag, safe='')}/{quote(filename, safe='')}"}
            download_asset(asset, ROOT / filename, tag)
            continue
        if tag not in releases:
            request = urllib.request.Request(
                f"https://api.github.com/repos/{repo}/releases/tags/{quote(tag, safe='')}",
                headers={"Accept": "application/vnd.github+json", "User-Agent": "zynthec-altstore-source"},
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                releases[tag] = json.load(response)
        asset = next((item for item in releases[tag].get("assets", []) if item["name"] == filename), None)
        if asset is None:
            raise ValueError(f"Release asset not found: {tag}/{filename}")
        download_asset(asset, ROOT / filename, tag)


def download_asset(asset: dict[str, Any], destination: Path, tag: str) -> None:
    request = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "zynthec-altstore-source"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)
    if destination.stat().st_size != asset["size"]:
        raise ValueError(f"Release asset size mismatch: {tag}/{destination.name}")
    digest = asset.get("digest")
    if digest and digest.startswith("sha256:"):
        actual_digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        if actual_digest != digest.removeprefix("sha256:"):
            raise ValueError(f"Release asset checksum mismatch: {tag}/{destination.name}")
    if asset.get("updated_at"):
        timestamp = dt.datetime.fromisoformat(asset["updated_at"].replace("Z", "+00:00")).timestamp()
        os.utime(destination, (timestamp, timestamp))


def new_release_tag(name: str, version: str) -> str:
    def slug(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:40] or "app"
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"app-{slug(name)}-v{slug(version)}-{timestamp}-{secrets.token_hex(4)}"


def publish_url_file(content: dict[str, Any], repo: str, path: Path, name: str, version: str, notes: str) -> str:
    if not path.is_file() or not ASSET_NAME.fullmatch(path.name):
        raise ValueError("The IPA filename is invalid")
    if not name.strip() or not version.strip() or not notes.strip():
        raise ValueError("App name, version and change notes are required")
    original = path.read_bytes()
    data = normalize_ipa(original)
    bundle_id = ipa_bundle_id(data)
    if bundle_id in content.get("excludedBundleIdentifiers", []):
        raise ValueError(f"Excluded app cannot be uploaded: {bundle_id}")
    if data != original:
        path.write_bytes(data)
    tag = new_release_tag(name, version)
    subprocess.run(
        ["gh", "release", "create", tag, "--repo", repo, "--title", f"{name} {version}",
         "--notes", notes, "--target", "main"], check=True,
    )
    subprocess.run(["gh", "release", "upload", tag, str(path), "--repo", repo], check=True)
    app = content.get("localApps", {}).get(bundle_id)
    if app is None:
        app = next((entry for entry in content.get("uploadedApps", []) if entry.get("bundleIdentifier") == bundle_id), None)
    if app is None:
        app = {"bundleIdentifier": bundle_id, "developerName": "zynthec", "category": "other", "screenshots": []}
        content.setdefault("uploadedApps", []).append(app)
    app.update({"name": name, "marketingVersion": version, "versionDescription": notes,
                "ipaFile": path.name, "releaseTag": tag,
                "releaseAsset": {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                                 "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat()}})
    CONTENT.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return tag


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("publish", "download", "publish-url"))
    args = parser.parse_args()
    content, settings = read_json(CONTENT), read_json(SETTINGS)
    repo, default_tag = settings["githubRepository"], settings.get("releaseTag", "apps")
    if args.operation == "publish":
        if any("pendingUpload" in app for _, app in apps(content)):
            token = os.environ.get("GH_TOKEN")
            if not token:
                raise ValueError("GH_TOKEN is required to publish staged IPAs")
            publish_pending(content, repo, default_tag, token)
    elif args.operation == "download":
        download_selected(content, repo, default_tag)
    else:
        filename = os.environ["ASSET_NAME"]
        if not ASSET_NAME.fullmatch(filename):
            raise ValueError("The IPA filename is invalid")
        path = ROOT / filename
        publish_url_file(content, repo, path, os.environ["APP_NAME"], os.environ["APP_VERSION"], os.environ["CHANGE_NOTES"])


if __name__ == "__main__":
    main()
