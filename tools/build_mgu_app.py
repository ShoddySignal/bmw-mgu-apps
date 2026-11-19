#!/usr/bin/env python3
"""Build one iDrive 7 app, verify its OAP archives and stage Store assets."""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'kit/tools'))
import build as kit_build  # noqa: E402

DIST = ROOT / 'dist'


def load_app(app_id):
    if not re.fullmatch(r'[a-z][a-z0-9_]*', app_id):
        raise ValueError('An app ID must start with a lowercase letter and use letters, digits or underscores')
    spec_path = ROOT / 'apps' / app_id / 'app.json'
    if not spec_path.is_file():
        raise ValueError(f'App not found: {app_id}')
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    if spec.get('id') != app_id:
        raise ValueError(f'App ID does not match its directory: {app_id}')
    version = spec.get('version')
    if not isinstance(version, str) or not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', version):
        raise ValueError('The app version must use major.minor.patch')
    if spec.get('mguHmi') != ['ID7']:
        raise ValueError('This App Kit generates ID7 resources. Set mguHmi to ["ID7"].')
    for filename in ('main.js', 'icon.png'):
        if not (spec_path.parent / filename).is_file():
            raise ValueError(f'Missing {filename} in {spec_path.parent.name}')
    for key in ('title', 'description'):
        value = spec.get(key)
        if not isinstance(value, str) or not value.strip() or '\n' in value or '\r' in value:
            raise ValueError(f'Use a single line of text for {key}')
    return spec


def read_json(archive, name):
    with archive.extractfile(name) as stream:
        return json.load(stream)


def verify(path, prefix, spec):
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive.getmembers():
            name = PurePosixPath(member.name)
            if (name.is_absolute() or '..' in name.parts or 'node_modules' in name.parts
                    or 'oap-sdk' in name.parts or name.suffix.lower() in ('.prg', '.grp', '.key', '.pem')
                    or not (member.isdir() or member.isfile())):
                raise ValueError(f'Unexpected package member: {member.name}')

        manifest = read_json(archive, prefix + 'package.json')
        actual = manifest['name'], manifest['version'], manifest['mguHmi']
        expected = spec['id'], spec['version'], spec['mguHmi']
        if actual != expected:
            raise ValueError(f'Inconsistent package metadata in {path.name}')
        rhmi = read_json(archive, prefix + 'rhmiData/application.json')['application']
        if not any('ID7' in ui['hmi'] for ui in rhmi['uiDescriptions']):
            raise ValueError(f'Missing ID7 layout in {path.name}')
        strings = read_json(archive, prefix + 'rhmiData/variantGroups/Common/texts/en_GB.json')
        if spec['title'] not in strings.values():
            raise ValueError(f'Missing English title in {path.name}')
        archive.getmember(prefix + manifest['main'])
        archive.getmember(prefix + 'manifest.json')
        with archive.extractfile(prefix + 'javascript/kit/LICENSE') as notice:
            if notice.read() != (ROOT / 'kit' / 'LICENSE').read_bytes():
                raise ValueError(f'App Kit license differs from the source in {path.name}')


def json_file(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def build_app(spec):
    app_id = spec['id']
    tag = f"{app_id}@{spec['version']}"
    kit_build.build(app_id)
    package = DIST / f'{tag}.tgz'
    verify(package, 'package/', spec)
    verify(DIST / f'{tag}.mgu', 'source/', spec)
    digest = hashlib.sha256(package.read_bytes()).hexdigest()

    app_data = {'title': spec['title'], 'description': spec['description'], 'mguHmi': spec['mguHmi']}
    release_dir = DIST / 'release' / tag
    release_dir.mkdir(parents=True, exist_ok=True)
    icon = release_dir / f'{app_id}.png'
    generated_icon = DIST / app_id / 'rhmiData' / 'resources' / f'{app_id}_icon.png'
    shutil.copyfile(generated_icon, icon)
    if icon.stat().st_size > 128 * 1024:
        raise ValueError('The MGU Store release icon must be at most 128 KiB')
    metadata = release_dir / 'mgu-store.json'
    json_file(metadata, {'apps': {app_id: {
        **app_data, 'icon': icon.name, 'iconSha256': hashlib.sha256(icon.read_bytes()).hexdigest()
    }}})
    notes = release_dir / 'notes.md'
    notes.write_text(
        f"{spec['description']}\n\nInstall through MGU Store with this repository's Releases channel.\n\n"
        f'Package SHA-256: `{digest}`\n', encoding='utf-8'
    )

    usb = DIST / 'usb' / 'mgu-repo' / app_id
    usb.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(package, usb / package.name)
    component = {
        'id': app_id, 'kind': 'app', 'version': spec['version'], 'uninstallable': True, **app_data,
        'artifact': {'name': package.name, 'url': package.name, 'size': package.stat().st_size, 'sha256': digest}
    }
    if spec.get('requires'):
        component['requires'] = spec['requires']
    json_file(usb / 'catalog.json', {'schema': 2, 'components': [component]})
    print(f'USB source: {usb.relative_to(ROOT)}')
    print(f'SHA-256: {digest}  {package.name}')

    return {
        'tag': tag, 'title': f"{spec['title']} {spec['version']}",
        'package': package.relative_to(ROOT), 'metadata': metadata.relative_to(ROOT),
        'icon': icon.relative_to(ROOT), 'notes': notes.relative_to(ROOT)
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app_id')
    parser.add_argument('--test', action='store_true', help='run the app test suite when present')
    parser.add_argument('--github-output', type=Path, help='write release inputs for GitHub Actions')
    args = parser.parse_args()
    try:
        spec = load_app(args.app_id)
        tests = ROOT / 'tests' / f'test_{spec["id"]}.js'
        if args.test and tests.is_file():
            subprocess.run(['node', '--test', str(tests)], cwd=ROOT, check=True)
        outputs = build_app(spec)
    except (OSError, ValueError, subprocess.CalledProcessError) as err:
        parser.exit(1, f'{err}\n')
    if args.github_output:
        with args.github_output.open('a', encoding='utf-8') as stream:
            for key, value in outputs.items():
                print(f'{key}={value}', file=stream)


if __name__ == '__main__':
    main()
