// Export the preview's vector adaptations; the original raster concepts stay intact.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(here, 'polish-preview.js'), 'utf8'), sandbox);
const api = sandbox.window.Polish;
const target = path.resolve(here, '../../brand/icon-concepts/vector');
fs.mkdirSync(target, { recursive: true });
const palettes = {
  mint: ['#53e0c7', '#5a91ff'],
  sunset: ['#ff944d', '#e550a7'],
  violet: ['#a288ff', '#52d6ff'],
};
for (const [name, colors] of Object.entries(palettes)) {
  [api.state.one, api.state.two] = colors;
  for (const type of ['pulse', 'orbit']) {
    const svg = api.mark(type, 2048);
    fs.writeFileSync(path.join(target, `${type}-${name}.svg`), svg + '\n');
  }
}
console.log('Exported six 2048px SVG adaptations of Pulse / Orbit.');
