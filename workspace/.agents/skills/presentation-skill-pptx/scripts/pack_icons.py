#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Pack, unpack and verify the icon archive.

The skill ships its 355 icons inside `assets/icons/icons.zip` instead of as
loose files, because the marketplace caps a skill at 200 files and the loose
icons alone were 355 of them. Nothing at build time calls this script: the
resolver reads members straight out of the archive. This is the maintenance
tool — use it when the icon set itself changes.

    python3 scripts/pack_icons.py --check           verify archive against INDEX.json
    python3 scripts/pack_icons.py --unpack DIR      extract every icon to DIR
    python3 scripts/pack_icons.py --pack DIR        rebuild the archive from DIR

Round trip for editing the set: unpack to a scratch directory, change what you
need, update `assets/icons/INDEX.json` to match, pack it back, then run
`--check` and `scripts/selftest.py`.

Exit codes: 0 all good, 1 something is wrong (details on stderr).
"""
import argparse
import io
import json
import os
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from deckkit.fragments import find_skill_dir                  # noqa: E402

# Fixed timestamp so repacking an unchanged set produces an identical archive
# and does not show up as a change in git.
_EPOCH = (1980, 1, 1, 0, 0, 0)


def archive_path(skill_dir):
    return os.path.join(skill_dir, 'assets', 'icons', 'icons.zip')


def index_path(skill_dir):
    return os.path.join(skill_dir, 'assets', 'icons', 'INDEX.json')


def _index_files(skill_dir):
    with open(index_path(skill_dir), 'r', encoding='utf-8') as f:
        data = json.load(f)
    entries = data['icons'] if isinstance(data, dict) else data
    return [e['file'] for e in entries]


def _members(path):
    with zipfile.ZipFile(path) as archive:
        return [n for n in archive.namelist() if not n.endswith('/')]


def _check_archive(path, listed, out, err):
    """Archive and index must describe exactly the same set of icons."""
    if not os.path.isfile(path):
        err.write('no icon archive at %s\n' % path)
        return 1

    listed = set(listed)
    packed = set(_members(path))

    missing = sorted(listed - packed)
    orphans = sorted(packed - listed)

    out.write('archive %s\n' % path)
    out.write('  members in archive: %d\n' % len(packed))
    out.write('  entries in INDEX.json: %d\n' % len(listed))

    if missing:
        err.write('in INDEX.json but not in the archive (%d): %s\n'
                  % (len(missing), ', '.join(missing[:10])))
    if orphans:
        err.write('in the archive but not in INDEX.json (%d): %s\n'
                  % (len(orphans), ', '.join(orphans[:10])))
    if missing or orphans:
        return 1

    out.write('  ok: archive and index agree\n')
    return 0


def do_check(skill_dir, out, err):
    path = archive_path(skill_dir)
    if not os.path.isfile(path):
        err.write('no icon archive at %s\n' % path)
        return 1
    return _check_archive(path, _index_files(skill_dir), out, err)


def do_unpack(skill_dir, target, out, err):
    path = archive_path(skill_dir)
    if not os.path.isfile(path):
        err.write('no icon archive at %s\n' % path)
        return 1
    os.makedirs(target, exist_ok=True)
    count = 0
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if name.endswith('/'):
                continue
            # Flatten to a basename on purpose: a member is only ever addressed
            # by basename, and this leaves no way for a crafted path to escape.
            safe = os.path.basename(name)
            if not safe:
                continue
            with open(os.path.join(target, safe), 'wb') as f:
                f.write(archive.read(name))
            count += 1
    out.write('unpacked %d icons to %s\n' % (count, target))
    return 0


def do_pack(skill_dir, source, out, err):
    if not os.path.isdir(source):
        err.write('not a directory: %s\n' % source)
        return 1
    names = sorted(n for n in os.listdir(source) if n.lower().endswith('.png'))
    if not names:
        err.write('no .png files in %s\n' % source)
        return 1

    listed = set(_index_files(skill_dir))
    missing, unlisted = sorted(listed - set(names)), sorted(set(names) - listed)
    if missing or unlisted:
        err.write('source icons do not match INDEX.json; missing: %s; unlisted: %s\n'
                  % (', '.join(missing[:10]) or 'none', ', '.join(unlisted[:10]) or 'none'))
        return 1

    path = archive_path(skill_dir)
    temporary = None
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        # Same filesystem, unique writer-owned file; the live ZIP stays intact.
        fd, temporary = tempfile.mkstemp(prefix='.icons-', suffix='.zip',
                                         dir=os.path.dirname(path))
        with os.fdopen(fd, 'w+b') as staged:
            with zipfile.ZipFile(staged, 'w', zipfile.ZIP_DEFLATED) as archive:
                for name in names:
                    info = zipfile.ZipInfo(name, date_time=_EPOCH)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with open(os.path.join(source, name), 'rb') as f:
                        archive.writestr(info, f.read())

        report = io.StringIO()
        if _check_archive(temporary, listed, report, err):
            return 1
        with zipfile.ZipFile(temporary) as archive:
            bad = archive.testzip()
        if bad is not None:
            err.write('invalid CRC in packed icon: %s\n' % bad)
            return 1
        size = os.path.getsize(temporary)
        staged_path = temporary
        os.replace(temporary, path)
        temporary = None
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        err.write('could not pack icons: %s\n' % error)
        return 1
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)
    # Publication is complete; an output-stream error cannot reject that pack.
    out.write('packed %d icons into %s (%d bytes)\n' % (len(names), path, size))
    out.write(report.getvalue().replace(staged_path, path))
    return 0


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description='Pack, unpack or verify the icon archive.')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--check', action='store_true',
                       help='verify the archive against INDEX.json')
    group.add_argument('--unpack', metavar='DIR',
                       help='extract every icon to DIR')
    group.add_argument('--pack', metavar='DIR',
                       help='rebuild the archive from the PNGs in DIR')
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    skill_dir = find_skill_dir()
    if args.unpack:
        return do_unpack(skill_dir, args.unpack, sys.stdout, sys.stderr)
    if args.pack:
        return do_pack(skill_dir, args.pack, sys.stdout, sys.stderr)
    return do_check(skill_dir, sys.stdout, sys.stderr)


if __name__ == '__main__':
    sys.exit(main())
