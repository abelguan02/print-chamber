'use strict';
// Use the same installation and version checks as the extension's detect request.
const {operate} = require('./operation.cjs');
operate({type:'detect'}, new AbortController().signal)
  .then(result => process.stdout.write(JSON.stringify(result)))
  .catch(() => { process.exitCode = 1; });
