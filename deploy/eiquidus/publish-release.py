#!/usr/bin/env python3
"""Atomically publish a prepared release directory without replacement."""

from __future__ import annotations

import ctypes
import errno
import os
from pathlib import Path
import sys

AT_FDCWD = -100
RENAME_NOREPLACE = 1


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: publish-release.py SOURCE TARGET")
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    if not source.is_dir() or target.exists() or target.is_symlink():
        raise SystemExit("source must exist and target must not exist")
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = libc.renameat2
    renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    renameat2.restype = ctypes.c_int
    result = renameat2(AT_FDCWD, os.fsencode(source), AT_FDCWD, os.fsencode(target), RENAME_NOREPLACE)
    if result != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise SystemExit("release target already exists")
        raise OSError(error, os.strerror(error), str(target))


if __name__ == "__main__":
    main()
