const fs = require('fs');

const file = process.argv[2];
const patternText = process.argv[3] || '.';

if (!file) {
  console.error('usage: node tools/extract-binary-strings.js <file> <regex>');
  process.exit(2);
}

const pattern = new RegExp(patternText, 'i');
const buf = fs.readFileSync(file);
const results = new Set();

function collectAscii() {
  let run = '';
  for (const byte of buf) {
    if (byte >= 32 && byte <= 126) {
      run += String.fromCharCode(byte);
    } else {
      if (run.length >= 4 && pattern.test(run)) results.add(run);
      run = '';
    }
  }
  if (run.length >= 4 && pattern.test(run)) results.add(run);
}

function collectUtf16Le() {
  let run = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = buf.readUInt16LE(i);
    if (code >= 32 && code <= 126) {
      run += String.fromCharCode(code);
    } else {
      if (run.length >= 4 && pattern.test(run)) results.add(run);
      run = '';
    }
  }
  if (run.length >= 4 && pattern.test(run)) results.add(run);
}

collectAscii();
collectUtf16Le();

for (const line of [...results].sort()) console.log(line);
