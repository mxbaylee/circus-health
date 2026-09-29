import { extractRasterSource } from './intake-source-ocr.ts';
import type { LocatedNativeText } from './intake-source-ocr.ts';
process.once(
  'message',
  async (input: { bytes: Uint8Array; page: number; native: LocatedNativeText[] }) => {
    try {
      const result = await extractRasterSource(input.bytes, input.page, input.native);
      process.send?.({ result }, () => process.exit(0));
    } catch (error) {
      const code =
        error instanceof Error &&
        ['IMAGE_PIXEL_LIMIT', 'IMAGE_INPUT_LIMIT', 'IMAGE_MULTIFRAME_UNSUPPORTED'].includes(
          error.message,
        )
          ? error.message
          : 'SOURCE_RASTER_FAILED';
      process.send?.({ error: code }, () => process.exit(0));
    }
  },
);
