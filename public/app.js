const $ = (id) => document.getElementById(id);
const input = $('file-input'), send = $('send'), clearPending = $('clear-pending'), retry = $('retry');
const CHUNK_SIZE = 4 * 1024 * 1024;
const items = [];
let busy = false, concurrency = 2, startedAt = 0;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${['o','Ko','Mo','Go','To'][unit]}`;
}

function updateProgress() {
  const total = items.reduce((sum, item) => sum + item.file.size, 0);
  const uploaded = items.reduce((sum, item) => sum + (item.state === 'Terminé' ? item.file.size : item.loaded), 0);
  const done = items.filter((item) => item.state === 'Terminé').length;
  const percent = total ? Math.min(100, Math.round(uploaded / total * 100)) : (done === items.length && items.length ? 100 : 0);
  $('global-percent').textContent = `${percent} %`;
  $('global-bar').style.width = `${percent}%`;
  const seconds = (Date.now() - startedAt) / 1000;
  const sentThisRun = items.reduce((sum, item) => sum + item.sentThisRun, 0);
  const speed = seconds > 0 && sentThisRun > 0 ? ` · ≈ ${formatBytes(sentThisRun / seconds)}/s` : '';
  $('global-detail').textContent = `${done} / ${items.length} fichiers · ${formatBytes(uploaded)} / ${formatBytes(total)}${speed}`;
  const current = items.find((item) => ['Envoi','Vérification','Calcul du hash'].includes(item.state));
  $('current-name').textContent = current?.file.name || (busy ? 'Préparation…' : 'Aucun transfert en cours');
  const currentBytes = current?.state === 'Calcul du hash' ? current.hashBytes : current?.loaded || 0;
  const currentPercent = current?.file.size ? Math.min(100, Math.round(currentBytes / current.file.size * 100)) : 0;
  $('current-percent').textContent = current ? `${currentPercent} %` : '';
  $('current-bar').style.width = `${currentPercent}%`;
  $('current-detail').textContent = current ? `${formatBytes(currentBytes)} / ${formatBytes(current.file.size)}` : '';
}

function setState(item, state, error = '') {
  item.state = state;
  item.error = error;
  item.status.textContent = error ? `${state} — ${error}` : state;
  item.row.dataset.state = state;
  updateProgress();
}

function sessionKey(item, digest) {
  return `file-transfer:v1:${digest}:${item.file.size}:${item.file.lastModified || 0}:${encodeURIComponent(item.file.name)}`;
}

function savedSession(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function saveSession(key, id) {
  try { localStorage.setItem(key, id); } catch { /* Private browsing may disable storage. */ }
}

function clearSession(key) {
  try { localStorage.removeItem(key); } catch { /* Ignore unavailable storage. */ }
}

function refreshSelection() {
  const total = items.reduce((sum, item) => sum + item.file.size, 0);
  const pending = items.some((item) => item.state === 'En attente');
  $('selection-count').textContent = `${items.length} fichier${items.length > 1 ? 's' : ''}`;
  $('selection-size').textContent = `Taille totale : ${formatBytes(total)}`;
  $('selection').classList.toggle('hidden', !items.length);
  $('list-section').classList.toggle('hidden', !items.length);
  clearPending.classList.toggle('hidden', !pending);
  clearPending.disabled = busy;
  send.disabled = busy || !items.some((item) => item.state !== 'Terminé');
}

function addSelectedFiles() {
  if (busy) return;
  const picked = Array.from(input.files || []);
  input.value = '';
  if (!picked.length) {
    $('picker-message').textContent = 'Aucun fichier reçu. Essayez de choisir les photos depuis l’application Fichiers ou d’ouvrir cette page dans un autre navigateur.';
    return;
  }
  $('picker-message').textContent = '';
  for (const file of picked) {
    const row = document.createElement('li'), details = document.createElement('div');
    const name = document.createElement('strong'), size = document.createElement('small'), status = document.createElement('span');
    name.textContent = file.name;
    size.textContent = formatBytes(file.size);
    status.className = 'state';
    details.append(name, size);
    row.append(details, status);
    $('file-list').append(row);
    const item = { file, row, status, state: '', loaded: 0, confirmed: 0, hashBytes: 0, hashInfo: null, sessionId: null, sentThisRun: 0, committedThisRun: 0, error: '' };
    items.push(item);
    setState(item, 'En attente');
  }
  refreshSelection();
  $('progress').classList.add('hidden');
  retry.classList.add('hidden');
  $('message').textContent = '';
}

input.addEventListener('change', addSelectedFiles);
clearPending.addEventListener('click', () => {
  if (busy) return;
  let removed = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index].state !== 'En attente') continue;
    items[index].row.remove();
    items.splice(index, 1);
    removed++;
  }
  if (!removed) return;
  refreshSelection();
  updateProgress();
  if (!items.length) $('progress').classList.add('hidden');
  $('picker-message').textContent = `${removed} fichier${removed > 1 ? 's' : ''} retiré${removed > 1 ? 's' : ''} de la liste.`;
});

async function fallbackHash(file, onProgress) {
  const { Sha256 } = await import('./sha256.js');
  const full = new Sha256(), chunks = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
    full.update(bytes);
    chunks.push(new Sha256().update(bytes).hex());
    onProgress(offset + bytes.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { sha256: full.hex(), chunks };
}

async function hashFile(item) {
  if (item.hashInfo) return item.hashInfo;
  setState(item, 'Calcul du hash');
  const onProgress = (bytes) => {
    item.hashBytes = bytes;
    item.status.textContent = `Calcul du hash — ${item.file.size ? Math.round(bytes / item.file.size * 100) : 100} %`;
    updateProgress();
  };
  if (typeof Worker === 'undefined') {
    item.hashInfo = await fallbackHash(item.file, onProgress);
    return item.hashInfo;
  }
  item.hashInfo = await new Promise((resolve, reject) => {
    const worker = new Worker('/hash-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data.bytes);
      if (data.type === 'done') { worker.terminate(); resolve({ sha256: data.sha256, chunks: data.chunks }); }
      if (data.type === 'error') { worker.terminate(); reject(new Error(data.message)); }
    };
    worker.onerror = () => { worker.terminate(); reject(new Error('Calcul SHA-256 indisponible dans ce navigateur')); };
    worker.postMessage({ file: item.file, chunkSize: CHUNK_SIZE });
  }).catch(() => fallbackHash(item.file, onProgress));
  return item.hashInfo;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(body.error || `Erreur du serveur (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function getOrCreateSession(item, digest, key) {
  const previousId = item.sessionId || savedSession(key);
  if (previousId) {
    try {
      const status = await requestJson(`/api/uploads/${encodeURIComponent(previousId)}`);
      if (status.state === 'complete') return status;
      if (status.sha256 === digest && status.size === item.file.size && status.chunkSize === CHUNK_SIZE) return status;
      item.sessionId = null;
      clearSession(key);
    } catch (error) {
      if (error.status !== 404) throw error;
      item.sessionId = null;
      clearSession(key);
    }
  }
  const metadata = {
    name: item.file.name, size: item.file.size,
    mime: item.file.type || 'application/octet-stream', sha256: digest,
  };
  if (Number.isSafeInteger(item.file.lastModified) && item.file.lastModified > 0) metadata.lastModified = item.file.lastModified;
  const session = await requestJson('/api/uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata),
  });
  item.sessionId = session.id;
  saveSession(key, session.id);
  return { state: 'pending', ...session };
}

