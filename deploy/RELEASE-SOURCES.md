# Pinned deployment sources

## MariaCoin v5.5.1

Official project website links to `https://github.com/hostmaria/mariacoin`. The release API and official website identify the daemon asset below.

- Release: https://github.com/hostmaria/mariacoin/releases/tag/v5.5.1
- Daemon archive: https://github.com/hostmaria/mariacoin/releases/download/v5.5.1/maria-5.5.1-ubuntu18-daemon.zip
- Archive SHA-256: `0d15861e7e0de787313464a5a35dc3e9cdda68a092b0104173b4daaa456b27ba`
- Extracted `mariad` SHA-256: `db03a3dd390c74a7136a44b06b600fe525f181aaef5915273908cb6453ae2030`

The archive hash was independently reverified on 2026-07-24. GitHub's release metadata contains no publisher digest/signature, so these are checksum pins, not publisher-signed attestations. The binary's previously audited embedded revision does not match the public release commit; source reproducibility is incomplete.

## Runtime repositories

- Node.js: official `nodejs.org/dist/v24.18.0` archive, verified against same-directory `SHASUMS256.txt`.
- MongoDB: official MongoDB 8.0 Noble repository, loopback-only single-node `mariacoin-rs` replica set.
- eIquidus releases: locally built deterministic immutable archives from the complete reviewed tracked-plus-approved-untracked input inventory rooted at pinned base commit `42f4e17a5b335feb4faecec00cc336785f73ae52`, with a resolved `package-lock.json`. The archive digest, not Git HEAD alone, identifies each reviewed release. Deployment refuses archives without a separate SHA-256 and checksum-derived 40-hex release ID.
