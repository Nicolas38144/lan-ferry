import { createHash, timingSafeEqual } from 'node:crypto';

export function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

export function sameSha256(left: string, right: string): boolean {
  if (!validSha256(left) || !validSha256(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
