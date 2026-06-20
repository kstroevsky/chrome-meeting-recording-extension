/**
 * @file scripts/print-redirect-uri.mjs
 *
 * Prints the launchWebAuthFlow OAuth redirect URI for the Chromium family, so it
 * can be registered in the Google OAuth client without guessing. The extension
 * id is derived from the manifest `key` using Chrome's documented algorithm
 * (base64-decode the key -> SHA-256 -> first 16 bytes -> each nibble mapped
 * 0..15 -> 'a'..'p'). Because every Chromium target keeps the same `key`
 * (scripts/lib/manifestTargets.cjs), this one URI matches all of them for
 * unpacked/dev loads.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

const manifestPath = new URL('../static/manifest.json', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (!manifest.key) {
  console.error('static/manifest.json has no "key" — cannot derive a stable extension id.');
  process.exit(1);
}

const der = Buffer.from(manifest.key, 'base64');
const hash = crypto.createHash('sha256').update(der).digest();

let extensionId = '';
for (let i = 0; i < 16; i += 1) {
  const byte = hash[i];
  extensionId += String.fromCharCode(97 + (byte >> 4));
  extensionId += String.fromCharCode(97 + (byte & 0x0f));
}

const redirectUri = `https://${extensionId}.chromiumapp.org/`;

console.log('Extension id (from manifest key): ' + extensionId);
console.log('Authorized redirect URI to register in the Google OAuth client:');
console.log('  ' + redirectUri);
console.log('\nNote: this is the stable id for unpacked/dev loads across all Chromium targets.');
console.log('Each store-published build (Chrome Web Store, Edge Add-ons) gets its own');
console.log('store-assigned id; add that build\'s https://<id>.chromiumapp.org/ to the same client.');
