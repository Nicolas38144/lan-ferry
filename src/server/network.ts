import { networkInterfaces } from 'node:os';

export interface NetworkAddress { address: string; interface: string; score: number }

export function networkAddresses(): NetworkAddress[] {
  const results: NetworkAddress[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal || entry.address.startsWith('169.254.')) continue;
      const virtual = /virtual|vmware|vbox|docker|wsl|hyper-v|veth|bridge|br-|tailscale|zerotier|loopback/i.test(name);
      const privateIp = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address);
      const wifi = /wi-?fi|wlan|wireless|wl\d|airport/i.test(name);
      results.push({ address: entry.address, interface: name, score: (privateIp ? 10 : 0) + (wifi ? 5 : 0) - (virtual ? 20 : 0) });
    }
  }
  const physical = results.filter((entry) => entry.score >= 0);
  return (physical.length ? physical : results).sort((a, b) => b.score - a.score || a.interface.localeCompare(b.interface));
}
