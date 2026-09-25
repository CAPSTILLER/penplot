/** Browser-only: decode an image file to a downscaled grayscale buffer. */
import { type Gray, toGray } from './trace';

export async function loadImageGray(file: Blob, maxDim: number): Promise<Gray> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const s = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * s));
    const h = Math.max(1, Math.round(img.naturalHeight * s));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas not available');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return toGray(ctx.getImageData(0, 0, w, h));
  } finally {
    URL.revokeObjectURL(url);
  }
}
