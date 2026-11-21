'use strict';

const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

class AppServerClient {
  #child;
  #pending = new Map();
  #nextId = 1;
  #failure;
  #resolveDisconnect;
  #closed;
  #shutdown;
  #channelTimer;

  constructor({ cwd, env, args = [], onNotification = () => {} }) {
    if (!env?.PATH || !cwd) throw new Error('An explicit PATH and working directory are required');

    this.disconnected = new Promise(resolve => { this.#resolveDisconnect = resolve; });
    this.#child = spawn('codex', ['app-server', ...args], {
      cwd, env, shell: false, stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.#closed = new Promise(resolve => this.#child.once('close', (code, signal) => {
      this.#reportExit(code, signal);
      resolve();
    }));
    this.#child.on('error', error => {
      const code = error.code === 'ENOENT' ? ' (executable or cwd missing)' : '';
      this.#disconnect(new Error('Could not run codex app-server' + code));
    });
    this.#child.on('exit', () => this.#waitForClose());
    this.#child.stdin.on('error', () => this.#waitForClose());
    const lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    lines.on('error', () => this.#waitForClose());
    lines.on('close', () => this.#waitForClose());
    lines.on('line', line => {
      if (this.#failure) return;
      try {
        const msg = JSON.parse(line);
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error();
        if (typeof msg.method === 'string') {
          if (Object.hasOwn(msg, 'id')) {
            // Nothing in this experiment needs a client-side tool or approval.
            this.#send({ id: msg.id, error: { code: -32601, message: 'Client method unavailable' } });
          } else {
            onNotification(msg.method, msg.params);
          }
        } else {
          if (!Object.hasOwn(msg, 'id') || (!msg.error && !Object.hasOwn(msg, 'result'))) throw new Error();
          const pending = this.#pending.get(msg.id);
          if (!pending) return; // A response can arrive after a request timeout.
          this.#pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            // Server error messages/data can contain unrelated user or account details.
            const code = Number.isSafeInteger(msg.error.code) ? msg.error.code : 'unknown';
            const error = new Error(`${pending.method} failed (RPC ${code})`);
            error.rpcCode = code;
            pending.reject(error);
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch {
        this.#disconnect(new Error('Invalid app-server message or notification handler failure'));
      }
    });
  }

  get pid() { return this.#child.pid; }

  #reportExit(exitCode, signal) {
    const reason = signal ? 'signal ' + signal : 'exit code ' + exitCode;
    this.#disconnect(Object.assign(new Error('app-server exited (' + reason + ')'), {
      code: 'APP_SERVER_EXITED', exitCode, signal,
    }));
  }

  #waitForClose() {
    if (this.#failure || this.#channelTimer) return;
    // Drain final protocol messages and allow close to deliver the exit status.
    // A process can also close stdout and continue running indefinitely.
    this.#channelTimer = setTimeout(() => {
      const { exitCode, signalCode } = this.#child;
      if (exitCode !== null || signalCode !== null) {
        this.#reportExit(exitCode, signalCode);
      } else {
        this.#disconnect(Object.assign(new Error('app-server closed its RPC channel while still running'), {
          code: 'APP_SERVER_CHANNEL_CLOSED',
        }));
      }
    }, 350);
  }

  #disconnect(error) {
    if (this.#failure) return;
    clearTimeout(this.#channelTimer);
    this.#failure = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#resolveDisconnect(error);
  }

  #send(message) {
    if (this.#failure) throw this.#failure;
    this.#child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      this.#send({ id: this.#nextId, method, params });
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
    });
  }

  notify(method, params) {
    this.#send({ method, params });
  }

  close() {
    if (this.#shutdown) return this.#shutdown;
    this.#disconnect(new Error('app-server client closed'));
    this.#child.stdin.end();
    // The close event confirms the owned PID has exited and its streams have closed.
    const term = setTimeout(() => this.#child.kill('SIGTERM'), 750);
    const kill = setTimeout(() => this.#child.kill('SIGKILL'), 1500);
    this.#shutdown = this.#closed.finally(() => {
      clearTimeout(term);
      clearTimeout(kill);
    });
    return this.#shutdown;
  }
}

module.exports = { AppServerClient };
