import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';

function textPdf(): Buffer {
  const contents = 'BT /F1 16 Tf 24 48 Td (Synthetic PDF upload) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${contents.length} >>\nstream\n${contents}endstream`,
  ];
  let document = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = document.length;
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  const xref = document.length;
  document += `xref\n0 6\n0000000000 65535 f \n${offsets.join('')}`;
  document += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

test('bundled material parser extracts PDF text with Electron utility-process metadata', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const script = buildSync({
    stdin: {
      contents: `
        Object.defineProperty(process.versions, 'electron', {value: '45.3.3'});
        Object.defineProperty(process, 'type', {value: 'utility'});
        const {parseMaterial} = await import('./server/materials.ts');
        const result = await parseMaterial(Buffer.from(process.argv[2], 'base64'), 'test.pdf');
        console.log(JSON.stringify(result));
      `,
      resolveDir: cwd,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    write: false,
  }).outputFiles[0].text;
  // Use a fresh runtime so PDF.js sees the utility-process identity before loading.
  const child = spawnSync(process.execPath, ['--input-type=module', '-', textPdf().toString('base64')], {
    cwd, input: script, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {pages: [{page: 1, text: 'Synthetic PDF upload'}]});
});
