import { writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';

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
      const end = Date.now() + delayMs;
      while (Date.now() < end) { /* busy wait */ }
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
