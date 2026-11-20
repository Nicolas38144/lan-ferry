import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

const projectRoot = resolve(__dirname, '../..');

export interface Config {
  port: number;
  host: string;
  destination: string;
  concurrency: number;
  maxBytes?: number;
  auth: boolean;
}

type Setting = 'PORT' | 'HOST' | 'DESTINATION' | 'CONCURRENCY' | 'MAX_BYTES' | 'AUTH';

function setting(name: Setting): string | undefined {
  return process.env[`FILE_TRANSFER_${name}`] ?? process.env[`PHOTO_TRANSFER_${name}`];
}

function integer(name: Setting, min: number, max: number): number | undefined {
  const raw = setting(name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`FILE_TRANSFER_${name} doit être un entier entre ${min} et ${max}`);
  }
  return value;
}

export function loadConfig(): Config {
  try { loadEnvFile(join(projectRoot, '.env')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const host = setting('HOST') || '0.0.0.0';
  if (!/^(0\.0\.0\.0|127\.0\.0\.1|localhost|\d{1,3}(?:\.\d{1,3}){3})$/.test(host)) {
    throw new Error('FILE_TRANSFER_HOST doit être une adresse IPv4 locale');
  }
  const authRaw = setting('AUTH')?.toLowerCase();
  if (authRaw !== undefined && !['true', 'false'].includes(authRaw)) {
    throw new Error('FILE_TRANSFER_AUTH doit valoir true ou false');
  }
  return {
    port: integer('PORT', 1, 65535) ?? 8080,
    host,
    destination: resolve(setting('DESTINATION') || join(projectRoot, 'output')),
    concurrency: integer('CONCURRENCY', 1, 8) ?? 2,
    maxBytes: integer('MAX_BYTES', 1, Number.MAX_SAFE_INTEGER),
    auth: authRaw !== 'false',
  };
}
