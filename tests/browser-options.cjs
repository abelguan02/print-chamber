// Use the browser version installed by this project's pinned Playwright.
// Override only when deliberately testing a separate Chrome installation.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.join(__dirname, '..', 'output'), {recursive: true});
module.exports = {
  executablePath: process.env.PRINT_CHAMBER_CHROMIUM || chromium.executablePath(),
  fixture: path.join(__dirname, 'fixtures', 'artwork.png'),
};
