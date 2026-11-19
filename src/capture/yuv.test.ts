/**
 * Checks the BT.709 limited-range conversion. Runs under `npm test`, which
 * picks this file up by name; a failing check throws.
 */
import { i420Size, rgbaToI420 } from './yuv';

function convert(r: number, g: number, b: number) {
  const rgba = new Uint8Array(2 * 2 * 4);
  for (let i = 0; i < 4; i++) rgba.set([r, g, b, 255], i * 4);
  const out = new Uint8Array(i420Size(2, 2));
  rgbaToI420(rgba, 2, 2, out);
  return { y: out[0], u: out[4], v: out[5] };
}

function expect(label: string, got: { y: number; u: number; v: number }, want: [number, number, number], slack = 0) {
  const ok = Math.abs(got.y - want[0]) <= slack && Math.abs(got.u - want[1]) <= slack && Math.abs(got.v - want[2]) <= slack;
  if (!ok) throw new Error(`yuv: ${label} gave ${JSON.stringify(got)}, expected ${want.join(',')}`);
}

// Black and white land on the limited range ends.
expect('black', convert(0, 0, 0), [16, 128, 128]);
expect('white', convert(255, 255, 255), [235, 128, 128]);
// Dim greys stay above black instead of being crushed.
expect('grey 8', convert(8, 8, 8), [23, 128, 128]);
expect('grey 1', convert(1, 1, 1), [17, 128, 128]);
// Primaries, BT.709 limited range reference values.
expect('red', convert(255, 0, 0), [63, 102, 240], 1);
expect('blue', convert(0, 0, 255), [32, 240, 118], 1);
console.log('yuv: BT.709 limited range conversion ok');
