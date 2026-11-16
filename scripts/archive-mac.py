"""Create a Mac-readable ZIP on Windows, preserving POSIX symlinks and executable bits."""
import hashlib, json, os, plistlib, stat, struct, zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / 'release' / 'VC Meeting Assistant-darwin-arm64'
app = source / 'VC Meeting Assistant.app'
resources = app / 'Contents' / 'Resources'
output = root.parent / '知投会议助手-Mac-AppleSilicon-0.1.0.zip'
assert app.is_dir(), 'Build the Mac app first'
with (app / 'Contents' / 'Info.plist').open('rb') as f:
    info = plistlib.load(f)
assert info['CFBundleIdentifier'] == 'com.vcmeeting.assistant'
assert info['LSMinimumSystemVersion'] == '14.2'
assert info.get('NSMicrophoneUsageDescription') and info.get('NSAudioCaptureUsageDescription')
for binary in [app / 'Contents' / 'MacOS' / info['CFBundleExecutable'], resources / 'app.asar.unpacked/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node', resources / 'app.asar.unpacked/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node']:
    with binary.open('rb') as f:
        magic, cpu = struct.unpack('<II', f.read(8))
    assert magic == 0xfeedfacf and cpu == 0x100000c, f'Not arm64: {binary}'
assert (resources / 'app.asar.unpacked/dist/server/local-worker.cjs').is_file()
model = resources / 'models/local-asr'
provenance = json.loads((model / 'MODEL-PROVENANCE.json').read_text(encoding='utf-8'))
for entry in provenance['files']:
    if entry['name'].startswith('test_wavs/'):
        continue
    b = (model / entry['name']).read_bytes()
    assert len(b) == entry['bytes'] and hashlib.sha256(b).hexdigest() == entry['sha256']
assert not (model / 'test_wavs').exists()

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

with zipfile.ZipFile(output, 'w', allowZip64=True) as z:
    for item in source.iterdir():
        add(z, item, item.name)
    add(z, root.parent / '开始使用-Mac.md', '开始使用.md')
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
