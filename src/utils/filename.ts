import { extname } from 'node:path';

export function safeFilename(input: string): string {
  const leaf = input.split(/[\\/]/).pop() || '';
  const cleaned = leaf.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  const name = cleaned === '.' || cleaned === '..' || !cleaned ? 'fichier' : cleaned;
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
  return (reserved.test(name) ? `_${name}` : name).slice(0, 240);
}

export function collisionName(name: string, index: number): string {
  if (index === 0) return name;
  const extension = extname(name);
  const base = name.slice(0, name.length - extension.length);
  return `${base.slice(0, 220)}_${index}${extension}`;
}
