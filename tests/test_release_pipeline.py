import hashlib
import importlib.util
import io
import json
import plistlib
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_pipeline", ROOT / "scripts/release_pipeline.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)


def test_ipa(bundle_id="de.renewitt.mipet"):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("Payload/Test.app/Info.plist", plistlib.dumps({"CFBundleIdentifier": bundle_id}))
    return stream.getvalue()


class ReleasePipelineTests(unittest.TestCase):
    def test_only_selected_release_assets_are_downloaded(self):
        content = {"localApps": {"de.renewitt.mipet": {"ipaFile": "miPet-0.3-beta.ipa"}}}
        self.assertEqual(pipeline.selected_assets(content, "apps"), [("apps", "miPet-0.3-beta.ipa")])

    def test_normalization_removes_fake_app_and_preserves_real_files(self):
        stream = io.BytesIO(test_ipa())
        executable = zipfile.ZipInfo("Payload/Test.app/Test")
        executable.external_attr = 0o100755 << 16
        with zipfile.ZipFile(stream, "a") as archive:
            archive.writestr(executable, b"app executable")
            archive.writestr("Payload/._Test.app", b"Finder metadata")
            archive.writestr("Payload/Test.app/._Info.plist", b"Finder metadata")
            archive.writestr("__MACOSX/Payload/._Test.app", b"Finder metadata")
            archive.writestr("Payload/.DS_Store", b"Finder metadata")
        original = stream.getvalue()
        cleaned = pipeline.normalize_ipa(original)
        with zipfile.ZipFile(io.BytesIO(original)) as source, zipfile.ZipFile(io.BytesIO(cleaned)) as target:
            self.assertEqual(target.namelist(), ["Payload/Test.app/Info.plist", executable.filename])
            for entry in target.infolist():
                self.assertEqual(target.read(entry), source.read(entry.filename))
                self.assertEqual(entry.external_attr, source.getinfo(entry.filename).external_attr)
            self.assertIsNone(target.testzip())
        self.assertEqual(pipeline.normalize_ipa(cleaned), cleaned)

    def test_tag_is_unique_and_valid(self):
        first = pipeline.new_release_tag("miPet", "0.4 beta")
        second = pipeline.new_release_tag("miPet", "0.4 beta")
        self.assertRegex(first, pipeline.RELEASE_TAG)
        self.assertNotEqual(first, second)

    def test_public_download_selects_exact_asset_and_preserves_release_date(self):
        data = test_ipa()
        asset = {"name": "miPet-0.4.ipa", "size": len(data),
                 "browser_download_url": "https://github.com/example/download/miPet-0.4.ipa",
                 "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
                 "updated_at": "2026-09-28T12:00:00Z"}
        release = {"assets": [{"name": "unselected.ipa"}, asset]}
        with tempfile.TemporaryDirectory() as folder, patch.object(pipeline, "ROOT", Path(folder)), patch.object(
            pipeline.urllib.request, "urlopen", side_effect=[io.BytesIO(json.dumps(release).encode()), io.BytesIO(data)]
        ) as fetch:
            pipeline.download_selected({"localApps": {"de.renewitt.mipet": {"ipaFile": asset["name"]}}}, "owner/repo", "apps")
            path = Path(folder) / asset["name"]
            self.assertEqual(path.read_bytes(), data)
            self.assertEqual(path.stat().st_mtime, 1790596800)
            self.assertEqual(fetch.call_args_list[1].args[0].full_url, asset["browser_download_url"])
            self.assertNotIn("Authorization", fetch.call_args_list[0].args[0].headers)

    def test_public_download_rejects_corrupt_release_asset(self):
        data = test_ipa()
        release = {"assets": [{"name": "miPet.ipa", "size": len(data),
                   "browser_download_url": "https://github.com/example/download/miPet.ipa",
                   "digest": "sha256:" + "0" * 64}]}
        with tempfile.TemporaryDirectory() as folder, patch.object(pipeline, "ROOT", Path(folder)), patch.object(
            pipeline.urllib.request, "urlopen", side_effect=[io.BytesIO(json.dumps(release).encode()), io.BytesIO(data)]
        ):
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                pipeline.download_selected({"localApps": {"de.renewitt.mipet": {"ipaFile": "miPet.ipa"}}}, "owner/repo", "apps")

    def test_pinned_download_needs_no_rate_limited_github_api(self):
        data = test_ipa()
        app = {"ipaFile": "miPet.ipa", "releaseAsset": {
            "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "updatedAt": "2026-10-07T09:12:00Z"}}
        with tempfile.TemporaryDirectory() as folder, patch.object(pipeline, "ROOT", Path(folder)), patch.object(
            pipeline.urllib.request, "urlopen", return_value=io.BytesIO(data)
        ) as fetch:
            pipeline.download_selected({"localApps": {"de.renewitt.mipet": app}}, "owner/repo", "apps")
            self.assertEqual((Path(folder) / "miPet.ipa").read_bytes(), data)
            fetch.assert_called_once()
            self.assertEqual(fetch.call_args.args[0].full_url,
                             "https://github.com/owner/repo/releases/download/apps/miPet.ipa")

    def test_staged_upload_creates_release_and_preserves_change_notes(self):
        data = test_ipa()
        sha = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        tag = "app-mipet-v0-4-20260928T205613Z-a1b2c3d4"
        app = {
            "ipaFile": "miPet-0.4.ipa", "releaseTag": tag, "name": "miPet",
            "marketingVersion": "0.4", "versionDescription": "Neue Animationen",
            "pendingUpload": {"sha": sha, "tag": tag, "size": len(data)},
        }
        content = {"localApps": {"de.renewitt.mipet": app}, "uploadedApps": [], "excludedBundleIdentifiers": []}
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "content.json"
            with patch.object(pipeline, "CONTENT", output), patch.object(pipeline, "fetch_blob", return_value=data), patch.object(
                pipeline.subprocess, "run", side_effect=[subprocess.CompletedProcess([], 1), subprocess.CompletedProcess([], 0), subprocess.CompletedProcess([], 0)]
            ) as run:
                self.assertTrue(pipeline.publish_pending(content, "zynthec-dev/zynthec-altstore-source", "apps", "test-token"))
            self.assertNotIn("pendingUpload", json.loads(output.read_text())["localApps"]["de.renewitt.mipet"])
            self.assertIn("Neue Animationen", run.call_args_list[1].args[0])
            self.assertIn(tag, run.call_args_list[2].args[0])

    def source_upload_case(self):
        data = test_ipa()
        source = io.BytesIO()
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("app-source/LICENSE", "Public source license")
            archive.writestr("app-source/main.swift", "// Source used for the build")
        source_data = source.getvalue()
        tag = "app-mipet-v0-4-20260928T205613Z-a1b2c3d4"
        app = {
            "ipaFile": "miPet-0.4.ipa", "releaseTag": tag, "name": "miPet",
            "marketingVersion": "0.4", "versionDescription": "App update only", "releaseNotes": "Source included",
            "pendingUpload": {"sha": "1" * 40, "tag": tag, "size": len(data)},
            "pendingSourceArchive": {"sha": "2" * 40, "name": "miPet-0.4-source.zip",
                "size": len(source_data), "sha256": hashlib.sha256(source_data).hexdigest()},
        }
        return {"localApps": {"de.renewitt.mipet": app}}, app, data, source_data

    def test_source_is_uploaded_before_ipa_and_draft_is_published_last(self):
        content, app, data, source_data = self.source_upload_case()
        with tempfile.TemporaryDirectory() as folder, patch.object(pipeline, "CONTENT", Path(folder) / "content.json"), patch.object(
            pipeline, "fetch_blob", side_effect=[data, source_data]
        ), patch.object(pipeline.subprocess, "run", side_effect=lambda args, **kwargs:
                        subprocess.CompletedProcess(args, 1 if args[2] == "view" else 0)) as run:
            self.assertTrue(pipeline.publish_pending(content, "owner/repo", "apps", "test-token"))
        commands = [call.args[0] for call in run.call_args_list]
        self.assertIn("--draft", commands[1])
        self.assertIn("Source included", commands[1])
        self.assertEqual(app["versionDescription"], "App update only")
        self.assertNotIn("releaseNotes", app)
        self.assertTrue(commands[2][4].endswith("-source.zip"))
        self.assertTrue(commands[3][4].endswith(".ipa"))
        self.assertEqual(commands[4][2], "edit")
        self.assertIn("--draft=false", commands[4])
        self.assertNotIn("pendingSourceArchive", app)
        self.assertNotIn("pendingUpload", app)
        self.assertEqual(app["sourceArchive"]["sha256"], hashlib.sha256(source_data).hexdigest())

    def test_chunked_source_is_reassembled_and_verified(self):
        content, app, data, source_data = self.source_upload_case()
        pending = app["pendingSourceArchive"]
        del pending["sha"]
        cut = len(source_data) // 2
        pending["chunks"] = [{"sha": "3" * 40, "size": cut}, {"sha": "4" * 40, "size": len(source_data) - cut}]
        with patch.object(pipeline, "fetch_blob", side_effect=[source_data[:cut], source_data[cut:]]):
            self.assertEqual(pipeline.staged_source_archive(app, "owner/repo", "test-token"), (pending["name"], source_data))
        pending["chunks"][0]["size"] += 1
        with patch.object(pipeline, "fetch_blob") as fetch:
            with self.assertRaisesRegex(ValueError, "chunk sizes"):
                pipeline.staged_source_archive(app, "owner/repo", "test-token")
        fetch.assert_not_called()

    def test_corrupt_source_fails_before_release_is_created(self):
        content, app, data, source_data = self.source_upload_case()
        with patch.object(pipeline, "fetch_blob", side_effect=[data, source_data + b"corrupt"]), patch.object(pipeline.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "(checksum|size) mismatch"):
                pipeline.publish_pending(content, "owner/repo", "apps", "test-token")
        run.assert_not_called()
        self.assertIn("pendingUpload", app)

    def test_failed_source_upload_does_not_publish_draft(self):
        content, app, data, source_data = self.source_upload_case()
        def command(args, **kwargs):
            if args[2] == "upload":
                raise subprocess.CalledProcessError(1, args)
            return subprocess.CompletedProcess(args, 1 if args[2] == "view" else 0)
        with patch.object(pipeline, "fetch_blob", side_effect=[data, source_data]), patch.object(pipeline.subprocess, "run", side_effect=command) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                pipeline.publish_pending(content, "owner/repo", "apps", "test-token")
        self.assertFalse(any(call.args[0][2] == "edit" for call in run.call_args_list))
        self.assertIn("pendingUpload", app)
        self.assertIn("pendingSourceArchive", app)

    def test_chunked_ipa_is_reassembled_and_published(self):
        data = test_ipa()
        cut = len(data) // 2
        chunks = [{"sha": "1" * 40, "size": cut}, {"sha": "2" * 40, "size": len(data) - cut}]
        tag = "app-mipet-v0-4-20260928T205613Z-a1b2c3d4"
        app = {"ipaFile": "miPet-0.4.ipa", "releaseTag": tag, "name": "miPet",
               "marketingVersion": "0.4", "versionDescription": "Chunk upload",
               "pendingUpload": {"chunks": chunks, "size": len(data), "tag": tag}}
        content = {"localApps": {"de.renewitt.mipet": app}}
        with tempfile.TemporaryDirectory() as folder, patch.object(pipeline, "CONTENT", Path(folder) / "content.json"), patch.object(
            pipeline, "fetch_blob", side_effect=[data[:cut], data[cut:]]
        ) as fetch, patch.object(pipeline.subprocess, "run", side_effect=lambda args, **kwargs:
                subprocess.CompletedProcess(args, 1 if args[2] == "view" else 0)):
            self.assertTrue(pipeline.publish_pending(content, "owner/repo", "apps", "test-token"))
        self.assertEqual([call.args[1] for call in fetch.call_args_list], [chunk["sha"] for chunk in chunks])
        self.assertNotIn("pendingUpload", app)
        self.assertGreater(app["releaseAsset"]["size"], 0)

    def test_chunked_ipa_limits_and_malformed_metadata(self):
        tag = "app-mipet-v0-4-20260928T205613Z-a1b2c3d4"
        pending = {"chunks": [{"sha": "a" * 40, "size": 8_000_000} for _ in range(25)],
                   "size": 200_000_000, "tag": tag}
        app = {"ipaFile": "miPet.ipa", "releaseTag": tag, "name": "miPet",
               "marketingVersion": "0.4", "versionDescription": "Update", "pendingUpload": pending}
        self.assertEqual(pipeline.validate_pending(app, "apps")[2], 200_000_000)
        for changes in [{"size": 200_000_001}, {"chunks": []}, {"sha": "b" * 40},
                        {"chunks": [{"sha": "a" * 40, "size": 200_000_000}]},
                        {"chunks": [{"sha": "bad", "size": 200_000_000}]}]:
            with self.subTest(changes=changes), patch.dict(app, {"pendingUpload": {**pending, **changes}}):
                with self.assertRaises(ValueError):
                    pipeline.validate_pending(app, "apps")
        broken = {**pending, "size": 10, "chunks": [{"sha": "a" * 40, "size": 10}]}
        with patch.dict(app, {"pendingUpload": broken}), patch.object(pipeline, "fetch_blob", return_value=b"short"), patch.object(pipeline.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "chunk size mismatch"):
                pipeline.publish_pending({"localApps": {"de.renewitt.mipet": app}}, "owner/repo", "apps", "token")
            run.assert_not_called()

    def test_wrong_bundle_id_is_rejected_before_release_creation(self):
        data = test_ipa("com.example.wrong")
        sha = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
        tag = "app-mipet-v0-4-20260928T205613Z-a1b2c3d4"
        content = {"localApps": {"de.renewitt.mipet": {
            "ipaFile": "miPet-0.4.ipa", "releaseTag": tag, "name": "miPet",
            "marketingVersion": "0.4", "versionDescription": "Neue Animationen",
            "pendingUpload": {"sha": sha, "tag": tag, "size": len(data)},
        }}, "uploadedApps": []}
        with patch.object(pipeline, "fetch_blob", return_value=data), patch.object(pipeline.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "bundle ID"):
                pipeline.publish_pending(content, "zynthec-dev/zynthec-altstore-source", "apps", "test-token")
            run.assert_not_called()

    def test_direct_url_workflow_creates_versioned_release(self):
        content = {"localApps": {"de.renewitt.mipet": {"ipaFile": "miPet-0.3-beta.ipa", "name": "miPet"}}, "uploadedApps": []}
        with tempfile.TemporaryDirectory() as folder:
            ipa = Path(folder) / "miPet-0.4.ipa"
            ipa.write_bytes(test_ipa())
            output = Path(folder) / "content.json"
            with patch.object(pipeline, "CONTENT", output), patch.object(pipeline.subprocess, "run") as run:
                tag = pipeline.publish_url_file(content, "zynthec-dev/zynthec-altstore-source", ipa, "miPet", "0.4", "Neue Animationen")
            self.assertRegex(tag, pipeline.RELEASE_TAG)
            self.assertIn("Neue Animationen", run.call_args_list[0].args[0])
            published = json.loads(output.read_text())["localApps"]["de.renewitt.mipet"]
            self.assertEqual(published["releaseTag"], tag)
            self.assertEqual(published["versionDescription"], "Neue Animationen")


if __name__ == "__main__":
    unittest.main()
