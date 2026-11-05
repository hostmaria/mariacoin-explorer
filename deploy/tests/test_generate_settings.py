import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
GENERATOR = ROOT / "deploy/eiquidus/generate-settings.py"


class SettingsGeneratorTests(unittest.TestCase):
    def test_renders_private_fail_closed_settings_from_root_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            template = d / "template.json"
            rpc = d / "maria.conf"
            mongo = d / "mongo.json"
            output = d / "settings.json"
            template.write_text(json.dumps({
                "coin": {}, "wallet": {}, "dbsettings": {},
                "webserver": {"tls": {}, "cors": {}},
                "api_page": {}, "markets_page": {}, "plugins": {}
            }), encoding="utf-8")
            rpc.write_text("rpcuser=rpc_user\nrpcpassword=rpc_secret\n", encoding="utf-8")
            mongo.write_text(json.dumps({"username": "db_user", "password": "db_secret", "database": "mariacoin"}), encoding="utf-8")
            subprocess.run([sys.executable, str(GENERATOR), "--template", str(template), "--rpc-config", str(rpc), "--mongodb-credentials", str(mongo), "--output", str(output)], check=True)
            rendered = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual({"name": "MariaCoin", "symbol": "$maria"}, rendered["coin"])
            self.assertEqual(("127.0.0.1", 47774, "rpc_user", "rpc_secret"), (rendered["wallet"]["host"], rendered["wallet"]["port"], rendered["wallet"]["username"], rendered["wallet"]["password"]))
            self.assertEqual(60000, rendered["wallet"]["timeout"])
            self.assertEqual(("127.0.0.1", 27017, "db_user", "db_secret", "mariacoin"), (rendered["dbsettings"]["address"], rendered["dbsettings"]["port"], rendered["dbsettings"]["user"], rendered["dbsettings"]["password"], rendered["dbsettings"]["database"]))
            self.assertFalse(rendered["webserver"]["tls"]["enabled"])
            self.assertFalse(rendered["webserver"]["cors"]["enabled"])
            self.assertTrue(rendered["network_page"]["enabled"])
            self.assertTrue(rendered["network_page"]["connections_table"]["enabled"])
            self.assertFalse(rendered["network_page"]["addnodes_table"]["enabled"])
            self.assertFalse(rendered["network_page"]["onetry_table"]["enabled"])
            self.assertEqual(-1, rendered["network_page"]["connections_table"]["port_filter"])
            self.assertTrue(rendered["sync"]["peer_geolocation_enabled"])
            self.assertTrue(rendered["api_page"]["enabled"])
            self.assertFalse(rendered["markets_page"]["enabled"])
            self.assertTrue(rendered["plugins"]["plugin_secret_code"])
    def test_renders_the_real_commented_template_with_mariacoin_identity(self):
        source_template = ROOT / "settings.json.template"
        if not source_template.is_file():
            self.skipTest("source-only settings template is intentionally excluded from deployment artifacts")
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            rpc = d / "maria.conf"
            mongo = d / "mongo.json"
            output = d / "settings.json"
            rpc.write_text("rpcuser=rpc_user\nrpcpassword=rpc_secret\n", encoding="utf-8")
            mongo.write_text(json.dumps({"username": "db_user", "password": "db_secret", "database": "mariacoin"}), encoding="utf-8")
            subprocess.run([
                sys.executable, str(GENERATOR), "--template", str(source_template),
                "--rpc-config", str(rpc), "--mongodb-credentials", str(mongo), "--output", str(output)
            ], check=True)
            rendered = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual("0000040cb60b26f13ffcd2f692d679e172da34096041efe215d8c50cd65dd9f9", rendered["block_page"]["genesis_block"])
            self.assertEqual("5e82501aa4f898173ca938fef4d080f25969109efd7b790fe323bcff9f16dc04", rendered["transaction_page"]["genesis_tx"])
            self.assertEqual("MariaCoin Explorer", rendered["shared_pages"]["page_title"])
            self.assertEqual("/img/maria-logo.png", rendered["shared_pages"]["logo"])
            self.assertEqual("/img/maria-logo.png", rendered["shared_pages"]["page_header"]["home_link_logo"])
            self.assertEqual("/img/mariacoin-logo-square.png", rendered["shared_pages"]["page_header"]["page_title_image"]["image_path"])
            self.assertFalse(rendered["shared_pages"]["show_hashrate"])
            self.assertEqual([], rendered["shared_pages"]["page_footer"]["social_links"])
            self.assertTrue(rendered["api_page"]["enabled"])
            self.assertTrue(rendered["api_page"]["public_apis"]["rpc"]["getblockcount"]["enabled"])
            self.assertTrue(rendered["api_page"]["public_apis"]["ext"]["getmoneysupply"]["enabled"])
            self.assertEqual([], rendered["default_coingecko_ids"])
            self.assertTrue(rendered["network_page"]["enabled"])
            self.assertTrue(rendered["network_page"]["connections_table"]["enabled"])
            self.assertFalse(rendered["network_page"]["addnodes_table"]["enabled"])
            self.assertFalse(rendered["network_page"]["onetry_table"]["enabled"])
            self.assertTrue(rendered["sync"]["peer_geolocation_enabled"])
            self.assertTrue(rendered["claim_address_page"]["enabled"])
            self.assertTrue(rendered["claim_address_page"]["show_header_menu"])
            self.assertFalse(rendered["claim_address_page"]["enable_captcha"])
            self.assertFalse(rendered["claim_address_page"]["enable_bad_word_filter"])
            self.assertTrue(rendered["api_cmds"]["use_rpc"])
            self.assertEqual(4, rendered["api_cmds"]["rpc_concurrent_tasks"])
            self.assertEqual("verifymessage", rendered["api_cmds"]["verifymessage"])
            self.assertFalse(rendered["api_page"]["public_apis"]["rpc"].get("verifymessage", {}).get("enabled", False))
            self.assertNotIn('"Exor"', json.dumps(rendered))


if __name__ == "__main__":
    unittest.main()
