/*
 * make-assets.mjs — renders the source images @capacitor/assets consumes (assets/icon.png 1024²,
 * assets/splash.png + splash-dark.png 2732²) from the AllDataLogs icon SVG in the site repo, then
 * generates every Android / iOS icon and splash size:
 *
 *   node scripts/make-assets.mjs && npx capacitor-assets generate --android --ios
 *
 * The app is "BigData by AllDataLogs", so the AllDataLogs mark is the app icon. Splash = the mark
 * centred on the app's dark background (#0a0a0d), the same colour the shell paints first.
 */
import sharp from 'sharp';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SITE = process.env.BIGDATA_SITE_REPO || 'C:/websites/Alldatalogs';
const SVG = join(SITE, 'apps/web/public/icon.svg');
if (!existsSync(SVG)) { console.error('icon.svg not found at ' + SVG); process.exit(1); }
const BG = '#0a0a0d';
mkdirSync('assets', { recursive: true });

const svg = readFileSync(SVG);
await sharp(svg, { density: 600 }).resize(1024, 1024, { fit: 'contain', background: BG }).flatten({ background: BG }).png().toFile('assets/icon.png');
// A foreground with generous padding for Android adaptive icons (the system masks the outer ~18%).
await sharp(svg, { density: 600 }).resize(680, 680, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extend({ top: 172, bottom: 172, left: 172, right: 172, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile('assets/icon-foreground.png');
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: BG } }).png().toFile('assets/icon-background.png');
const mark = await sharp(svg, { density: 600 }).resize(560, 560, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
for (const name of ['splash.png', 'splash-dark.png']) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: BG } }).composite([{ input: mark, gravity: 'centre' }]).png().toFile('assets/' + name);
}
console.log('Wrote assets/icon.png, icon-foreground.png, icon-background.png, splash.png, splash-dark.png');
