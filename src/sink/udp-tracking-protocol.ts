import type { BoundingBox2D, TrackedSubject } from '../types.js';

export const TRACKING_MAGIC = 0x5054; // ASCII "PT" (Pi Tracking)
export const TRACKING_VERSION = 1;
export const TRACKING_TYPE_SNAPSHOT = 0x01;
/** Flag bit: the camera's picture cannot be trusted now (moving, blurred, stale, frozen); an empty list means "unknown", not "nobody". */
export const TRACKING_FLAG_DEGRADED = 0x0001;

export interface ScreenTrackObject {
  trackId: number;
  confidence: number; // 0..100
  classId: number;    // 0 = person, 1 = face, etc.
  bbox: BoundingBox2D; // [ymin, xmin, ymax, xmax] in 0.0..1.0
  velocity?: { vx: number; vy: number } | undefined;
  label?: string | undefined;
}

export interface ScreenTrackingPacket {
  sequence: number;
  timestampMs: number;
  cameraId: string;
  /** Bit field, see TRACKING_FLAG_*. 0 when omitted. */
  flags?: number | undefined;
  objects: ScreenTrackObject[];
}

/**
 * Encodes screen-tracking data into a binary datagram.
 *
 * Wire format:
 * [0..1]   Magic 0x5054 ("PT")
 * [2]      Version (1)
 * [3]      Type (1 = Snapshot)
 * [4..5]   Flags (UInt16BE; bit 0 = camera degraded, see TRACKING_FLAG_DEGRADED)
 * [6..9]   Sequence (UInt32BE)
 * [10..17] TimestampMs (BigUInt64BE)
 * [18]     CameraId length N (UInt8)
 * [19..19+N-1] CameraId string (UTF-8)
 * [19+N]   Object count K (UInt8)
 * Followed by K objects, 18 bytes each:
 *   [0..1]   trackId (UInt16BE)
 *   [2]      confidence (UInt8, 0..100)
 *   [3]      classId (UInt8, 0 = person)
 *   [4..5]   ymin (UInt16BE, normalized * 65535)
 *   [6..7]   xmin (UInt16BE, normalized * 65535)
 *   [8..9]   ymax (UInt16BE, normalized * 65535)
 *   [10..11] xmax (UInt16BE, normalized * 65535)
 *   [12..13] vx (Int16BE, fixed-point * 10000)
 *   [14..15] vy (Int16BE, fixed-point * 10000)
 *   [16..17] reserved (0x0000)
 */
export function encodeTrackingPacket(packet: ScreenTrackingPacket): Buffer {
  const camIdBuf = Buffer.from(packet.cameraId, 'utf8');
  const camIdLen = Math.min(64, camIdBuf.length);
  const objectCount = Math.min(255, packet.objects.length);

  const headerLen = 19 + camIdLen + 1; // 20 + camIdLen
  const totalLen = headerLen + objectCount * 18;
  const buf = Buffer.alloc(totalLen);

  let offset = 0;
  buf.writeUInt16BE(TRACKING_MAGIC, offset);
  offset += 2;
  buf.writeUInt8(TRACKING_VERSION, offset);
  offset += 1;
  buf.writeUInt8(TRACKING_TYPE_SNAPSHOT, offset);
  offset += 1;
  buf.writeUInt16BE((packet.flags ?? 0) & 0xffff, offset); // flags
  offset += 2;
  buf.writeUInt32BE(packet.sequence >>> 0, offset);
  offset += 4;
  buf.writeBigUInt64BE(BigInt(packet.timestampMs), offset);
  offset += 8;

  buf.writeUInt8(camIdLen, offset);
  offset += 1;
  camIdBuf.copy(buf, offset, 0, camIdLen);
  offset += camIdLen;

  buf.writeUInt8(objectCount, offset);
  offset += 1;

  for (let i = 0; i < objectCount; i++) {
    const obj = packet.objects[i]!;
    buf.writeUInt16BE(obj.trackId & 0xffff, offset);
    offset += 2;
    buf.writeUInt8(Math.max(0, Math.min(100, Math.round(obj.confidence))), offset);
    offset += 1;
    buf.writeUInt8(obj.classId & 0xff, offset);
    offset += 1;

    // Scale [0..1] to [0..65535]
    const ymin = Math.max(0, Math.min(65535, Math.round(obj.bbox[0] * 65535)));
    const xmin = Math.max(0, Math.min(65535, Math.round(obj.bbox[1] * 65535)));
    const ymax = Math.max(0, Math.min(65535, Math.round(obj.bbox[2] * 65535)));
    const xmax = Math.max(0, Math.min(65535, Math.round(obj.bbox[3] * 65535)));

    buf.writeUInt16BE(ymin, offset);
    offset += 2;
    buf.writeUInt16BE(xmin, offset);
    offset += 2;
    buf.writeUInt16BE(ymax, offset);
    offset += 2;
    buf.writeUInt16BE(xmax, offset);
    offset += 2;

    const vx = Math.max(-32768, Math.min(32767, Math.round((obj.velocity?.vx ?? 0) * 10000)));
    const vy = Math.max(-32768, Math.min(32767, Math.round((obj.velocity?.vy ?? 0) * 10000)));
    buf.writeInt16BE(vx, offset);
    offset += 2;
    buf.writeInt16BE(vy, offset);
    offset += 2;

    buf.writeUInt16BE(0, offset); // reserved
    offset += 2;
  }

  return buf;
}

