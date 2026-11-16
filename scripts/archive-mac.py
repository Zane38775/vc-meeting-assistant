"""Create a Mac-readable ZIP, preserving POSIX symlinks and executable bits."""
import argparse, hashlib, json, os, plistlib, re, stat, struct, zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, default=root / 'release',
                    help='Directory for the ZIP and SHA256SUMS.txt (default: repository release/)')
args = parser.parse_args()
output_dir = args.output_dir.expanduser().resolve()
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
assert isinstance(version, str) and re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?', version), 'Invalid package version'
source = root / 'release' / 'VC Meeting Assistant-darwin-arm64'
if output_dir == source or source in output_dir.parents:
    parser.error('Output directory must be outside the packaged application folder')
app = source / 'VC Meeting Assistant.app'
resources = app / 'Contents' / 'Resources'
output = output_dir / f'VC-Meeting-Assistant-{version}-mac-arm64.zip'
assert app.is_dir(), 'Build the Mac app first'
with (app / 'Contents' / 'Info.plist').open('rb') as f:
    info = plistlib.load(f)
assert info['CFBundleIdentifier'] == 'com.vcmeeting.assistant'
assert info['CFBundleShortVersionString'] == version, 'Rebuild the Mac app after changing the package version'
assert info['LSMinimumSystemVersion'] == '14.2'
assert info.get('NSMicrophoneUsageDescription') and info.get('NSAudioCaptureUsageDescription')
for binary in [app / 'Contents' / 'MacOS' / info['CFBundleExecutable'], resources / 'app.asar.unpacked/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node', resources / 'app.asar.unpacked/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node']:
    with binary.open('rb') as f:
        magic, cpu = struct.unpack('<II', f.read(8))
    assert magic == 0xfeedfacf and cpu == 0x100000c, f'Not arm64: {binary}'
assert (resources / 'app.asar.unpacked/dist/server/local-worker.cjs').is_file()
model = resources / 'models/local-asr'
for profile_dir in [model, model / 'xasr-480']:
    provenance = json.loads((profile_dir / 'MODEL-PROVENANCE.json').read_text(encoding='utf-8'))
    if profile_dir != model:
        assert provenance['profile'] == 'xasr-480'
        assert provenance['sha256'] == 'fa5f63d618e5a01526e275a358bb7772e403f84808a4769fba52cffd8160bf74'
    for entry in [*provenance['files'], provenance['vocabulary']]:
        if entry['name'].startswith('test_wavs/'):
            continue
        file = profile_dir / entry['name']
        assert file.stat().st_size == entry['bytes'], f'Size mismatch: {file}'
        digest = hashlib.sha256()
        with file.open('rb') as model_file:
            while chunk := model_file.read(1024 * 1024):
                digest.update(chunk)
        assert digest.hexdigest() == entry['sha256'], f'SHA256 mismatch: {file}'
    assert not (profile_dir / 'test_wavs').exists()
assert (root / 'docs' / 'START-MAC.md').is_file(), 'Missing repository installation guide'
assert (root / 'VALIDATION.md').is_file(), 'Missing validation report'

def add(z, path, archive):
    metadata = zipfile.ZipInfo(archive)
    metadata.create_system = 3
    if path.is_symlink():
        target = os.readlink(path).replace('\\', '/')
        assert not target.startswith('/') and ':' not in target
        metadata.external_attr = (stat.S_IFLNK | 0o777) << 16
        z.writestr(metadata, target.encode('utf-8'))
    elif path.is_dir():
        metadata.filename = archive.rstrip('/') + '/'
        metadata.external_attr = ((stat.S_IFDIR | 0o755) << 16) | 0x10
        z.writestr(metadata, b'')
        for child in sorted(path.iterdir(), key=lambda p: p.name):
            add(z, child, archive.rstrip('/') + '/' + child.name)
    else:
        with path.open('rb') as f:
            magic = f.read(4)
        executable = path.suffix == '.command' or magic in [b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca']
        metadata.external_attr = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
        metadata.compress_type = zipfile.ZIP_DEFLATED
        metadata._compresslevel = 6
        with path.open('rb') as inp, z.open(metadata, 'w', force_zip64=True) as out:
            while chunk := inp.read(1024 * 1024):
                out.write(chunk)

output_dir.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'w', allowZip64=True) as z:
    for item in source.iterdir():
        add(z, item, item.name)
    add(z, root / 'docs' / 'START-MAC.md', '开始使用.md')
    add(z, root / 'VALIDATION.md', '验证范围.md')
with zipfile.ZipFile(output) as z:
    assert z.testzip() is None
    links = [e for e in z.infolist() if stat.S_ISLNK(e.external_attr >> 16)]
    assert links
    assert all(b'\\' not in z.read(e) for e in links)
    assert z.getinfo('Install-on-Mac.command').external_attr >> 16 & 0o111
    assert not any('/test_wavs/' in n or n.endswith('/.env') for n in z.namelist())
sha = hashlib.sha256()
with output.open('rb') as f:
    while chunk := f.read(1024 * 1024):
        sha.update(chunk)
(output.parent / 'SHA256SUMS.txt').write_text(f'{sha.hexdigest()}  {output.name}\n', encoding='utf-8')
print(json.dumps({'zip': str(output), 'bytes': output.stat().st_size, 'sha256': sha.hexdigest(), 'symlinks':len(links),'architecture':'arm64','macOS':'14.2+','signed':False,'notarized':False}, ensure_ascii=False))