function sendChunk(item, id, offset, digest) {
  const chunk = item.file.slice(offset, offset + CHUNK_SIZE);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/uploads/${encodeURIComponent(id)}/chunk`);
    xhr.setRequestHeader('X-Upload-Offset', String(offset));
    xhr.setRequestHeader('X-Chunk-Size', String(chunk.size));
    xhr.setRequestHeader('X-Chunk-Sha256', digest);
    xhr.upload.onprogress = (event) => {
      const partial = Math.min(chunk.size, Math.round(chunk.size * event.loaded / (event.total || chunk.size)));
      item.loaded = Math.min(item.file.size, offset + partial);
      item.sentThisRun = item.committedThisRun + partial;
      updateProgress();
    };
    xhr.onerror = () => reject(new Error('Connexion perdue. Le transfert pourra reprendre.'));
    xhr.onabort = () => reject(new Error('Transfert interrompu.'));
    xhr.onload = () => {
      let body;
      try { body = JSON.parse(xhr.responseText); } catch { body = {}; }
      if (xhr.status === 200) resolve(body.offset);
      else {
        const error = new Error(body.error || `Erreur du serveur (${xhr.status})`);
        error.status = xhr.status;
        reject(error);
      }
    };
    const form = new FormData();
    form.append('chunk', chunk, 'chunk.bin');
    xhr.send(form);
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function uploadChunks(item, session, hashes) {
  let offset = session.offset;
  while (offset < item.file.size) {
    if (offset % CHUNK_SIZE !== 0) throw new Error('Offset de reprise invalide sur le serveur');
    const index = offset / CHUNK_SIZE;
    const expected = Math.min(CHUNK_SIZE, item.file.size - offset);
    let attempts = 0;
    while (true) {
      try {
        const next = await sendChunk(item, session.id, offset, hashes[index]);
        if (next !== offset + expected) throw new Error('Offset confirmé inattendu');
        offset = next;
        break;
      } catch (error) {
        attempts++;
        await pause(Math.min(1000 * attempts, 3000));
        let status;
        try { status = await requestJson(`/api/uploads/${encodeURIComponent(session.id)}`); }
        catch (statusError) {
          if (attempts >= 3 || statusError.status === 404) throw statusError;
          continue;
        }
        if (status.state === 'complete') return status;
        if (status.offset === offset + expected) { offset = status.offset; break; }
        if (status.offset !== offset || attempts >= 3) throw error;
      }
    }
    item.confirmed = offset;
    item.loaded = offset;
    item.committedThisRun += expected;
    item.sentThisRun = item.committedThisRun;
    updateProgress();
  }
  return null;
}

async function transfer(item) {
  let key;
  try {
    const { sha256, chunks } = await hashFile(item);
    key = sessionKey(item, sha256);
    const session = await getOrCreateSession(item, sha256, key);
    if (session.state !== 'complete') {
      item.confirmed = session.offset;
      item.loaded = session.offset;
      setState(item, 'Envoi');
      if (session.offset > 0) item.status.textContent = `Reprise à ${Math.round(session.offset / item.file.size * 100)} %`;
      const alreadyDone = await uploadChunks(item, session, chunks);
      if (!alreadyDone) {
        setState(item, 'Vérification');
        try {
          await requestJson(`/api/uploads/${encodeURIComponent(session.id)}/complete`, { method: 'POST' });
        } catch (error) {
          const status = await requestJson(`/api/uploads/${encodeURIComponent(session.id)}`).catch(() => null);
          if (status?.state !== 'complete') throw error;
        }
      }
    }
    item.confirmed = item.file.size;
    item.loaded = item.file.size;
    item.sessionId = null;
    clearSession(key);
    setState(item, 'Terminé');
    item.status.textContent = 'Fichier vérifié — SHA-256 identique';
  } catch (error) {
    item.loaded = item.confirmed;
    setState(item, 'Erreur', error instanceof Error ? error.message : 'Erreur inconnue');
  }
}

async function run(onlyErrors = false) {
  if (busy || !items.length) return;
  busy = true;
  input.disabled = true;
  refreshSelection();
  retry.classList.add('hidden');
  $('progress').classList.remove('hidden');
  $('message').textContent = '';
  startedAt = Date.now();
  const queue = items.filter((item) => onlyErrors ? item.state === 'Erreur' : item.state !== 'Terminé');
  for (const item of queue) {
    item.sentThisRun = 0;
    item.committedThisRun = 0;
    setState(item, 'En attente');
  }
  let next = 0;
  const worker = async () => { while (next < queue.length) await transfer(queue[next++]); };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  busy = false;
  input.disabled = false;
  refreshSelection();
  const errors = items.filter((item) => item.state === 'Erreur').length;
  retry.classList.toggle('hidden', !errors);
  $('message').textContent = errors ? `${errors} fichier${errors > 1 ? 's' : ''} en erreur. Vous pouvez réessayer.` : 'Tous les fichiers ont été transférés et vérifiés.';
  updateProgress();
}

send.addEventListener('click', () => run());
retry.addEventListener('click', () => run(true));
window.addEventListener('beforeunload', (event) => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
fetch('/api/status').then((response) => response.json()).then((status) => {
  if (Number.isInteger(status.concurrency)) concurrency = status.concurrency;
}).catch(() => { $('message').textContent = 'Le serveur ne répond pas. Vérifiez la connexion Wi-Fi.'; });
