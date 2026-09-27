import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, statfs, truncate, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sameSha256, validSha256 } from './checksum.js';
import { publishVerifiedFile, UploadError, validateMetadata, type FileMetadata, type StoredFile } from './file-storage.js';

export const CHUNK_BYTES = 4 * 1024 * 1024;
export const PARTIAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function transferStateDirectory(destination: string): string {
  const resolved = resolve(destination);
  const id = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return join(dirname(resolved), `.file-transfer-state-${id}`);
}

interface TransferRecord {
  id: string;
  metadata: FileMetadata;
  offset: number;
  updatedAt: number;
  busy: boolean;
}

interface Receipt { file: StoredFile; completedAt: number }

function asUploadError(error: unknown): UploadError {
  if (error instanceof UploadError) return error;
  if ((error as NodeJS.ErrnoException).code === 'ENOSPC') return new UploadError('Disque plein sur le PC', 507);
  return new UploadError('Erreur d’écriture sur le PC', 500);
}

export class ResumableStorage {
  private readonly stateDirectory: string;
  private readonly transfers = new Map<string, TransferRecord>();
  private readonly receipts = new Map<string, Receipt>();
  private activeChunks = 0;
  private createLock: Promise<void> = Promise.resolve();

  constructor(
    private readonly destination: string,
    private readonly concurrency: number,
    private readonly maxBytes?: number,
    private readonly otherActive: () => number = () => 0,
    private readonly otherReserved: () => number = () => 0,
  ) { this.stateDirectory = transferStateDirectory(destination); }

  private part(id: string): string { return join(this.stateDirectory, `.transfer-${id}.part`); }
  private manifest(id: string): string { return join(this.stateDirectory, `.transfer-${id}.json`); }
  private receiptPath(id: string): string { return join(this.stateDirectory, `.transfer-${id}.done.json`); }

