import fs from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const desktopDirectory = path.resolve(import.meta.dirname, '..');
const sourcePath = path.join(desktopDirectory, 'build', 'app-icon.svg');
const outputPath = path.join(desktopDirectory, 'build', 'app-icon.ico');
const sizes = [16, 24, 32, 48, 64, 128, 256];

function createIco(images) {
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let imageOffset = headerSize;
  images.forEach(({ size, png }, index) => {
    const offset = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, offset);
    header.writeUInt8(size === 256 ? 0 : size, offset + 1);
    header.writeUInt8(0, offset + 2);
    header.writeUInt8(0, offset + 3);
    header.writeUInt16LE(1, offset + 4);
    header.writeUInt16LE(32, offset + 6);
    header.writeUInt32LE(png.length, offset + 8);
    header.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

const svg = fs.readFileSync(sourcePath, 'utf8');
const images = sizes.map((size) => ({
  size,
  png: new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0, 0, 0, 0)',
  }).render().asPng(),
}));
fs.writeFileSync(outputPath, createIco(images));
console.log(`Windows icon created: ${outputPath}`);
