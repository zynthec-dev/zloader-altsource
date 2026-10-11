import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import unquote, urlparse
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not (DIST / "source.json").exists():
            subprocess.run(["python3", "scripts/build.py"], cwd=ROOT, check=True)
        cls.source = json.loads((DIST / "source.json").read_text())
        cls.content = json.loads((ROOT / "catalog/content.json").read_text())
        cls.settings = json.loads((ROOT / "catalog/settings.json").read_text())

    def test_source_contains_only_catalogued_ipas(self):
        selected = {
            app["ipaFile"]
            for app in [*self.content.get("localApps", {}).values(), *self.content.get("uploadedApps", [])]
        }
        spec = importlib.util.spec_from_file_location("source_build", ROOT / "scripts/build.py")
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        bundle_ids = {
            builder.plist_from_ipa(ipa)[0]["CFBundleIdentifier"]
            for ipa in ROOT.glob("*.ipa") if ipa.name in selected
        }
        excluded = set(self.content.get("excludedBundleIdentifiers", []))
        self.assertEqual({app["bundleIdentifier"] for app in self.source["apps"]}, bundle_ids - excluded)
        for app in self.source["apps"]:
            self.assertTrue(app["versions"][0]["downloadURL"].endswith(".ipa"))
            self.assertGreater(app["versions"][0]["size"], 0)

    @unittest.skipUnless((ROOT / "miPet-0.3-beta.ipa").exists(), "miPet release asset is not available")
    def test_mipet_metadata(self):
        app = next(app for app in self.source["apps"] if app["bundleIdentifier"] == "de.renewitt.mipet")
        self.assertEqual(app["versions"][0]["version"], "0.1.0")
        self.assertEqual(app["versions"][0]["marketingVersion"], "0.3-beta")

    def test_catalog_selected_ipa_and_release_tag_are_published(self):
        for app in self.source["apps"]:
            metadata = self.content.get("localApps", {}).get(app["bundleIdentifier"])
            if metadata is None:
                metadata = next((entry for entry in self.content.get("uploadedApps", []) if entry.get("bundleIdentifier") == app["bundleIdentifier"]), None)
            self.assertIsNotNone(metadata)
            url = urlparse(app["versions"][0]["downloadURL"])
            self.assertEqual(Path(unquote(url.path)).name, metadata["ipaFile"])
            self.assertIn(f"/releases/download/{metadata.get('releaseTag', 'apps')}/", url.path)

    def test_excluded_apps_are_not_published(self):
        identifiers = {app["bundleIdentifier"] for app in self.source["apps"]}
        self.assertFalse(identifiers.intersection(self.content.get("excludedBundleIdentifiers", [])))
        self.assertEqual(self.source["featuredApps"], self.content.get("pinnedBundleIdentifiers", []))

    def test_pinned_apps_are_first_and_updateable(self):
        pinned = self.content.get("pinnedBundleIdentifiers", [])
        self.assertEqual([app["bundleIdentifier"] for app in self.source["apps"][:len(pinned)]], pinned)
        for app in self.source["apps"][:len(pinned)]:
            self.assertEqual(app["versions"][0]["sha256"], self.content["localApps"][app["bundleIdentifier"]]["releaseAsset"]["sha256"])

    def test_apps_use_supported_categories(self):
        supported = {"developer", "entertainment", "games", "lifestyle", "other", "photo-video", "social", "utilities"}
        self.assertTrue(all(app["category"] in supported for app in self.source["apps"]))

    def test_feed_has_no_private_origin_metadata(self):
        self.assertTrue(all("_origin" not in app for app in self.source["apps"]))

    def test_public_source_uses_canonical_path(self):
        for key in ("name", "subtitle", "description", "tintColor"):
            self.assertEqual(self.source[key], self.settings[key])
        self.assertEqual(self.source["identifier"], "com.zynthec.source")
        self.assertEqual(self.source["website"], "https://zynthec.com/zloader")
        self.assertEqual(self.source["sourceURL"], "https://zynthec.com/zloader/source.json")
        self.assertEqual(self.source["iconURL"], "https://zynthec.com/zloader/assets/source-icon.png")
        self.assertTrue(all(app["iconURL"].startswith("https://zynthec.com/zloader/assets/") for app in self.source["apps"]))

    def test_custom_source_settings_and_icon_reach_feed_and_admin(self):
        spec = importlib.util.spec_from_file_location("source_settings_build", ROOT / "scripts/build.py")
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        settings = {**self.settings, "name": "Meine Source <&>", "subtitle": "Eigene Apps",
                    "description": "Eine neue Beschreibung", "tintColor": "#123456"}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "catalog").mkdir()
            (root / "catalog/settings.json").write_text(json.dumps(settings))
            (root / "catalog/content.json").write_text(json.dumps({"localApps": {}, "uploadedApps": []}))
            shutil.copytree(ROOT / "site", root / "site")
            icon = b"test source icon"
            (root / "icon.png").write_bytes(icon)
            with patch.object(builder, "ROOT", root), patch.object(builder, "CATALOG", root / "catalog"), patch.object(builder, "DIST", root / "dist"):
                builder.build()
            feed = json.loads((root / "dist/source.json").read_text())
            for key in ("name", "subtitle", "description", "tintColor", "identifier", "sourceURL"):
                self.assertEqual(feed[key], settings[key])
            self.assertEqual((root / "dist/assets/source-icon.png").read_bytes(), icon)
            self.assertIn("Meine Source &lt;&amp;&gt;", (root / "dist/admin/index.html").read_text())

    def test_landing_page_links_current_release_and_public_app_repo(self):
        page = (DIST / "zloader/index.html").read_text()
        self.assertIn('https://github.com/zynthec-dev/zloader-app', page)
        self.assertNotIn('href="/zloader/source.json"', page)
        self.assertIn('value="zynthec.com/zloader/source.json"', page)
        self.assertIn('src="/zloader/site.js"', page)
        self.assertNotIn('{{ZLOADER_', page)
        app = next((app for app in self.source["apps"] if app["bundleIdentifier"] == "com.zynthec.zLoader"), None)
        if app:
            self.assertIn(app["versions"][0]["downloadURL"], page)
        self.assertTrue((DIST / "zloader/site.css").is_file())

    def test_asset_base_supports_json_and_legacy_root_urls(self):
        spec = importlib.util.spec_from_file_location("source_asset_build", ROOT / "scripts/build.py")
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        for url, expected in (("https://example.com/zloader/source.json", "https://example.com/zloader/"),
                              ("https://example.com", "https://example.com/"),
                              ("https://example.com/source/", "https://example.com/source/")):
            self.assertEqual(builder.asset_base({"sourceURL": url}), expected)

    def test_configured_apps_have_valid_release_filenames(self):
        apps = [*self.content.get("localApps", {}).values(), *self.content.get("uploadedApps", [])]
        filenames = [app.get("ipaFile") for app in apps]
        self.assertTrue(all(isinstance(filename, str) and filename.strip().endswith(".ipa") for filename in filenames))
        self.assertEqual(len(filenames), len(set(filenames)))

    def test_admin_is_built_without_storefront_or_installer_artifacts(self):
        self.assertTrue((DIST / "admin" / "index.html").exists())
        admin_html = (DIST / "admin" / "index.html").read_text()
        for unwanted in ('href="/admin/', 'src="/admin/', 'href="/assets/', 'src="/assets/',
                         "Erweiterte Verbindung", 'id="repo"', 'id="branch"'):
            self.assertNotIn(unwanted, admin_html)
        for unwanted in ("index.html", "app.js", "styles.css", "data/catalog.json", "data/loaders.json", "zloader.mobileconfig"):
            self.assertFalse((DIST / unwanted).exists())


if __name__ == "__main__":
    unittest.main()
