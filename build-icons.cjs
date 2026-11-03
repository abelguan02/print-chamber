// Render the unified icon: extension PNGs from icons/*.svg, then the helper's AppIcon.icns via iconutil.
const {chromium} = require('playwright');
const {execFileSync} = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const icons = path.join(__dirname, 'extension/icons');
const svg = name => fs.readFileSync(path.join(icons, name), 'utf8');
// Toolbar sizes use the simplified art; larger sizes keep the full printer.
const source = size => size <= 32 ? svg('icon-small.svg') : svg('icon.svg');
const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'print-chamber-')) + '/AppIcon.iconset';
const macSizes = [16, 32, 128, 256, 512];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  async function render(size, file) {
    await page.setViewportSize({width: size, height: size});
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source(size)}`);
    await page.screenshot({path: file, omitBackground: true});
  }
  for (const size of [16, 32, 48, 128]) await render(size, path.join(icons, `icon-${size}.png`));
  fs.mkdirSync(iconset);
  for (const size of macSizes) {
    await render(size, path.join(iconset, `icon_${size}x${size}.png`));
    await render(size * 2, path.join(iconset, `icon_${size}x${size}@2x.png`));
  }
  await browser.close();
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(__dirname, 'menu-helper/AppIcon.icns')]);
  fs.rmSync(path.dirname(iconset), {recursive: true});
  console.log('Icons written to extension/icons/ and menu-helper/AppIcon.icns');
})();
