import type { Canvas } from '@napi-rs/canvas';

export type IntakeImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type IntakeImageEncoding =
  { mimeType: 'image/png' } | { mimeType: 'image/jpeg' | 'image/webp'; quality: number };

export function encodeIntakeImage(canvas: Canvas, encoding: IntakeImageEncoding) {
  return {
    image:
      encoding.mimeType === 'image/png'
        ? canvas.toBuffer(encoding.mimeType)
        : canvas.toBuffer(encoding.mimeType, encoding.quality),
    mimeType: encoding.mimeType,
  };
}

export function intakeImageDataUrl(image: Uint8Array, mimeType: IntakeImageMimeType) {
  return `data:${mimeType};base64,${Buffer.from(image).toString('base64')}`;
}