/**
 * Decodes a binary wire packet OR a JSON packet into ScreenTrackingPacket.
 */
export function decodeTrackingPacket(buf: Buffer): ScreenTrackingPacket | null {
  if (buf.length < 2) return null;

  // JSON fallback if starts with '{' (0x7B)
  if (buf[0] === 0x7b) {
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.cameraId) return null;
      return {
        sequence: typeof parsed.sequence === 'number' ? parsed.sequence : 0,
        timestampMs: typeof parsed.timestampMs === 'number' ? parsed.timestampMs : Date.now(),
        cameraId: String(parsed.cameraId),
        objects: Array.isArray(parsed.objects)
          ? parsed.objects.map((o: any) => ({
              trackId: Number(o.trackId ?? 0),
              confidence: Number(o.confidence ?? 100),
              classId: Number(o.classId ?? 0),
              bbox: Array.isArray(o.bbox) && o.bbox.length === 4
                ? [Number(o.bbox[0]), Number(o.bbox[1]), Number(o.bbox[2]), Number(o.bbox[3])]
                : [o.bbox?.y ?? 0, o.bbox?.x ?? 0, (o.bbox?.y ?? 0) + (o.bbox?.h ?? 0), (o.bbox?.x ?? 0) + (o.bbox?.w ?? 0)],
              velocity: o.velocity,
              label: o.label,
            }))
          : [],
      };
    } catch {
      return null;
    }
  }

  // Binary packet
  if (buf.length < 20) return null;

  let offset = 0;
  const magic = buf.readUInt16BE(offset);
  offset += 2;
  if (magic !== TRACKING_MAGIC) return null;

  const version = buf.readUInt8(offset);
  offset += 1;
  if (version !== TRACKING_VERSION) return null;

  const type = buf.readUInt8(offset);
  offset += 1;
  if (type !== TRACKING_TYPE_SNAPSHOT) return null;

  const flags = buf.readUInt16BE(offset);
  offset += 2;

  const sequence = buf.readUInt32BE(offset);
  offset += 4;
  const timestampMs = Number(buf.readBigUInt64BE(offset));
  offset += 8;

  const camIdLen = buf.readUInt8(offset);
  offset += 1;
  if (offset + camIdLen > buf.length) return null;

  const cameraId = buf.toString('utf8', offset, offset + camIdLen);
  offset += camIdLen;

  if (offset >= buf.length) return null;
  const objectCount = buf.readUInt8(offset);
  offset += 1;

  if (offset + objectCount * 18 > buf.length) return null;

  const objects: ScreenTrackObject[] = [];
  for (let i = 0; i < objectCount; i++) {
    const trackId = buf.readUInt16BE(offset);
    offset += 2;
    const confidence = buf.readUInt8(offset);
    offset += 1;
    const classId = buf.readUInt8(offset);
    offset += 1;

    const ymin = buf.readUInt16BE(offset) / 65535;
    offset += 2;
    const xmin = buf.readUInt16BE(offset) / 65535;
    offset += 2;
    const ymax = buf.readUInt16BE(offset) / 65535;
    offset += 2;
    const xmax = buf.readUInt16BE(offset) / 65535;
    offset += 2;

    const vx = buf.readInt16BE(offset) / 10000;
    offset += 2;
    const vy = buf.readInt16BE(offset) / 10000;
    offset += 2;

    offset += 2; // skip reserved

    objects.push({
      trackId,
      confidence,
      classId,
      label: classId === 0 ? 'person' : 'object',
      bbox: [
        Math.round(ymin * 1e4) / 1e4,
        Math.round(xmin * 1e4) / 1e4,
        Math.round(ymax * 1e4) / 1e4,
        Math.round(xmax * 1e4) / 1e4,
      ],
      velocity: { vx, vy },
    });
  }

  return {
    flags,
    sequence,
    timestampMs,
    cameraId,
    objects,
  };
}

/** Convert TrackedSubject list to ScreenTrackingPacket */
export function trackedSubjectsToPacket(
  cameraId: string,
  sequence: number,
  subjects: TrackedSubject[],
  timestampMs = Date.now(),
  flags = 0
): ScreenTrackingPacket {
  return {
    flags,
    sequence,
    timestampMs,
    cameraId,
    objects: subjects.map((s) => ({
      trackId: s.trackId,
      confidence: Math.round(s.confidence * 100),
      classId: 0,
      bbox: s.bbox,
      velocity: s.velocity,
      label: s.label,
    })),
  };
}
