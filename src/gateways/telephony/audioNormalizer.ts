/**
 * AudioNormalizer — converts Twilio's 8 kHz μ-law (mu-law)
 * inbound audio to 16 kHz linear PCM for downstream ASR services.
 *
 * This is a stub — production implementation requires decoding
 * μ-law samples (G.711 algorithm) and resampling 8 kHz → 16 kHz.
 */

export interface NormalizedAudio {
  /** Raw linear-16 PCM samples at 16 kHz mono. */
  buffer: Buffer;
  /** Sample rate in Hz. */
  sampleRate: number;
  /** Audio encoding format. */
  encoding: "linear16";
}

export class AudioNormalizer {
  /**
   * Convert a base64-encoded μ-law (mu-law) audio chunk
   * to a 16 kHz linear-16 PCM Buffer.
   *
   * Stub: returns the decoded base64 buffer as-is.
   * Production: decode μ-law samples, upsample 8 kHz → 16 kHz.
   */
  convertMuLawToLinear16(base64MuLaw: string): Buffer {
    // Decode the base64 payload — the raw μ-law bytes.
    const muLawBuffer = Buffer.from(base64MuLaw, "base64");

    // TODO(production): Implement G.711 μ-law decoding + resampling.
    // 1. Decode each μ-law byte to a 14-bit linear sample.
    // 2. Interpolate from 8 kHz to 16 kHz (insert one zero sample,
    //    then low-pass filter).
    // Reference: ITU-T G.711, Appendix II.

    // Stub: return the raw decoded bytes as a placeholder.
    // Real ASR adapters will reject this until the pipeline is wired.
    return muLawBuffer;
  }

  /**
   * Convenience — decode + normalizing in one call.
   */
  normalize(base64MuLaw: string): NormalizedAudio {
    return {
      buffer: this.convertMuLawToLinear16(base64MuLaw),
      sampleRate: 16000,
      encoding: "linear16",
    };
  }
}
