import { writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// iCloud "Optimize Mac Storage" can evict a file, leaving only a
// `.name.icloud` placeholder. Treating that as "missing" would recreate an
// empty file and overwrite real data on every device, so download instead.
export function ensureDownloaded(path, { timeoutMs = 30000 } = {}) {
  if (existsSync(path)) return true;
  const placeholder = join(dirname(path), `.${basename(path)}.icloud`);
  if (!existsSync(placeholder)) return false;
  try { execFileSync('brctl', ['download', path], { stdio: 'ignore' }); } catch {}
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(path)) return true;
    sleepSync(200);
  }
  throw new Error(`iCloud dosyası indirilemedi: ${path} — internet/iCloud bağlantısını kontrol et`);
}

export function writeAtomic(path, content) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function withLock(lockPath, fn, { retries = 60, delayMs = 25, staleMs = 5000 } = {}) {
  for (let i = 0; i < retries; i++) {
    let fd = null;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          try { unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {}
      sleepSync(delayMs);
      continue;
    }
    try {
      return fn();
    } finally {
      try { closeSync(fd); } catch {}
      try { unlinkSync(lockPath); } catch {}
    }
  }
  throw new Error(`lock zaman aşımı: ${lockPath}`);
}
