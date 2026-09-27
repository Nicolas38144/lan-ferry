import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import QRCode from 'qrcode';
import type { Config } from '../services/config.js';
import { parseMetadata, storeFile, UploadError, type StoredFile } from '../services/file-storage.js';
import { ResumableStorage } from '../services/resumable-storage.js';
import { SessionAuth } from './auth.js';
import { networkAddresses } from './network.js';

function localClient(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] || char);
}

function uploadFailure(reply: FastifyReply, error: unknown): FastifyReply {
  const status = error instanceof UploadError ? error.statusCode : (error as { statusCode?: number }).statusCode || 500;
  const message = status >= 500 && status !== 507 ? 'Erreur de réception ou d’écriture sur le PC' : (error as Error).message;
  console.error(`Échec de transfert : ${(error as Error).message}`);
  return reply.code(status).send({ error: message });
}

export async function createServer(config: Config): Promise<{ server: FastifyInstance; auth: SessionAuth }> {
  const server = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const auth = new SessionAuth(config.auth);
  const files: StoredFile[] = [];
  const active = new Map<string, { name: string; bytes: number; size: number }>();
  const resumable = new ResumableStorage(
    config.destination, config.concurrency, config.maxBytes,
    () => active.size,
    () => [...active.values()].reduce((sum, item) => sum + item.size - item.bytes, 0),
  );
  await resumable.initialize();
  const cleanupTimer = setInterval(() => resumable.cleanupExpired().catch((error: unknown) => console.error('Nettoyage des transferts incomplets impossible :', error)), 60 * 60 * 1000);
  cleanupTimer.unref();
  server.addHook('onClose', async () => clearInterval(cleanupTimer));
  const addresses = networkAddresses();
  const assets = resolve(__dirname, '../../public');
  await server.register(multipart, {
    limits: { files: 1, fields: 0, parts: 1, fileSize: config.maxBytes ?? Number.MAX_SAFE_INTEGER },
    throwFileSizeLimit: true,
  });

  server.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    if (request.url.startsWith('/api/') && !auth.authorized(request)) {
      reply.code(401).send({ error: 'Session non autorisée. Scannez à nouveau le QR code.' });
    }
  });

  server.get('/', async (request, reply) => {
    const query = request.query as { token?: string };
    if (typeof query.token === 'string' && auth.matches(query.token)) {
      return reply.header('Set-Cookie', auth.cookie()).redirect('/');
    }
    if (!auth.authorized(request)) {
      return reply.code(401).type('text/html; charset=utf-8').send('<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accès requis</title><body style="font:18px system-ui;max-width:36rem;margin:4rem auto;padding:1rem"><h1>Accès requis</h1><p>Scannez le QR code affiché sur le PC pour ouvrir une session.</p></body></html>');
    }
    return reply.type('text/html; charset=utf-8').send(createReadStream(join(assets, 'index.html')));
  });

  for (const [url, name, mime] of [
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/sha256.js', 'sha256.js', 'text/javascript; charset=utf-8'],
    ['/hash-worker.js', 'hash-worker.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ] as const) {
    server.get(url, async (_request, reply) => reply.type(mime).send(createReadStream(join(assets, name))));
  }

  server.get('/api/status', async () => {
    const freeBytes = await resumable.freeBytes();
    return { active: true, addresses, destination: config.destination, freeBytes, received: files.length, activeTransfers: active.size + resumable.activeCount, resumablePending: resumable.pendingCount, concurrency: config.concurrency };
  });
  server.get('/api/files', async () => ({ files }));

  server.post('/api/uploads', async (request, reply) => {
    try {
      const session = await resumable.create(request.body);
      console.log(`Session de transfert créée : ${session.id}`);
      return reply.code(201).send(session);
    } catch (error) { return uploadFailure(reply, error); }
  });
  server.get<{ Params: { id: string } }>('/api/uploads/:id', async (request, reply) => {
    try { return resumable.status(request.params.id); }
    catch (error) { return uploadFailure(reply, error); }
  });
  server.post<{ Params: { id: string } }>('/api/uploads/:id/chunk', async (request, reply) => {
    try {
      const part = await request.file();
      if (!part) throw new UploadError('Bloc manquant');
      const offset = Number(request.headers['x-upload-offset']);
      const length = Number(request.headers['x-chunk-size']);
      const chunkHash = request.headers['x-chunk-sha256'];
      if (typeof chunkHash !== 'string') throw new UploadError('SHA-256 du bloc manquant');
      const nextOffset = await resumable.append(request.params.id, offset, length, chunkHash, part.file);
      return reply.send({ offset: nextOffset });
    } catch (error) { return uploadFailure(reply, error); }
  });
  server.post<{ Params: { id: string } }>('/api/uploads/:id/complete', async (request, reply) => {
    try {
      const saved = await resumable.complete(request.params.id);
      if (!files.some((file) => file.receivedAt === saved.receivedAt && file.savedAs === saved.savedAs)) {
        files.push(saved);
        console.log(`Terminé : ${saved.savedAs} — SHA-256 ${saved.sha256}`);
      }
      return reply.send({ message: 'Fichier vérifié — SHA-256 identique', file: saved });
    } catch (error) { return uploadFailure(reply, error); }
  });

  server.post('/api/upload', async (request, reply) => {
    if (active.size + resumable.activeCount >= config.concurrency) return reply.code(429).send({ error: 'Trop de transferts simultanés. Réessayez.' });
    let metadata;
    try { metadata = parseMetadata(request.headers, config.maxBytes); }
    catch (error) { return reply.code(error instanceof UploadError ? error.statusCode : 400).send({ error: (error as Error).message }); }
    try { await resumable.assertSpace(metadata.size); }
    catch (error) { return uploadFailure(reply, error); }
    const id = `${Date.now()}-${Math.random()}`;
    active.set(id, { name: metadata.name, bytes: 0, size: metadata.size });
    console.log(`Début : ${metadata.name} (${metadata.size} octets) depuis ${request.ip}`);
    try {
      const part = await request.file();
      if (!part) throw new UploadError('Fichier manquant');
      const saved = await storeFile(config.destination, part.file, metadata, (bytes) => {
        const entry = active.get(id);
        if (entry) entry.bytes = bytes;
      });
      files.push(saved);
      console.log(`Terminé : ${saved.savedAs} — SHA-256 ${saved.sha256}`);
      return reply.code(201).send({ message: 'Fichier vérifié — SHA-256 identique', file: saved });
    } catch (error) {
      return uploadFailure(reply, error);
    } finally { active.delete(id); }
  });

  server.get('/admin', async (request, reply) => {
    if (!localClient(request.ip)) return reply.code(403).send('Page disponible uniquement sur le PC');
    const primary = addresses[0]?.address || '127.0.0.1';
    const url = `http://${primary}:${config.port}/?token=${auth.token}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1 });
    const html = await readFile(join(assets, 'admin.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html.replaceAll('{{QR}}', svg).replaceAll('{{URL}}', escapeHtml(url)).replaceAll('{{DESTINATION}}', escapeHtml(config.destination)));
  });
  server.get('/admin/status', async (request, reply) => {
    if (!localClient(request.ip)) return reply.code(403).send({ error: 'Accès local uniquement' });
    return { files, active: [...active.values(), ...resumable.activeTransfers], resumablePending: resumable.pendingCount };
  });
  return { server, auth };
}
