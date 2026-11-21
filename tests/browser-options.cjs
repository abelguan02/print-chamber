// Use the browser version installed by this project's pinned Playwright.
// Override only when deliberately testing a separate Chrome installation.
const {chromium} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(path.join(__dirname, '..', 'output'), {recursive: true});
module.exports = {
  // Ordinary UI suites must not contact any locally registered Codex helper.
  mockAbsentCodex: worker => worker.evaluate(()=>{globalThis.codexRequest = async request=>{
    if(request.type!=='detect')throw Error('Unexpected Codex request');
    return {found:false};
  };}),
  executablePath: process.env.PRINT_CHAMBER_CHROMIUM || chromium.executablePath(),
  fixture: path.join(__dirname, 'fixtures', 'artwork.png'),
};
