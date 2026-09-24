import { readFile } from 'node:fs/promises';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

let ready: Promise<void> | undefined;

/** Use the same rasterizer and PNG encoder on every OS/CPU, including CI. */
export async function renderBrandPng(
  svg: string,
  size: number,
  background?: string,
  markScale = 1,
): Promise<Buffer> {
  ready ??= readFile(new URL(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm'))).then(
    (bytes) => initWasm(new Uint8Array(bytes)),
  );
  await ready;

  const markSize = Math.round(size * markScale);
  const offset = Math.round((size - markSize) / 2);
  const positioned = svg.replace(
    '<svg ',
    `<svg x="${offset}" y="${offset}" width="${markSize}" height="${markSize}" `,
  );
  const renderer = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${positioned}</svg>`,
    { background, font: { loadSystemFonts: false } },
  );
  try {
    const image = renderer.render();
    try {
      return Buffer.from(image.asPng());
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
