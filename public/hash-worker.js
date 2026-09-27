import { Sha256 } from './sha256.js';

self.onmessage = async ({ data }) => {
  const { file, chunkSize } = data;
  try {
    const full = new Sha256();
    const chunks = [];
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const bytes = new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer());
      full.update(bytes);
      chunks.push(new Sha256().update(bytes).hex());
      self.postMessage({ type: 'progress', bytes: offset + bytes.length });
    }
    self.postMessage({ type: 'done', sha256: full.hex(), chunks });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Fichier inaccessible' });
  }
};
