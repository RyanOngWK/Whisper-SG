/**
 * AudioNormalizer — converts Twilio's 8 kHz μ-law (mu-law)
 * inbound audio to 16 kHz linear PCM for downstream ASR services.
 *
 * Implements ITU-T G.711 μ-law decoding and 8→16 kHz resampling
 * via linear interpolation.
 */

// ── G.711 μ-law decoding ────────────────────────────────────────
// μ-law compresses 14-bit linear PCM into 8-bit logarithmic values.
// Each byte encodes a sign bit, 3-bit segment (exponent), and
// 4-bit step (mantissa). The decoder reconstructs a 16-bit sample.

const CLIP = 8159;

const QUANT_MASK = 0x0f; // lower 4 bits = step
const SEG_SHIFT = 4; // upper 3 bits = segment (after sign)
const SIGN_BIT = 0x80;

// Pre-computed segment decode: segment → base value
const SEG_BASE = [0, 132, 396, 924, 1980, 4092, 8316, 16764];

/**
 * Decode a single μ-law byte to a 16-bit linear PCM sample.
 * Reference: ITU-T G.711 Table 2a / Appendix II.
 */
function muLawDecode(muLaw: number): number {
  // μ-law inverts all bits for transmission
  const inverted = ~muLaw & 0xff;
  const sign = inverted & SIGN_BIT ? -1 : 1;
  const segment = (inverted >> SEG_SHIFT) & 0x07;
  const step = inverted & QUANT_MASK;
  let sample = (SEG_BASE[segment] ?? 0) + (step << (segment + 3));
  sample = sign * sample;
  if (sample > CLIP) return CLIP;
  if (sample < -CLIP) return -CLIP;
  return sample;
}

/**
 * Convert a buffer of μ-law bytes to a buffer of 16-bit linear
 * PCM samples at 8 kHz. Each input byte produces one 16-bit output.
 */
function decodeMuLawBuffer(muLawBuffer: Buffer): Int16Array {
  const samples = new Int16Array(muLawBuffer.length);
  for (let i = 0; i < muLawBuffer.length; i++) {
    const byte = muLawBuffer[i];
    samples[i] = muLawDecode(byte ?? 0xff);
  }
  return samples;
}

/**
 * Resample from 8 kHz to 16 kHz using linear interpolation.
 * For every input sample, produce two output samples:
 * the original at the even position, and the interpolated
 * midpoint between current and next at the odd position.
 */
function upsample8kTo16k(input: Int16Array): Int16Array {
  const inLen = input.length;
  const output = new Int16Array(inLen * 2);

  for (let i = 0; i < inLen; i++) {
    const current = input[i] ?? 0;
    const idx = i * 2;
    output[idx] = current;

    // Interpolate between current and next sample
    if (i < inLen - 1) {
      const next = input[i + 1] ?? 0;
      output[idx + 1] = Math.round((current + next) / 2) & 0xffff;
    } else {
      // Last sample: duplicate (no next sample to interpolate with)
      output[idx + 1] = current;
    }
  }

  return output;
}

// ── NormalizedAudio type ────────────────────────────────────────

export interface NormalizedAudio {
  /** Raw linear-16 PCM samples at 16 kHz mono. */
  buffer: Buffer;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Audio encoding format. */
  encoding: "linear16";
}

// ── AudioNormalizer class ───────────────────────────────────────

export class AudioNormalizer {
  /**
   * Convert a base64-encoded μ-law (mu-law) audio chunk
   * to a 16 kHz linear-16 PCM Buffer.
   *
   * Pipeline:
   *   base64 decode → G.711 μ-law decode → 8→16 kHz upsample
   *   → 16-bit little-endian PCM buffer
   */
  convertMuLawToLinear16(base64MuLaw: string): Buffer {
    const muLawBuffer = Buffer.from(base64MuLaw, "base64");
    const decoded = decodeMuLawBuffer(muLawBuffer);
    const upsampled = upsample8kTo16k(decoded);

    // Convert Int16Array to little-endian Buffer
    const output = Buffer.allocUnsafe(upsampled.length * 2);
    for (let i = 0; i < upsampled.length; i++) {
      const sample = upsampled[i] ?? 0;
      output.writeInt16LE(sample, i * 2);
    }

    return output;
  }

  /**
   * Convenience — decode + normalize in one call.
   */
  normalize(base64MuLaw: string): NormalizedAudio {
    return {
      buffer: this.convertMuLawToLinear16(base64MuLaw),
      sampleRate: 16000,
      encoding: "linear16",
    };
  }
}
