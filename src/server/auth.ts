import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export class SessionAuth {
  readonly token = randomBytes(24).toString('base64url');
  constructor(readonly enabled: boolean) {}

  matches(value: string): boolean {
    const actual = Buffer.from(value);
    const expected = Buffer.from(this.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  authorized(request: FastifyRequest): boolean {
    if (!this.enabled) return true;
    const cookie = request.headers.cookie?.split(';').map((entry) => entry.trim()).find((entry) => entry.startsWith('pt_session='));
    return this.matches(cookie?.slice('pt_session='.length) || '');
  }

  cookie(): string {
    return `pt_session=${this.token}; HttpOnly; SameSite=Strict; Path=/`;
  }
}
