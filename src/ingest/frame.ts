/** One decoded or encoded video frame handed from a feed to the detectors. */
export type FrameFormat = 'rgb24' | 'jpeg';

export interface Frame {
  cameraId: string;
  /** Wall-clock time the frame was cut from the feed (ms). */
  tsMs: number;
  format: FrameFormat;
  /** Pixel size. For jpeg it is the requested feed size; the decoder reads the real size from the file. */
  width: number;
  height: number;
  data: Buffer;
}

/** Splits a rawvideo byte stream into fixed-size frames (width * height * 3 bytes each). */
export class RawFrameSplitter {
  readonly frameBytes: number;
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  constructor(readonly width: number, readonly height: number, readonly bytesPerPixel = 3) {
    this.frameBytes = width * height * bytesPerPixel;
    if (!Number.isInteger(this.frameBytes) || this.frameBytes <= 0) {
      throw new Error(`Invalid raw frame size ${width}x${height}`);
    }
  }

  /** Feeds a chunk; returns the complete frames it finished. */
  push(chunk: Buffer): Buffer[] {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    const out: Buffer[] = [];
    if (this.pendingBytes < this.frameBytes) return out;
    let buf = Buffer.concat(this.pending, this.pendingBytes);
    let offset = 0;
    while (buf.length - offset >= this.frameBytes) {
      // Copy so the frame does not pin the whole concatenated buffer.
      out.push(Buffer.from(buf.subarray(offset, offset + this.frameBytes)));
      offset += this.frameBytes;
    }
    buf = buf.subarray(offset);
    this.pending = buf.length ? [Buffer.from(buf)] : [];
    this.pendingBytes = buf.length;
    return out;
  }
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const MAX_JPEG_BYTES = 5 * 1024 * 1024;

/** Cuts JPEG images out of an MJPEG (image2pipe) byte stream by their SOI/EOI markers. */
export class MjpegSplitter {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const out: Buffer[] = [];
    for (;;) {
      const soi = this.buffer.indexOf(SOI);
      if (soi === -1) {
        // Keep the last byte in case a marker is split across chunks.
        this.buffer = this.buffer.length > 1 ? this.buffer.subarray(this.buffer.length - 1) : this.buffer;
        break;
      }
      const eoi = this.buffer.indexOf(EOI, soi + 2);
      if (eoi === -1) {
        if (soi > 0) this.buffer = this.buffer.subarray(soi);
        if (this.buffer.length > MAX_JPEG_BYTES) this.buffer = Buffer.alloc(0);
        break;
      }
      out.push(Buffer.from(this.buffer.subarray(soi, eoi + 2)));
      this.buffer = this.buffer.subarray(eoi + 2);
    }
    return out;
  }
}
