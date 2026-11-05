import json
import hashlib
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy"
HOST = "explorer.mariacoin.com"


def text(relative: str) -> str:
    return (DEPLOY / relative).read_text(encoding="utf-8")


def contrast_ratio(first: str, second: str) -> float:
    def luminance(value: str) -> float:
        channels = [int(value[index:index + 2], 16) / 255 for index in (1, 3, 5)]
        linear = [channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4 for channel in channels]
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]

    values = sorted((luminance(first), luminance(second)), reverse=True)
    return (values[0] + 0.05) / (values[1] + 0.05)


class DeploymentPolicyTests(unittest.TestCase):
    def test_release_builder_normalizes_shell_line_endings(self):
        builder = text("eiquidus/build-release.py")
        self.assertIn('payload.replace(b"\\r\\n", b"\\n").replace(b"\\r", b"\\n")', builder)

    def test_daemon_installer_pins_and_verifies_official_release(self):
        installer = text("mariacoin/install-daemon.sh")
        self.assertIn("https://github.com/hostmaria/mariacoin/releases/download/v5.5.1/maria-5.5.1-ubuntu18-daemon.zip", installer)
        self.assertIn("0d15861e7e0de787313464a5a35dc3e9cdda68a092b0104173b4daaa456b27ba", installer)
        self.assertIn("db03a3dd390c74a7136a44b06b600fe525f181aaef5915273908cb6453ae2030", installer)
        self.assertIn("sha256sum --check --strict", installer)
        self.assertIn("/opt/mariacoin/5.5.1", installer)

    def test_daemon_is_unprivileged_loopback_rpc_and_non_staking(self):
        config = text("mariacoin/maria.conf.template")
        unit = text("systemd/mariacoind.service")
        for setting in ("port=47773", "rpcport=47774", "rpcbind=127.0.0.1", "rpcallowip=127.0.0.1", "txindex=1", "disablewallet=1", "staking=0", "coldstaking=0", "maxconnections=32", "dbcache=100", "maxmempool=50"):
            self.assertIn(setting, config)
        self.assertIn("User=mariacoin", unit)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertNotIn("User=root", unit)
        self.assertTrue((DEPLOY / "logrotate/mariacoin").is_file())
        self.assertTrue((DEPLOY / "mariacoin/install-params.sh").is_file())

    def test_node_is_exactly_pinned_and_archive_verified(self):
        installer = text("node/install-node.sh")
        self.assertIn('NODE_VERSION="24.18.0"', installer)
        self.assertIn('ARCHIVE_SHA="55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742"', installer)
        self.assertIn("sha256sum --check --strict", installer)
        self.assertNotIn("SHASUMS256.txt", installer)
        self.assertNotIn("nodesource", installer.lower())

    def test_mongodb_is_private_authenticated_replica_set(self):
        config = text("mongodb/mongod.conf")
        installer = text("mongodb/install-mongodb.sh")
        transaction = text("mongodb/verify-transaction.js")
        self.assertIn("bindIp: 127.0.0.1", config)
        self.assertIn("authorization: enabled", config)
        self.assertIn("replSetName: mariacoin-rs", config)
        self.assertIn("keyFile: /etc/mongodb-keyfile", config)
        self.assertIn("openssl rand -base64 756", installer)
        self.assertIn("chmod 0400 /etc/mongodb-keyfile", installer)
        self.assertIn("/etc/logrotate.d/mongodb", installer)
        self.assertIn("maxsize 200M", (DEPLOY / "logrotate/mongodb").read_text(encoding="utf-8"))
        self.assertIn("replSetInitiate", installer)
        self.assertIn("isWritablePrimary", installer)
        self.assertIn("readWrite", text("mongodb/create-app.js"))
        self.assertIn("adb.auth(admin.username, admin.password)", text("mongodb/create-app.js"))
        self.assertIn('MONGODB_VERSION="8.0.28"', installer)
        self.assertIn("mongodb-org=${MONGODB_VERSION}", installer)
        self.assertIn("startTransaction", transaction)
        self.assertIn("abortTransaction", transaction)

    def test_root_scripts_use_safe_path_and_params_are_downloaded_directly(self):
        for script in DEPLOY.rglob("*.sh"):
            self.assertIn("export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", script.read_text(encoding="utf-8"), str(script))
        params = text("mariacoin/install-params.sh")
        self.assertIn("https://download.z.cash/downloads/sapling-spend.params", params)
        self.assertIn("https://download.z.cash/downloads/sapling-output.params", params)
        self.assertNotIn("fetch-params.sh", params)

    def test_maintenance_page_uses_only_local_branding(self):
        page = text("nginx/maintenance.html")
        self.assertIn('src="/maria-logo.png"', page)
        self.assertNotIn("https://www.mariacoin.com", page)

    def test_eiquidus_is_immutable_secret_separated_and_systemd_owned(self):
        installer = text("eiquidus/install-eiquidus.sh")
        publisher = text("eiquidus/publish-release.py")
        web = text("systemd/eiquidus-web.service")
        sync = text("systemd/eiquidus-sync.service")
        sync_script = (ROOT / "scripts/sync.js").read_text(encoding="utf-8")
        timer = text("systemd/eiquidus-sync.timer")
        mongo_preflight = text("eiquidus/mongodb-preflight.js")
        index_verifier = text("eiquidus/verify-index.js")
        self.assertIn("sha256sum", installer)
        self.assertIn("/opt/eiquidus/releases", installer)
        self.assertIn("/etc/eiquidus/settings.json", installer)
        self.assertIn("root:eiquidus", installer)
        self.assertIn("0640", installer)
        self.assertIn("npm ci --omit=dev --ignore-scripts", installer)
        self.assertIn("STAGING=/var/lib/eiquidus/staging", installer)
        self.assertIn("staged files must be regular root-owned mode-0600 files", installer)
        self.assertNotIn("/tmp/settings.json", installer)
        self.assertIn('[[ $release == ${expected:0:40} ]]', installer)
        self.assertIn("publish-release.py", installer)
        self.assertIn("RENAME_NOREPLACE", publisher)
        self.assertIn("rollback_install", installer)
        self.assertIn("flock -n", installer)
        self.assertIn("previous_current", installer)
        self.assertIn("systemd-analyze verify", installer)
        self.assertNotIn('/usr/local/bin/node ./scripts/prestart.js', installer)
        self.assertNotIn('EIQUIDUS_MONGODB_INDEX_MIGRATION=1', installer)
        early_preflight = 'EIQUIDUS_RELEASE_ROOT="$EIQUIDUS_VERIFIED_ROOT"'
        readonly_preflight = 'EIQUIDUS_RELEASE_ROOT="$stage"'
        self.assertEqual(installer.count(early_preflight), 1)
        self.assertEqual(installer.count(readonly_preflight), 1)
        self.assertEqual(installer.count('EIQUIDUS_MONGODB_CREDENTIALS=/etc/eiquidus/mongodb-app.json'), 2)
        self.assertEqual(installer.count('EIQUIDUS_MONGODB_INDEX_MIGRATION=0'), 2)
        self.assertEqual(installer.count('EIQUIDUS_ALLOW_ORPHAN_MIGRATION_RESUME=0'), 2)
        self.assertIn('unset EIQUIDUS_MONGODB_INDEX_MIGRATION EIQUIDUS_MONGODB_CREDENTIALS EIQUIDUS_ALLOW_ORPHAN_MIGRATION_RESUME', installer)
        self.assertLess(installer.index(early_preflight), installer.index("install -d -o root"))
        self.assertLess(installer.index(early_preflight), installer.index("install -o root -g eiquidus -m 0640 \"$SETTINGS\""))
        self.assertLess(installer.index('rm -f "$ARCHIVE" "$SUM" "$ID" "$SETTINGS"'), installer.index("committed=true"))
        self.assertLess(installer.index("systemd-analyze verify"), installer.index('python3 "$stage/deploy/eiquidus/publish-release.py"'))
        publication = installer.index('python3 "$stage/deploy/eiquidus/publish-release.py"')
        self.assertLess(installer.index(readonly_preflight), publication)
        self.assertLess(publication, installer.index('install -o root -g eiquidus -m 0640 "$SETTINGS"'))
        self.assertLess(publication, installer.index('install -o eiquidus -g eiquidus -m 0640 /dev/null'))
        self.assertIn('$target/deploy/eiquidus/preflight.sh', installer)
        self.assertIn('$target/deploy/eiquidus/verify-index.js', installer)
        self.assertIn('$target/deploy/nginx/maintenance.conf', installer)
        self.assertIn('$target/deploy/nginx/maintenance-tls.conf', installer)
        self.assertIn('$target/deploy/nginx/maintenance.html', installer)
        self.assertIn('/var/www/maintenance/maintenance.html', installer)
        self.assertIn('/var/www/maintenance/maria-logo.png', installer)
        self.assertLess(installer.index("trap rollback_install EXIT"), installer.index("install -d -o root"))
        self.assertIn("directory_existed", installer)
        self.assertIn('$stage/deploy/systemd/eiquidus-web.service', installer)
        self.assertNotIn('/tmp/preflight.sh', installer)
        for generated in ("_theme-selector.scss", "style.min.css", "custom.min.css"):
            self.assertIn(generated, installer)
        self.assertIn("User=eiquidus", web)
        self.assertIn("EIQUIDUS_MONGODB_CREDENTIALS=/etc/eiquidus/mongodb-app.json", web)
        self.assertIn("EIQUIDUS_MONGODB_INDEX_MIGRATION=0", web)
        self.assertIn("EIQUIDUS_ALLOW_ORPHAN_MIGRATION_RESUME=0", web)
        self.assertIn("ExecStartPre=+/usr/local/libexec/eiquidus/verify-index.js --verify-marker", web)
        self.assertIn("127.0.0.1:3001", web)
        self.assertIn("ProtectSystem=strict", web)
        self.assertIn("Type=oneshot", sync)
        self.assertIn("./scripts/sync.js index update", sync)
        self.assertIn("./scripts/sync.js masternodes", sync)
        self.assertIn("./scripts/sync.js peers", sync)
        self.assertIn("EIQUIDUS_ALLOW_ORPHAN_MIGRATION_RESUME=1", sync)
        self.assertIn("EIQUIDUS_MONGODB_CREDENTIALS=/etc/eiquidus/mongodb-app.json", sync)
        self.assertIn("EIQUIDUS_MONGODB_INDEX_MIGRATION=0", sync)
        self.assertIn("mongoose.connect(dbString, {autoIndex: false})", sync_script)
        self.assertIn("Stats.find({coin: settings.coin.name})", sync_script)
        self.assertIn("orphan_reconciliation: 1", sync_script)
        self.assertLess(sync_script.index("Stats.find({coin: settings.coin.name})"), sync_script.index("db.check_stats(settings.coin.name"))
        self.assertLess(sync_script.index("orphan_reconciliation: 1"), sync_script.index("db.check_stats(settings.coin.name"))
        self.assertIn("Incomplete orphan reconciliation blocks ordinary application startup", mongo_preflight)
        self.assertIn("incomplete orphan reconciliation blocks index verification", index_verifier)
        self.assertLess(sync.index("./scripts/sync.js index update"), sync.index("./scripts/sync.js masternodes"))
        self.assertLess(sync.index("./scripts/sync.js masternodes"), sync.index("./scripts/sync.js peers"))
        self.assertIn("Persistent=true", timer)
        combined = installer + web + sync + timer
        self.assertNotRegex(combined.lower(), r"\bpm2\b|\bforever\b|\bcron\b")

    def test_root_installer_reexecs_only_the_authenticated_extracted_candidate(self):
        installer = text("eiquidus/install-eiquidus.sh")
        runbook = text("README.md")
        self.assertIn('EIQUIDUS_VERIFIED_ROOT', installer)
        self.assertIn('verification_stage=$(mktemp -d "$STAGING/.verified.XXXXXX")', installer)
        self.assertIn('candidate_installer="$verification_stage/deploy/eiquidus/install-eiquidus.sh"', installer)
        self.assertIn('EIQUIDUS_VERIFIED_ROOT="$verification_stage" "$candidate_installer"', installer)
        self.assertIn('-u EIQUIDUS_MONGODB_INDEX_MIGRATION', installer)
        self.assertIn('-u EIQUIDUS_MONGODB_CREDENTIALS', installer)
        self.assertIn('-u EIQUIDUS_ALLOW_ORPHAN_MIGRATION_RESUME', installer)
        self.assertIn('[[ "$self_path" == "$EIQUIDUS_VERIFIED_ROOT/deploy/eiquidus/install-eiquidus.sh" ]]' , installer)
        self.assertIn('authenticated extraction of the candidate', runbook)
        self.assertLess(installer.index('-u EIQUIDUS_MONGODB_INDEX_MIGRATION'), installer.index('rollback_dir=$(mktemp -d'))


    def test_backups_are_authenticated_serialized_and_restore_tested(self):
        installer = text("eiquidus/install-eiquidus.sh")
        backup = text("eiquidus/backup-eiquidus.sh")
        restore = text("eiquidus/verify-eiquidus-backup.sh")
        activation = text("eiquidus/activate-production.sh")
        service = text("systemd/eiquidus-backup.service")
        timer = text("systemd/eiquidus-backup.timer")
        runbook = text("README.md")
        for payload in ("backup-eiquidus.sh", "verify-eiquidus-backup.sh", "eiquidus-backup.service", "eiquidus-backup.timer"):
            self.assertIn(payload, installer)
        self.assertIn("flock -n", backup)
        self.assertIn("mongodump --config=", backup)
        self.assertNotIn("--password=", backup)
        self.assertNotIn("f'username:", backup)
        self.assertIn("quote(c[\"username\"]", backup)
        self.assertIn("sha256sum", backup)
        self.assertIn("publish-release.py", backup)
        self.assertIn("DATABASE-MANIFEST.json", backup)
        self.assertLess(backup.index("DATABASE-MANIFEST.json"), backup.index("mongodump --config="))
        self.assertIn("-name '20??????T??????Z'", backup)
        self.assertIn("keep_count=${BACKUP_KEEP_COUNT:-2}", backup)
        self.assertIn('tail -n +"$((keep_count + 1))"', backup)
        self.assertNotIn("-mtime", backup)
        self.assertIn('release=$(basename "$(readlink -f /opt/eiquidus/current)")', backup)
        self.assertIn("production_nginx=/etc/nginx/sites-available/maria-production-$release.conf", backup)
        self.assertIn("/etc/nginx/sites-available/maria-maintenance.conf", backup)
        self.assertIn("/etc/nginx/sites-available/maria-maintenance-tls.conf", backup)
        self.assertIn("/var/www/maintenance/maintenance.html", backup)
        self.assertIn("/var/www/maintenance/maria-logo.png", backup)
        self.assertIn("systemctl stop eiquidus-web.service", backup)
        self.assertIn("web writer did not quiesce for backup", backup)
        self.assertIn("systemctl start eiquidus-web.service", backup)
        self.assertIn('maintenance_tls=/etc/nginx/sites-available/maria-maintenance-tls.conf', backup)
        self.assertIn('select_nginx_target "$maintenance_tls"', backup)
        self.assertIn('select_nginx_target "$nginx_enabled_target"', backup)
        self.assertIn("restore_runtime || cleanup_failed=true", backup)
        self.assertIn("wait_web_ready", backup)
        self.assertIn("systemctl is-active --quiet eiquidus-web.service", backup)
        self.assertIn("curl --fail --silent --show-error --max-time 2 http://127.0.0.1:3001/", backup)
        self.assertIn("systemctl start eiquidus-web.service && wait_web_ready", backup)
        self.assertLess(backup.index('select_nginx_target "$maintenance_tls"'), backup.index("systemctl stop eiquidus-web.service"))
        self.assertLess(backup.index("trap 'rm -f"), backup.index('stage=$(mktemp -d'))
        self.assertLess(backup.index("web_was_active=false"), backup.index('select_nginx_target "$nginx_enabled_target"'))
        self.assertLess(backup.index("backup_inputs=("), backup.index("mongodump"))
        self.assertIn("[[ -L $nginx_selector ]]", backup)
        self.assertIn("nginx_enabled_target=$(readlink -f", backup)
        self.assertIn("enabled Nginx selector target is not an authenticated release input", backup)
        self.assertLess(backup.index("nginx_enabled_target=$(readlink -f"), backup.index("mongodump"))
        self.assertNotIn("sites-enabled/maria.stakersforum.com", backup)
        self.assertIn("mongorestore --config=", restore)
        self.assertIn("mariacoin_restore_test", restore)
        self.assertIn("BACKUP_VERIFIED.json", restore)
        self.assertLess(restore.index("drop_restore_database\nmongorestore"), restore.index("BACKUP_RESTORE_VERIFIED"))
        self.assertIn("restored collection set mismatch", restore)
        self.assertIn("manifest.counts", restore)
        self.assertIn("count mismatch", restore)
        self.assertIn("backup transaction count mismatch", backup)
        self.assertIn("restored Stats transaction count mismatch", restore)
        self.assertIn("name==='claimchallenges'", restore)
        self.assertIn("challenge count increased during restore", restore)
        self.assertIn("Number.isSafeInteger(expectedCount)", restore)
        self.assertIn("invalid manifest count", restore)
        self.assertIn("restored Claim address unique index missing", restore)
        self.assertIn("restored challenge TTL index missing", restore)
        self.assertIn("restored Stats coin unique index missing", restore)
        self.assertIn("restored rich-list Claim projection mismatch", restore)
        self.assertIn("restored Masternode Claim projection mismatch", restore)
        self.assertIn("User=root", service)
        self.assertIn("ProtectSystem=strict", service)
        self.assertIn("/etc/nginx/sites-enabled", service)
        # nginx -t validates the maintenance selector and writes its configured error log.
        # The backup sandbox must permit that log directory or every scheduled backup fails.
        self.assertIn("/var/log/nginx", service)
        for field in ("manifestSha256", "checksumsSha256", "archiveSha256"):
            self.assertIn(field, restore)
            self.assertIn(field, activation)
        self.assertIn("sha256sum -c", activation)
        self.assertIn("backup-eiquidus.sh", runbook)
        self.assertIn("verify-eiquidus-backup.sh", runbook)
        self.assertLess(runbook.index("backup-eiquidus.sh"), runbook.index("activate-production.sh"))
        self.assertIn("set +e", backup)
        self.assertIn("set +e", restore)
        self.assertLess(backup.index("set +e", backup.index("cleanup()")), backup.index("restore_runtime || cleanup_failed=true"))
        self.assertLess(restore.index("set +e", restore.index("cleanup()")), restore.index("drop_restore_database >/dev/null"))
        self.assertIn("Persistent=true", timer)

    def test_backup_cleanup_and_activation_evidence_fail_closed(self):
        backup = text("eiquidus/backup-eiquidus.sh")
        restore = text("eiquidus/verify-eiquidus-backup.sh")
        activation = text("eiquidus/activate-production.sh")

        backup_cleanup = "cleanup() {" + backup.split("cleanup() {", 1)[1].split("\n}\ntrap cleanup EXIT", 1)[0] + "\n}"
        probe = subprocess.run(
            ["bash", "-c", "set +e\nconfig=/mock\nstage=\nrestore_runtime(){ echo RESTORE_RAN; return 0; }\nrm(){ return 1; }\n" + backup_cleanup + "\nfalse\ncleanup"],
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(probe.returncode, 70)
        self.assertIn("RESTORE_RAN", probe.stdout)

        restore_cleanup = "cleanup() {" + restore.split("cleanup() {", 1)[1].split("\n}\ntrap cleanup EXIT", 1)[0] + "\n}"
        probe = subprocess.run(
            ["bash", "-c", "set +e\nconfig=/mock\nverification_marker=/mock-marker\ndrop_restore_database(){ echo DROP_RAN >&2; return 0; }\nrm(){ return 1; }\n" + restore_cleanup + "\nfalse\ncleanup"],
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(probe.returncode, 70)
        self.assertIn("DROP_RAN", probe.stderr)

        validator = activation.split("verified_backup=$(python3 - \"$BACKUP_MARKER\" \"$CURRENT\" <<'PY'\n", 1)[1].split("\nPY\n)", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "backups"
            backup_dir = root / "20260731T120000Z"
            current = Path(directory) / ("a" * 40)
            marker = Path(directory) / "BACKUP_VERIFIED.json"
            backup_dir.mkdir(parents=True)
            current.mkdir()
            members = {
                "DATABASE-MANIFEST.json": b"{}\n",
                "SHA256SUMS": b"placeholder checksum inventory\n",
                "mongodb.archive.gz": b"archive bytes",
            }
            for name, payload in members.items():
                (backup_dir / name).write_bytes(payload)
            evidence = {
                "schemaVersion": 1,
                "backup": str(backup_dir),
                "release": str(current.resolve()),
                "verifiedAt": "2026-07-31T12:00:00+00:00",
                "manifestSha256": hashlib.sha256(members["DATABASE-MANIFEST.json"]).hexdigest(),
                "checksumsSha256": hashlib.sha256(members["SHA256SUMS"]).hexdigest(),
                "archiveSha256": hashlib.sha256(members["mongodb.archive.gz"]).hexdigest(),
            }
            marker.write_text(json.dumps(evidence), encoding="utf-8")
            marker.chmod(0o600)
            validator = validator.replace("'/var/backups/mariacoin-explorer'", repr(str(root.resolve())))
            # Windows does not expose POSIX owner/mode semantics; retain the real
            # symlink/regular-file and all digest checks in this portable harness.
            validator = validator.replace(
                "metadata.st_uid != 0 or metadata.st_gid != 0 or metadata.st_mode & 0o777 != 0o600",
                "False",
            )
            validator = validator.replace(
                "member.st_uid != 0 or member.st_gid != 0 or member.st_mode & 0o777 != 0o600",
                "False",
            )

            def validate():
                return subprocess.run(
                    [sys.executable, "-", str(marker), str(current)], input=validator,
                    text=True, capture_output=True, check=False,
                )

            valid = validate()
            self.assertEqual(valid.returncode, 0, valid.stderr)
            for name in ("DATABASE-MANIFEST.json", "SHA256SUMS", "mongodb.archive.gz"):
                path = backup_dir / name
                original = path.read_bytes()
                path.write_bytes(original + b"corrupt")
                self.assertNotEqual(validate().returncode, 0, name)
                path.write_bytes(original)

    def test_restore_count_policy_rejects_malformed_manifests_and_growth(self):
        restore = text("eiquidus/verify-eiquidus-backup.sh")
        block = restore.split("// BEGIN RESTORED COUNT POLICY", 1)[1].split("// END RESTORED COUNT POLICY", 1)[0]

        def accepted(name, count, counts):
            script = (
                f"const name={json.dumps(name)},count={json.dumps(count)},"
                f"manifest={{counts:{json.dumps(counts)}}};" + block
            )
            return subprocess.run(["node", "-e", script], capture_output=True, text=True).returncode == 0

        self.assertTrue(accepted("claimchallenges", 0, {"claimchallenges": 1}))
        self.assertTrue(accepted("claimchallenges", 1, {"claimchallenges": 1}))
        self.assertFalse(accepted("claimchallenges", 2, {"claimchallenges": 1}))
        self.assertFalse(accepted("claimchallenges", 0, {}))
        self.assertFalse(accepted("claimchallenges", 0, {"claimchallenges": "1"}))
        self.assertFalse(accepted("claimchallenges", 0, {"claimchallenges": -1}))
        self.assertFalse(accepted("claimchallenges", 0, {"claimchallenges": 1.5}))
        self.assertTrue(accepted("txes", 7, {"txes": 7}))
        self.assertFalse(accepted("txes", 6, {"txes": 7}))

    def test_release_builder_excludes_private_hermes_workspace_files(self):
        builder = text("eiquidus/build-release.py")
        self.assertIn('excluded_parts = {".hermes"', builder)
        # The upstream template embeds password-looking values. It is not runtime input
        # and must never enter a production deployment archive.
        self.assertIn('EXCLUDED_FILES = {"settings.json.template"}', builder)

    def test_mongodb_preflight_uses_the_generated_urlencoded_password(self):
        preflight = text("eiquidus/mongodb-preflight.js")
        installer = text("eiquidus/install-eiquidus.sh")
        index_verifier = text("eiquidus/verify-index.js")
        restore = text("eiquidus/verify-eiquidus-backup.sh")
        database = (ROOT / "lib" / "database.js").read_text(encoding="utf-8")
        self.assertIn("${p}@127.0.0.1", preflight)
        self.assertIn("EIQUIDUS_MONGODB_CREDENTIALS", preflight)
        self.assertIn("c.authSource || (allowIndexMigration ? 'admin' : databaseName)", preflight)
        self.assertNotIn(":***@", preflight)
        self.assertIn("startTransaction", preflight)
        self.assertIn("abortTransaction", preflight)
        self.assertIn("countDocuments", preflight)
        self.assertIn("claimaddresses", preflight)
        self.assertIn("claimchallenges", preflight)
        self.assertIn("expireAfterSeconds: 0", preflight)
        self.assertIn("CLAIM_INDEXES_OK", preflight)
        self.assertIn("coinstats", preflight)
        self.assertIn("STATS_INDEX_OK", preflight)
        self.assertIn("addresstxes", preflight)
        self.assertIn("ADDRESS_TRANSACTION_INDEX_OK", preflight)
        self.assertIn("a_id: 1, txid: 1, role: 1", preflight)
        self.assertIn("role: {$ifNull: ['$role', null]}", preflight)
        self.assertIn("duplicate AddressTx projection identities", preflight)
        self.assertIn("AddressTx projection exact unique index missing", index_verifier)
        self.assertIn("restored AddressTx projection unique index missing", restore)
        self.assertNotIn("dropIndex", preflight)
        self.assertIn("prepareUnique", preflight)
        self.assertIn("dryRun: true", preflight)
        self.assertIn("entries.length === 1", preflight)
        self.assertIn("EIQUIDUS_MONGODB_INDEX_MIGRATION", preflight)
        self.assertIn("if (!current && !allowIndexMigration)", preflight)
        self.assertIn("allowIndexMigration ? 'admin' : databaseName", preflight)
        self.assertIn("listCollections({name: '__deployment_transaction_probe'}", preflight)
        self.assertNotIn("/etc/eiquidus/mongodb-admin.json", installer)
        self.assertNotIn("EIQUIDUS_MONGODB_INDEX_MIGRATION=1", installer)
        self.assertNotIn("safe MongoDB administrator credentials required", installer)
        self.assertIn("mongoose.set('autoIndex', false)", database)
        self.assertIn("mongoose.connect(database, {autoIndex: false})", database)
        for source in (preflight, index_verifier, restore):
            self.assertIn("partialFilterExpression", source)
            self.assertIn("sparse", source)
            self.assertIn("collation", source)

    def test_nginx_is_maintenance_first_exact_host_and_activation_gated(self):
        maintenance = text("nginx/maintenance.conf")
        maintenance_tls = text("nginx/maintenance-tls.conf")
        production = text("nginx/production.conf")
        activation = text("eiquidus/activate-production.sh")
        self.assertIn(f"server_name {HOST};", maintenance)
        self.assertIn(f"server_name {HOST};", production)
        self.assertIn("location ~* ^/claim", production)
        self.assertIn("location = /maria-logo.png", maintenance)
        self.assertIn("location = /maria-logo.png", maintenance_tls)
        self.assertIn("proxy_pass http://127.0.0.1:3001;", production)
        self.assertRegex(production, r"location \^~ /system/restartexplorer\s*\{\s*return 404;")
        self.assertNotIn("app.use('/system/restartexplorer'", (ROOT / "app.js").read_text(encoding="utf-8"))
        self.assertIn("/var/lib/eiquidus/INDEX_VERIFIED.json", activation)
        self.assertIn("/var/lib/eiquidus/BACKUP_VERIFIED.json", activation)
        self.assertIn("backup was not verified for the current release", activation)
        self.assertIn("verify-index.js --verify-marker", activation)
        verifier = text("eiquidus/verify-index.js")
        for evidence in ("getblockchaininfo", "getblockhash", "coinstats", "txes", "addresses", "addresstxes", "COLDSTAKE_TXID", "SAPLING_TXID", "tipHash", "valueBalanceSat"):
            self.assertIn(evidence, verifier)
        self.assertIn("chain.initial_block_downloading === false", verifier)
        self.assertIn("Number(chain.verificationprogress) >= 0.99999", verifier)
        self.assertIn("stats.last >= marker.tip", verifier)
        self.assertIn("stats.last <= daemonTip", verifier)
        self.assertIn("markerTipHash === marker.tipHash", verifier)
        self.assertIn("markerStat.uid === 0 && markerStat.gid === 0", verifier)
        self.assertIn("(markerStat.mode & 0o777) === 0o600", verifier)
        self.assertIn("/^\\d+\\.\\d{8}$/.test(marker.moneySupply)", verifier)
        self.assertIn("new Date(marker.verifiedAt).toISOString() === marker.verifiedAt", verifier)
        self.assertIn("openssl x509 -checkhost", activation)
        self.assertIn("trap rollback EXIT", activation)
        self.assertIn("ROLLBACK_OVERRIDE=/etc/systemd/system/eiquidus-web.service.d/rollback-known-working.conf", activation)
        self.assertIn("systemctl show eiquidus-web.service --property=DropInPaths --value", activation)
        self.assertIn("unapproved effective web service drop-in", activation)
        self.assertIn("unapproved on-disk web service drop-in", activation)
        self.assertIn("maria-maintenance-tls.conf", activation)
        self.assertIn("--property=FragmentPath --value", activation)
        self.assertIn("/run/systemd/system/eiquidus-web.service.d", activation)
        self.assertLess(activation.index("systemctl daemon-reload"), activation.index("effective_dropins=$(systemctl show"))
        self.assertIn('cmp -s "$CURRENT/deploy/systemd/eiquidus-web.service" /etc/systemd/system/eiquidus-web.service', activation)
        self.assertIn("web service still has an effective drop-in", activation)
        self.assertIn('rm -f -- "$ROLLBACK_OVERRIDE"', activation)
        self.assertIn('install -o root -g root -m 0644 "$override_backup" "$ROLLBACK_OVERRIDE"', activation)
        self.assertIn("systemctl daemon-reload", activation)
        self.assertIn("systemctl enable eiquidus-web eiquidus-sync.timer eiquidus-backup.timer", activation)
        self.assertIn("systemctl disable --now eiquidus-web eiquidus-sync.timer eiquidus-backup.timer", activation)
        self.assertIn("nginx -t", activation)
        self.assertIn("MariaCoin", activation)
        self.assertIn('curl -fsS --max-time 5 "https://$HOST/" -o "$body"', activation)
        self.assertNotIn('"https://$HOST/" | grep -Fq MariaCoin', activation)
        self.assertIn("for attempt in $(seq 1 30)", activation)
        self.assertIn("[[ $ready == true ]]", activation)
        self.assertLess(activation.rindex('rm -f -- "$body"'), activation.rindex("activated=true"))
        self.assertIn('[[ -z $override_backup ]] || rm -f -- "$override_backup" || true', activation)
        self.assertLess(activation.rindex("activated=true"), activation.rindex('rm -f -- "$override_backup" || true'))

    def test_checkout_is_byte_exact_for_reproducible_release_ids(self):
        attributes = (ROOT / ".gitattributes").read_text(encoding="utf-8")
        self.assertIn("* -text", attributes.splitlines())

    def test_claim_hostnames_come_from_settings(self):
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        defaults = (ROOT / "lib" / "settings.js").read_text(encoding="utf-8")
        view = (ROOT / "views" / "claim_address.pug").read_text(encoding="utf-8")
        self.assertIn("settings.claim_address_page.allowed_hosts", app)
        self.assertNotIn("const claimAllowedHosts = ['", app)
        self.assertIn("must list at least one valid public hostname", app)
        self.assertIn(f'"allowed_hosts": ["{HOST}"]', defaults)
        self.assertIn("settings.claim_address_page.allowed_hosts[0]", view)
        self.assertNotIn("https://explorer.mariacoin.com", view)

    def test_host_hardening_exposes_only_required_ports(self):
        firewall = text("host/configure-host.sh")
        ssh = text("ssh/00-eiquidus-hardening.conf")
        for port in ("22/tcp", "80/tcp", "443/tcp", "47773/tcp"):
            self.assertIn(port, firewall)
        for forbidden in ("3001/tcp", "27017/tcp", "47774/tcp"):
            self.assertNotIn(forbidden, firewall)
        self.assertIn("PasswordAuthentication no", ssh)
        self.assertIn("KbdInteractiveAuthentication no", ssh)
        self.assertIn("PermitRootLogin no", ssh)
        self.assertNotIn("PasswordAuthentication yes", ssh)
        self.assertIn("fail2ban", firewall)
        self.assertIn("banaction = ufw", firewall)
        self.assertIn("SystemMaxUse=500M", firewall)
        self.assertIn("zswap.enabled=1", firewall)
        self.assertNotRegex(firewall.lower(), r"getty|pm2|cron")

    def test_branding_provenance_and_expected_assets_exist(self):
        self.assertTrue((ROOT / "public" / "img" / "mariacoin-logo-square.png").is_file())
        palette = (ROOT / "public" / "css" / "custom.scss").read_text(encoding="utf-8")
        for value in ("#11290C", "#225018", "#AE8422", "#D1A132", "#F5F1E7", "#A7ADA2", "#35642A", "#C94F4F"):
            self.assertIn(value, palette)
        self.assertIn(".btn-success", palette)
        self.assertIn(".bg-info", palette)
        self.assertIn("border-color: var(--maria-gold-hover) !important;", palette)
        self.assertIn("background-color: var(--maria-green-dark) !important;", palette)
        self.assertIn("let compile_custom_css = true;", text("../scripts/compile_css.js"))
        provenance = text("branding/ASSET-SOURCES.md")
        self.assertIn("https://www.mariacoin.com/wp-content/uploads/2021/12/maria-logo-header2.png", provenance)
        self.assertIn("46a0157c0a9d1a2cc24fb18d3822e25b958fe99cf8a3902e64333f05a1b3b15d", provenance)
        for relative in ("public/img/maria-logo.png", "public/favicon-32.png", "public/favicon-128.png", "public/favicon-180.png", "public/favicon-192.png"):
            self.assertTrue((ROOT / relative).is_file(), relative)

    def test_maria_theme_has_restrained_visual_hierarchy(self):
        palette = (ROOT / "public" / "css" / "custom.scss").read_text(encoding="utf-8")
        for expected in (
            "--surface-raised:",
            "--surface-subtle:",
            "#logo-panel",
            "height: 96px !important;",
            ".table tbody a",
            "color: var(--text-primary);",
            ".table tbody a:hover",
            "color: var(--maria-gold-hover);",
            "border-color: var(--border) !important;",
            "border-radius: 8px;",
            "padding-top: 0.72rem;",
            "padding-bottom: 0.72rem;",
        ):
            self.assertIn(expected, palette)
        self.assertRegex(
            palette,
            r"\.form-control,\s*\.form-select,\s*\.input-group-text\s*\{\s*border-color: var\(--maria-gold-hover\) !important;",
        )
        self.assertRegex(
            palette,
            r"\.form-control:focus,\s*\.form-select:focus\s*\{[^}]*border-color: var\(--maria-gold-hover\) !important;",
        )
        self.assertRegex(
            palette,
            r"\.btn-primary\s*\{[^}]*border-color: var\(--maria-gold-hover\);",
        )
        self.assertIn(".btn-outline-primary", palette)
        self.assertRegex(
            palette,
            r"\.btn-outline-primary\s*\{[^}]*color: var\(--maria-gold-hover\);",
        )
        for background in ("#11290C", "#225018"):
            self.assertGreaterEqual(contrast_ratio("#D1A132", background), 3.0)
        self.assertGreaterEqual(contrast_ratio("#D1A132", "#142F10"), 4.5)

    def test_menu_icons_match_mariacoin_page_semantics(self):
        layout = (ROOT / "views" / "layout.pug").read_text(encoding="utf-8")
        for icon in (
            "fa-solid.fa-server",
            "fa-solid.fa-right-left",
            "fa-solid.fa-list-ol",
            "fa-solid.fa-code",
        ):
            self.assertEqual(layout.count(icon), 2, icon)
        for inherited_icon in (
            "fa-solid.fa-share-nodes",
            "fa-regular.fa-money-bill-1",
            "fa-brands.fa-btc",
            "fa-solid.fa-circle-info",
        ):
            self.assertNotIn(inherited_icon, layout)

    def test_claim_address_is_challenge_bound_and_fail_closed(self):
        generator = (ROOT / "deploy" / "eiquidus" / "generate-settings.py").read_text(encoding="utf-8")
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        claim = (ROOT / "lib" / "claim.js").read_text(encoding="utf-8")
        explorer = (ROOT / "lib" / "explorer.js").read_text(encoding="utf-8")
        challenge_model = (ROOT / "models" / "claimchallenge.js").read_text(encoding="utf-8")
        claim_model = (ROOT / "models" / "claimaddress.js").read_text(encoding="utf-8")
        database = (ROOT / "lib" / "database.js").read_text(encoding="utf-8")
        routes = (ROOT / "routes" / "index.js").read_text(encoding="utf-8")
        view = (ROOT / "views" / "claim_address.pug").read_text(encoding="utf-8")
        menu = (ROOT / "views" / "layout.pug").read_text(encoding="utf-8")
        index_view = (ROOT / "views" / "index.pug").read_text(encoding="utf-8")
        block_view = (ROOT / "views" / "block.pug").read_text(encoding="utf-8")
        tx_view = (ROOT / "views" / "tx.pug").read_text(encoding="utf-8")

        self.assertIn('["enabled"] = True', generator)
        self.assertIn('["show_header_menu"] = True', generator)
        self.assertIn('["enable_captcha"] = False', generator)
        self.assertIn("app.post('/claim/challenge'", app)
        self.assertIn("key != 'verifymessage'", app)
        self.assertIn("typeof response !== 'boolean'", explorer)
        self.assertIn("settings.claim_address_page.enabled !== true", app)
        self.assertIn("res.status(404).render('error'", routes)
        self.assertIn("claim.csrfMatches", app)
        self.assertIn("maxEntries", claim)
        self.assertIn("settings.claim_address_page.enable_captcha === true", app)
        self.assertIn("claimBodyParserError", app)
        self.assertIn("req.cookies['__Host-maria_claim_csrf']", app)
        self.assertIn("res.cookie('__Host-maria_claim_csrf'", app)
        self.assertIn("claimRateLimiter.take", app)
        self.assertIn("challengeStore.consume", claim)
        self.assertIn("findOneAndUpdate", app)
        self.assertIn("consumed_at: null", app)
        self.assertIn("expires_at: {$gt: query.now}", app)
        self.assertIn("expires: 0", challenge_model)
        self.assertIn("session.withTransaction", database)
        self.assertIn("findOneAndUpdate", database)
        self.assertIn("'received.$[received].claim_name'", database)
        self.assertIn("'balance.$[balance].claim_name'", database)
        self.assertNotIn("claim_name: current_address.name", database)
        self.assertIn("updated_at", claim_model)
        self.assertIn("claim_cooldown", database)
        self.assertIn("get_claimable_address", database)
        self.assertIn("Never enter or share your private key or seed phrase", view)
        self.assertIn("Self-claimed names do not verify a person's identity", view)
        self.assertNotIn("!{claim_name}", view)
        self.assertIn("escapeClaimText", index_view)
        self.assertIn("self-claimed", index_view)
        self.assertIn("self-claimed", block_view)
        self.assertIn("self-claimed", tx_view)
        self.assertEqual(menu.count("fa-solid.fa-signature"), 2)

    def test_no_plaintext_secrets_or_forbidden_service_patterns(self):
        suspicious = re.compile(r"(?i)(rpcpassword|password)\s*[:=]\s*[A-Za-z0-9_-]{24,}")
        findings = []
        for path in DEPLOY.rglob("*"):
            if path.is_file() and path.suffix not in {".pyc", ".png"}:
                content = path.read_text(encoding="utf-8", errors="ignore")
                if suspicious.search(content):
                    findings.append(str(path.relative_to(ROOT)))
        self.assertEqual([], findings)


if __name__ == "__main__":
    unittest.main()
