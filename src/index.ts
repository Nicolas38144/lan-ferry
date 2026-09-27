import { mkdir } from 'node:fs/promises';
import QRCode from 'qrcode';
import { loadConfig } from './services/config.js';
import { createServer } from './server/server.js';
import { networkAddresses } from './server/network.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.destination, { recursive: true });
  const { server, auth } = await createServer(config);
  await server.listen({ host: config.host, port: config.port });
  const addresses = networkAddresses().filter((entry) => config.host === '0.0.0.0' || config.host === entry.address);
  const mainAddress = addresses[0]?.address || '127.0.0.1';
  const url = `http://${mainAddress}:${config.port}/?token=${auth.token}`;
  console.log('\n----------------------------------\nFile Transfer\nServeur démarré.');
  console.log(`Adresse : ${url}`);
  for (const entry of addresses.slice(1)) console.log(`Autre adresse (${entry.interface}) : http://${entry.address}:${config.port}/?token=${auth.token}`);
  console.log(`Dossier : ${config.destination}`);
  console.log(`Page PC : http://127.0.0.1:${config.port}/admin`);
  console.log(`Authentification : ${config.auth ? 'activée' : 'désactivée'}`);
  console.log('----------------------------------\n');
  if (config.auth) console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  console.log('Gardez le terminal ouvert pendant les transferts. Ctrl+C pour arrêter.');
  const close = async () => { console.log('\nArrêt du serveur…'); await server.close(); process.exit(0); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

main().catch((error: unknown) => { console.error('Démarrage impossible :', error); process.exitCode = 1; });
