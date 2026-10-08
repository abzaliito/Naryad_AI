import sharp from 'sharp';

const ALGORITHM = 'hv-dhash128-v1';
const THRESHOLD = 8;

/** Server-owned, low-resolution structural evidence. It neither recognizes defects nor dates a photo. */
export async function photoSignature(normalizedJpeg) {
  const input = sharp(normalizedJpeg, { limitInputPixels: 40_000_000 });
  const { width, height } = await input.metadata();
  const pixels = await input.resize(9, 9, { fit: 'fill', kernel: 'lanczos3' }).greyscale().removeAlpha().raw().toBuffer();
  const mean = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  const deviation = Math.sqrt(pixels.reduce((sum, value) => sum + (value - mean) ** 2, 0) / pixels.length);
  let hash = 0n, gradient = 0, horizontalOnes = 0, verticalOnes = 0;
  for (const axis of ['horizontal', 'vertical']) {
    for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) {
      const current = pixels[y * 9 + x], next = pixels[(y + (axis === 'vertical' ? 1 : 0)) * 9 + x + (axis === 'horizontal' ? 1 : 0)];
      const bit = current > next;
      hash = (hash << 1n) | BigInt(Number(bit));
      gradient += Math.abs(current - next);
      if (bit && axis === 'horizontal') horizontalOnes += 1;
      if (bit && axis === 'vertical') verticalOnes += 1;
    }
  }
  // Flat backgrounds and simple one-direction gradients have non-discriminating hashes.
  const usable = deviation >= 12 && gradient / 128 >= 3
    && horizontalOnes >= 6 && horizontalOnes <= 58 && verticalOnes >= 6 && verticalOnes <= 58;
  return { algorithm: ALGORITHM, hash: hash.toString(16).padStart(32, '0'), usable,
    deviation: Math.round(deviation * 100) / 100, mean: Math.round(mean * 100) / 100,
    aspectRatio: Math.round(width / height * 1000) / 1000 };
}

/** Eight changed bits of 128 is a conservative review signal, not proof of image reuse. */
export function comparePhotoSignatures(left, right) {
  const valid = value => value?.algorithm === ALGORITHM && value.usable === true && /^[a-f\d]{32}$/i.test(value.hash)
    && Number.isFinite(value.deviation) && value.deviation >= 12 && Number.isFinite(value.mean)
    && Number.isFinite(value.aspectRatio) && value.aspectRatio > 0;
  if (!valid(left) || !valid(right)) return { similar: false, distance: null, reason: 'insufficient_detail' };
  if (Math.abs(Math.log(left.aspectRatio / right.aspectRatio)) > 0.1 || Math.abs(left.mean - right.mean) > 35
    || Math.max(left.deviation, right.deviation) / Math.min(left.deviation, right.deviation) > 2)
    return { similar: false, distance: null, reason: 'different_structure' };
  let bits = BigInt(`0x${left.hash}`) ^ BigInt(`0x${right.hash}`), distance = 0;
  while (bits) { bits &= bits - 1n; distance += 1; }
  return { similar: distance <= THRESHOLD, distance, reason: distance <= THRESHOLD ? 'near_match' : 'different_structure' };
}
