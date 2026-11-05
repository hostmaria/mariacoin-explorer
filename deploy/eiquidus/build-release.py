#!/usr/bin/env python3
"""Build a deterministic, content-addressed eIquidus deployment archive."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_ROOT = "eiquidus-release"
REQUIRED = {
    "package.json",
    "package-lock.json",
    "lib/mariacoin.js",
    "test/mariacoinV551Spec.js",
    "public/img/maria-logo.png",
}
FORBIDDEN_NAMES = {"settings.json", ".env", "authorized_keys", "id_rsa", "id_ed25519"}
FORBIDDEN_SUFFIXES = {".pem", ".p12", ".pfx", ".key"}
# The upstream illustrative config template contains password-looking defaults.
# Runtime configuration is separately rendered and staged root-only, so this file is not deployment input.
EXCLUDED_FILES = {"settings.json.template"}


def source_paths() -> list[Path]:
    output = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
    )
    relative = sorted({Path(item.decode("utf-8")) for item in output.split(b"\0") if item})
    excluded_parts = {".hermes", "node_modules", "dist", "tmp", "backups", "__pycache__"}
    relative = [
        path for path in relative
        if not any(part in excluded_parts for part in path.parts) and path.as_posix() not in EXCLUDED_FILES
    ]
    names = {path.as_posix() for path in relative}
    missing = REQUIRED - names
    if missing:
        raise SystemExit(f"release source is missing required files: {', '.join(sorted(missing))}")
    for path in relative:
        lowered = path.name.lower()
        if lowered in FORBIDDEN_NAMES or path.suffix.lower() in FORBIDDEN_SUFFIXES:
            raise SystemExit(f"refusing to package possible secret file: {path.as_posix()}")
        if any(part in {".git", *excluded_parts} for part in path.parts):
            raise SystemExit(f"refusing unexpected generated path: {path.as_posix()}")
    return relative


def tar_info(name: str, mode: int, size: int = 0, kind: bytes = tarfile.REGTYPE) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.mode = mode
    info.size = size
    info.mtime = 0
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    return info


def build_tar(paths: list[Path]) -> bytes:
    output = io.BytesIO()
    directories = {PurePosixPath(ARCHIVE_ROOT)}
    for relative in paths:
        archive_path = PurePosixPath(ARCHIVE_ROOT, relative.as_posix())
        directories.update(archive_path.parents)
    with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for directory in sorted(directories, key=lambda item: (len(item.parts), item.as_posix())):
            archive.addfile(tar_info(f"{directory.as_posix()}/", 0o755, kind=tarfile.DIRTYPE))
        for relative in paths:
            source = ROOT / relative
            archive_name = PurePosixPath(ARCHIVE_ROOT, relative.as_posix()).as_posix()
            if source.is_symlink():
                target = os.readlink(source)
                if os.path.isabs(target):
                    raise SystemExit(f"refusing absolute symlink: {relative.as_posix()}")
                info = tar_info(archive_name, 0o777, kind=tarfile.SYMTYPE)
                info.linkname = target
                archive.addfile(info)
            elif source.is_file():
                payload = source.read_bytes()
                if source.suffix == ".sh":
                    payload = payload.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
                executable = bool(source.stat().st_mode & stat.S_IXUSR) or source.suffix in {".sh"}
                info = tar_info(archive_name, 0o755 if executable else 0o644, len(payload))
                archive.addfile(info, io.BytesIO(payload))
            else:
                raise SystemExit(f"unsupported release source type: {relative.as_posix()}")
    return output.getvalue()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    output_dir = args.output_dir.resolve()
    if ROOT in output_dir.parents and output_dir != (ROOT / "dist").resolve():
        raise SystemExit("release output inside the source tree must be the excluded dist directory")
    paths = source_paths()
    raw_tar = build_tar(paths)
    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0, compresslevel=9) as stream:
        stream.write(raw_tar)
    payload = compressed.getvalue()
    digest = hashlib.sha256(payload).hexdigest()
    release_id = digest[:40]
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / "eiquidus-release.tar.gz"
    archive_path.write_bytes(payload)
    (output_dir / "eiquidus-release.sha256").write_text(f"{digest}\n", encoding="ascii", newline="\n")
    (output_dir / "eiquidus-release.id").write_text(f"{release_id}\n", encoding="ascii", newline="\n")
    print(f"RELEASE_ID={release_id}")
    print(f"SHA256={digest}")
    print(f"FILES={len(paths)}")
    print(f"ARCHIVE={archive_path.resolve()}")


if __name__ == "__main__":
    main()