  private async persist(record: TransferRecord): Promise<void> {
    const temporary = `${this.manifest(record.id)}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify({ id: record.id, metadata: record.metadata, offset: record.offset, updatedAt: record.updatedAt }), { flag: 'wx' });
      await rename(temporary, this.manifest(record.id));
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  private async discard(id: string): Promise<void> {
    this.transfers.delete(id);
    await Promise.all([unlink(this.part(id)).catch(() => undefined), unlink(this.manifest(id)).catch(() => undefined)]);
  }

  async initialize(): Promise<void> {
    await mkdir(this.destination, { recursive: true });
    await mkdir(this.stateDirectory, { recursive: true });
    for (const filename of await readdir(this.destination)) {
      const match = /^\.transfer-([0-9a-f-]+)(?:\.part|\.json|\.done\.json|\.json\.tmp-[0-9a-f-]+)$/i.exec(filename);
      if (!match || !idPattern.test(match[1] || '')) continue;
      await rename(join(this.destination, filename), join(this.stateDirectory, filename));
    }
    const entries = await readdir(this.stateDirectory);
    const now = Date.now();
    for (const filename of entries) {
      const match = /^\.transfer-([0-9a-f-]+)\.json$/i.exec(filename);
      if (!match || !idPattern.test(match[1] || '')) continue;
      const id = match[1]!;
      try {
        const raw = JSON.parse(await readFile(this.manifest(id), 'utf8')) as Partial<TransferRecord>;
        if (raw.id !== id || !Number.isSafeInteger(raw.offset) || !Number.isSafeInteger(raw.updatedAt)) throw new Error('Invalid transfer record');
        const metadata = validateMetadata(raw.metadata, this.maxBytes);
        const offset = raw.offset as number;
        const updatedAt = raw.updatedAt as number;
        const info = await stat(this.part(id));
        if (!info.isFile() || offset < 0 || offset > metadata.size || info.size < offset || now - updatedAt > PARTIAL_RETENTION_MS) throw new Error('Expired or incomplete transfer record');
        if (info.size > offset) await truncate(this.part(id), offset);
        this.transfers.set(id, { id, metadata, offset, updatedAt, busy: false });
      } catch { await this.discard(id); }
    }
    for (const filename of entries) {
      const match = /^\.transfer-([0-9a-f-]+)\.done\.json$/i.exec(filename);
      if (!match || !idPattern.test(match[1] || '')) continue;
      await unlink(this.receiptPath(match[1]!));
    }
    for (const filename of entries) {
      const match = /^\.transfer-([0-9a-f-]+)\.part$/i.exec(filename);
      if (!match || !idPattern.test(match[1] || '') || this.transfers.has(match[1]!)) continue;
      const file = join(this.stateDirectory, filename);
      try { if (now - (await stat(file)).mtimeMs > 60 * 60 * 1000) await unlink(file); }
      catch { /* Another process may have removed it. */ }
    }
    for (const filename of await readdir(this.destination)) {
      const match = /^\.(.+)\.part$/i.exec(filename);
      if (!match || !idPattern.test(match[1] || '')) continue;
      const file = join(this.destination, filename);
      try { if (now - (await stat(file)).mtimeMs > PARTIAL_RETENTION_MS) await unlink(file); }
      catch { /* Another process may have removed it. */ }
    }
    for (const filename of entries) {
      if (!/^\.transfer-[0-9a-f-]+\.json\.tmp-[0-9a-f-]+$/i.test(filename)) continue;
      const file = join(this.stateDirectory, filename);
      try { if (now - (await stat(file)).mtimeMs > 60 * 60 * 1000) await unlink(file); }
      catch { /* Another process may have removed it. */ }
    }
  }

  async freeBytes(): Promise<number | null> {
    try { const info = await statfs(this.destination, { bigint: true }); return Number(info.bavail * info.bsize); }
    catch { return null; }
  }

  async assertSpace(bytes: number): Promise<void> {
    const free = await this.freeBytes();
    if (free === null) return;
    const reserved = this.otherReserved() + [...this.transfers.values()].reduce((sum, item) => sum + item.metadata.size - item.offset, 0);
    if (bytes + reserved > free) throw new UploadError('Espace disque insuffisant sur le PC', 507);
  }

  async create(input: unknown): Promise<{ id: string; offset: number; chunkSize: number }> {
    const metadata = validateMetadata(input, this.maxBytes);
    const previous = this.createLock;
    let release!: () => void;
    this.createLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.cleanupExpired();
      await this.assertSpace(metadata.size);
      const id = randomUUID();
      const record: TransferRecord = { id, metadata, offset: 0, updatedAt: Date.now(), busy: false };
      this.transfers.set(id, record);
      try {
        const handle = await open(this.part(id), 'wx');
        await handle.close();
        await this.persist(record);
        return { id, offset: 0, chunkSize: CHUNK_BYTES };
      } catch (error) { await this.discard(id); throw asUploadError(error); }
    } finally { release(); }
  }

  status(id: string): { state: 'pending'; id: string; offset: number; size: number; sha256: string; chunkSize: number } | { state: 'complete'; id: string; file: StoredFile } {
    const receipt = this.receipts.get(id);
    if (receipt) return { state: 'complete', id, file: receipt.file };
    const record = this.transfers.get(id);
    if (!record) throw new UploadError('Transfert introuvable ou expiré', 404);
    return { state: 'pending', id, offset: record.offset, size: record.metadata.size, sha256: record.metadata.sha256, chunkSize: CHUNK_BYTES };
  }

  private record(id: string): TransferRecord {
    if (!idPattern.test(id)) throw new UploadError('Identifiant de transfert invalide', 400);
    const record = this.transfers.get(id);
    if (!record) throw new UploadError('Transfert introuvable ou expiré', 404);
    return record;
  }

  async append(id: string, offset: number, expectedLength: number, expectedHash: string, source: Readable): Promise<number> {
    const record = this.record(id);
    if (record.busy) throw new UploadError('Transfert déjà en cours', 409);
    if (this.activeChunks + this.otherActive() >= this.concurrency) throw new UploadError('Trop de transferts simultanés', 429);
    if (!Number.isSafeInteger(offset) || offset !== record.offset) throw new UploadError('Offset incorrect : demandez à nouveau l’état du transfert', 409);
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > CHUNK_BYTES || offset + expectedLength > record.metadata.size) throw new UploadError('Taille de bloc invalide');
    if (!validSha256(expectedHash)) throw new UploadError('SHA-256 du bloc invalide');
    record.busy = true;
    this.activeChunks++;
    const hash = createHash('sha256');
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > expectedLength) return callback(new UploadError('Bloc plus grand que la taille annoncée'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      const free = await this.freeBytes();
      if (free !== null && free < expectedLength) throw new UploadError('Espace disque insuffisant sur le PC', 507);
      await pipeline(source, meter, createWriteStream(this.part(id), { flags: 'r+', start: offset }));
      if ((source as Readable & { truncated?: boolean }).truncated || bytes !== expectedLength) throw new UploadError('Bloc interrompu ou incomplet');
      if (!sameSha256(hash.digest('hex'), expectedHash)) throw new UploadError('SHA-256 du bloc différent : réessayez ce bloc');
      const updated: TransferRecord = { ...record, offset: offset + bytes, updatedAt: Date.now() };
      await this.persist(updated);
      record.offset = updated.offset;
      record.updatedAt = updated.updatedAt;
      return record.offset;
    } catch (error) {
      await truncate(this.part(id), offset).catch(() => undefined);
      throw asUploadError(error);
    } finally {
      record.busy = false;
      this.activeChunks--;
    }
  }

  async complete(id: string): Promise<StoredFile> {
    const receipt = this.receipts.get(id);
    if (receipt) return receipt.file;
    const record = this.record(id);
    if (record.busy) throw new UploadError('Transfert déjà en cours', 409);
    if (record.offset !== record.metadata.size) throw new UploadError('Transfert incomplet', 409);
    record.busy = true;
    try {
      const info = await stat(this.part(id));
      if (info.size !== record.metadata.size) throw new UploadError('Taille finale incorrecte', 422);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(this.part(id))) hash.update(chunk as Buffer);
      if (!sameSha256(hash.digest('hex'), record.metadata.sha256)) {
        await this.discard(id);
        throw new UploadError('SHA-256 final différent : transfert supprimé, recommencez', 422);
      }
      const saved = await publishVerifiedFile(this.destination, this.part(id), record.metadata);
      const result: Receipt = { file: saved, completedAt: Date.now() };
      this.receipts.set(id, result);
      await this.discard(id);
      return saved;
    } catch (error) { throw asUploadError(error); }
    finally { record.busy = false; }
  }

  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    for (const [id, record] of this.transfers) {
      if (!record.busy && now - record.updatedAt > PARTIAL_RETENTION_MS) await this.discard(id);
    }
    for (const [id, receipt] of this.receipts) {
      if (now - receipt.completedAt > PARTIAL_RETENTION_MS) {
        this.receipts.delete(id);
      }
    }
  }

  get pendingCount(): number { return this.transfers.size; }
  get activeCount(): number { return this.activeChunks; }
  get activeTransfers(): Array<{ name: string; bytes: number; size: number }> {
    return [...this.transfers.values()].filter((record) => record.busy).map((record) => ({ name: record.metadata.name, bytes: record.offset, size: record.metadata.size }));
  }
}
