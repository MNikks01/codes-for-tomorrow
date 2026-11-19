import { createHash, randomBytes } from 'node:crypto';

/** 256 bits of entropy; only the SHA-256 digest is ever persisted. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
