import { hashFileChunks } from './sha256.js';

self.onmessage = async ({ data }) => {
  const { file, chunkSize } = data;
  try {
    const hashes = await hashFileChunks(file, chunkSize, (bytes) => self.postMessage({ type: 'progress', bytes }));
    self.postMessage({ type: 'done', ...hashes });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Fichier inaccessible' });
  }
};
