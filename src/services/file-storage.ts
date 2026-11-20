import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { copyFile, link, mkdir, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
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
  const { name, size, mime, sha256, lastModified: date } = input as Record<string, unknown>;
  if (typeof name !== 'string' || !name || name.length > 500) throw new UploadError('Nom de fichier invalide');
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new UploadError('Taille de fichier invalide');
  if (maxBytes !== undefined && size > maxBytes) throw new UploadError('Fichier trop volumineux', 413);
  if (!validSha256(sha256)) throw new UploadError('SHA-256 invalide');
  if (typeof mime !== 'string' || mime.length > 200 || /[\x00-\x1f]/.test(mime)) throw new UploadError('Type MIME invalide');
  let lastModified: number | undefined;
  if (date !== undefined && date !== null && date !== '') {
    if (typeof date !== 'number' || !Number.isSafeInteger(date) || date <= 0 || date > Date.now() + 86_400_000) {
      throw new UploadError('Date de modification invalide');
    }
    lastModified = date;
  }
  return { name, size, mime, lastModified, sha256: sha256.toLowerCase() };
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

export async function writeVerifiedStream(
  source: Readable & { truncated?: boolean },
  target: Writable,
  { size, sha256 }: Pick<FileMetadata, 'size' | 'sha256'>,
  errors: { tooLarge: string; incomplete: string; mismatch: string; truncated?: string },
  onProgress?: (bytes: number) => void,
): Promise<void> {
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > size) return callback(new UploadError(errors.tooLarge));
      hash.update(chunk);
      onProgress?.(bytes);
      callback(null, chunk);
    },
  });
  await pipeline(source, meter, target);
  if (source.truncated) throw new UploadError(errors.truncated ?? errors.incomplete);
  if (bytes !== size) throw new UploadError(errors.incomplete);
  if (!sameSha256(hash.digest('hex'), sha256)) throw new UploadError(errors.mismatch);
}

export async function storeFile(destination: string, source: Readable, metadata: FileMetadata, onProgress?: (bytes: number) => void, temporaryDirectory = destination): Promise<StoredFile> {
  await mkdir(destination, { recursive: true });
  if (temporaryDirectory !== destination) await mkdir(temporaryDirectory, { recursive: true });
  const temporary = join(temporaryDirectory, `.${randomUUID()}.part`);
  try {
    await writeVerifiedStream(source, createWriteStream(temporary, { flags: 'wx' }), metadata, {
      tooLarge: 'Fichier plus grand que la taille annoncée',
      truncated: 'Fichier tronqué',
      incomplete: 'Envoi interrompu ou taille incorrecte',
      mismatch: 'SHA-256 différent : fichier supprimé, recommencez le transfert',
    }, onProgress);
    return await publishVerifiedFile(destination, temporary, metadata);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
