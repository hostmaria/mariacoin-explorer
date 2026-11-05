# Ubuntu 24.04 deployment assets for MariaCoin explorers

These assets deploy one independent explorer per server (for example explorer.mariacoin.com and maria.stakersforum.com). Each server declares its own public hostname in a root-owned file, and the same release archive renders nginx, the maintenance page, TLS paths and activation for that host:

```
printf '%s\n' explorer.example.org | install -o root -g root -m 0644 /dev/stdin /etc/eiquidus/explorer-host
```

The staged `settings.json` must set `claim_address_page.allowed_hosts` with this hostname first; the installer refuses to run otherwise, so a settings file meant for another explorer cannot be installed. Servers share no data, credentials, keys or services. Deploy a new release to one explorer first and to the other after it has run cleanly.

These assets deliberately do not deploy application source trees. Build a reviewed eIquidus archive from the pinned clean repository, stage only the named files in each installer, and keep Nginx in maintenance mode through the full initial index.

Order: (1) verify Ubuntu 24.04, DNS, console recovery and a second key-only SSH session; (2) run host hardening; (3) install Node, MariaCoin binary/params/runtime and units; (4) install MongoDB and execute its real abort-transaction probe; (5) build the deterministic archive with `python deploy/eiquidus/build-release.py`, create root-owned mode-0700 `/var/lib/eiquidus/staging`, place the archive, checksum and release ID there, and render `/var/lib/eiquidus/staging/settings.json` on-host from root-controlled credentials; (6) run the archive's `deploy/eiquidus/install-eiquidus.sh` (the script performs authenticated extraction of the candidate and re-executes only the verified copy of itself before any global mutations) without enabling the web service or sync timer; (7) install maintenance Nginx and obtain the exact-host certificate; (8) complete initial sync and fixture validation; (9) run `/usr/local/bin/node /usr/local/libexec/eiquidus/verify-index.js --create-marker`; (10) while still in maintenance, run `/usr/local/libexec/eiquidus/backup-eiquidus.sh`, capture its exact `BACKUP_CREATED` directory, and run `/usr/local/libexec/eiquidus/verify-eiquidus-backup.sh BACKUP_DIRECTORY` against it; (11) only after both verification markers exist, run `/opt/eiquidus/current/deploy/eiquidus/activate-production.sh`; (12) complete post-activation and reboot verification.

Do not create or edit `INDEX_VERIFIED.json` manually. The verifier creates it atomically only after daemon synchronization, daemon/database tip and transaction-count equality, genesis and tip-hash checks, money-supply equality, and live cold-stake/Sapling/address-index acceptance checks. Production activation recomputes current live evidence and requires the marker's release and canonical-chain identity to match.

No installer schedules self-update, uses a process manager, creates a shell-login service user, installs a custom console service, or copies an unreviewed checkout. Validate with `python -m unittest discover -s deploy/tests -v` and `bash deploy/tests/static-checks.sh`.
