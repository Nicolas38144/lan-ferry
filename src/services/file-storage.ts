import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, unlink, utimes } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { collisionName, safeFilename } from '../utils/filename.js';
import { sameSha256, validSha256 } from './checksum.js';

export interface FileMetadata {
  name: string;
  size: number;
  mime: string;
  lastModified?: number;
  sha256: string;
}

export interface StoredFile extends FileMetadata {
  savedAs: string;
  receivedAt: string;
}

export class UploadError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}

export function validateMetadata(input: unknown, maxBytes?: number): FileMetadata {
  if (!input || typeof input !== 'object') throw new UploadError('Métadonnées manquantes');
  const data = input as Record<string, unknown>;
  if (typeof data.name !== 'string' || !data.name || data.name.length > 500) throw new UploadError('Nom de fichier invalide');
  if (!Number.isSafeInteger(data.size) || (data.size as number) < 0) throw new UploadError('Taille de fichier invalide');
  const size = data.size as number;
  if (maxBytes !== undefined && size > maxBytes) throw new UploadError('Fichier trop volumineux', 413);
  if (typeof data.sha256 !== 'string' || !validSha256(data.sha256)) throw new UploadError('SHA-256 invalide');
  if (typeof data.mime !== 'string' || data.mime.length > 200 || /[\x00-\x1f]/.test(data.mime)) throw new UploadError('Type MIME invalide');
  let lastModified: number | undefined;
  if (data.lastModified !== undefined && data.lastModified !== null && data.lastModified !== '') {
    if (!Number.isSafeInteger(data.lastModified) || (data.lastModified as number) <= 0 || (data.lastModified as number) > Date.now() + 86_400_000) {
      throw new UploadError('Date de modification invalide');
    }
    lastModified = data.lastModified as number;
  }
  return { name: data.name, size, mime: data.mime, lastModified, sha256: data.sha256.toLowerCase() };
}

export function parseMetadata(headers: Record<string, unknown>, maxBytes?: number): FileMetadata {
  const value = (key: string): string => {
    const item = headers[key];
    if (typeof item !== 'string') throw new UploadError(`En-tête ${key} manquant`);
    return item;
  };
  let name: string;
  try { name = decodeURIComponent(value('x-file-name')); }
  catch { throw new UploadError('Nom de fichier invalide'); }
  const size = Number(value('x-file-size'));
  const sha256 = value('x-file-sha256');
  const mime = value('x-file-mime');
  const date = headers['x-file-last-modified'];
  const lastModified = typeof date === 'string' && date !== '' ? Number(date) : undefined;
  return validateMetadata({ name, size, mime, lastModified, sha256 }, maxBytes);
}

export async function publishVerifiedFile(destination: string, temporary: string, metadata: FileMetadata): Promise<StoredFile> {
  const safeName = safeFilename(metadata.name);
  let savedAs: string | undefined;
  for (let index = 0; index < 100_000; index++) {
    const candidate = collisionName(safeName, index);
    const target = join(destination, candidate);
    try {
      try { await link(temporary, target); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
          try { await copyFile(temporary, target, constants.COPYFILE_EXCL); }
          catch (copyError) {
            if ((copyError as NodeJS.ErrnoException).code !== 'EEXIST') await unlink(target).catch(() => undefined);
            throw copyError;
          }
        } else throw error;
      }
      savedAs = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  if (!savedAs) throw new UploadError('Trop de fichiers du même nom', 409);
  if (metadata.lastModified) {
    const time = new Date(metadata.lastModified);
    try { await utimes(join(destination, savedAs), time, time); }
    catch { /* Le système de fichiers peut refuser la date ; le contenu reste intact. */ }
  }
  return { ...metadata, savedAs, receivedAt: new Date().toISOString() };
}

export async function storeFile(destination: string, source: Readable, metadata: FileMetadata, onProgress?: (bytes: number) => void, temporaryDirectory = destination): Promise<StoredFile> {
  await mkdir(destination, { recursive: true });
  await mkdir(temporaryDirectory, { recursive: true });
  const temporary = join(temporaryDirectory, `.${randomUUID()}.part`);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > metadata.size) return callback(new UploadError('Fichier plus grand que la taille annoncée'));
      hash.update(chunk);
      onProgress?.(bytes);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, createWriteStream(temporary, { flags: 'wx' }));
    if ((source as Readable & { truncated?: boolean }).truncated) throw new UploadError('Fichier tronqué');
    if (bytes !== metadata.size) throw new UploadError('Envoi interrompu ou taille incorrecte');
    if (!sameSha256(hash.digest('hex'), metadata.sha256)) throw new UploadError('SHA-256 différent : fichier supprimé, recommencez le transfert');
    return await publishVerifiedFile(destination, temporary, metadata);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
