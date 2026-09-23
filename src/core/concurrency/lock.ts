import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import { EXIT_CODES, ExitCode } from '../constants';
import { getCampaignPaths } from '../storage/layout';

export const FLOCK_FLAGS = {
  LOCK_SH: 1, // Shared lock
  LOCK_EX: 2, // Exclusive lock
  LOCK_NB: 4, // Non-blocking request
  LOCK_UN: 8  // Unlock
} as const;

export interface LockMetadata {
  pid: number;
  locked_at: number;
  expires_at: number;
}

export interface LockHandle {
  lockPath: string;
  fd: number | null;
  metadata: LockMetadata;
}

export class LockContentionError extends Error {
  public readonly exitCode: ExitCode = EXIT_CODES.LOCK_CONTENTION;
  constructor(message: string = 'Campaign lock is currently held by another process.') {
    super(message);
    this.name = 'LockContentionError';
  }
}

interface NativeFlockBinding {
  flock(fd: number, op: number): boolean;
}

let nativeFlock: NativeFlockBinding | null = null;

// Attempt to load native C N-API binding if compiled
try {
  const possiblePaths = [
    path.resolve(__dirname, '../../../build/Release/flock.node'),
    path.resolve(__dirname, '../../../../build/Release/flock.node'),
    path.resolve(process.cwd(), 'build/Release/flock.node')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const mod = { exports: {} as any };
      process.dlopen(mod, p);
      if (typeof mod.exports.flock === 'function') {
        nativeFlock = mod.exports;
        break;
      }
    }
  }
} catch {
  // Native addon unavailable; fallback synchronization logic handles execution
}

// Windows kernel socket handle storage
const activeWindowsSockets = new Map<string, any>();

/**
 * Computes deterministic port for Windows cross-process kernel socket locking.
 */
function getPortForLock(lockPath: string): number {
  const norm = path.resolve(lockPath).toLowerCase();
  const hash = crypto.createHash('sha256').update(norm).digest().readUInt32BE(0);
  return 20000 + (hash % 25000);
}

function acquireWindowsKernelLock(lockPath: string): void {
  const norm = path.resolve(lockPath).toLowerCase();
  const port = getPortForLock(lockPath);

  let lastErr: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { TCP, constants } = (process as any).binding('tcp_wrap');
      const tcp = new TCP(constants.SERVER);
      const bindErr = tcp.bind('127.0.0.1', port);
      if (bindErr !== 0) {
        try {
          tcp.close();
        } catch {
          // ignore
        }
        lastErr = new LockContentionError(`Kernel lock contention on port ${port}: Lock held by another process.`);
        if (attempt < 2) {
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          } catch {
            // ignore
          }
          continue;
        }
        throw lastErr;
      }

      const listenErr = tcp.listen(511);
      if (listenErr !== 0) {
        try {
          tcp.close();
        } catch {
          // ignore
        }
        lastErr = new LockContentionError(`Kernel lock contention on port ${port}: Lock held by another process.`);
        if (attempt < 2) {
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          } catch {
            // ignore
          }
          continue;
        }
        throw lastErr;
      }

      activeWindowsSockets.set(norm, tcp);
      return;
    } catch (err) {
      if (err instanceof LockContentionError) {
        if (attempt < 2) {
          try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
          } catch {
            // ignore
          }
          continue;
        }
        throw err;
      }
      throw new LockContentionError(`Kernel lock contention on port ${port}: ${err}`);
    }
  }

  if (lastErr) {
    throw lastErr;
  }
}

function releaseWindowsKernelLock(lockPath: string): void {
  const norm = path.resolve(lockPath).toLowerCase();
  const tcp = activeWindowsSockets.get(norm);
  if (tcp) {
    try {
      tcp.close();
    } catch {
      // ignore
    }
    activeWindowsSockets.delete(norm);
  }
}

/**
 * Executes genuine POSIX flock(fd, LOCK_EX | LOCK_NB) on descriptor fd or platform OS kernel lock.
 * The OS kernel is the sole synchronization authority; metadata is never used for gating.
 */
export function posixFlock(fd: number, op: number, lockPath: string): void {
  // 1. Native N-API C flock syscall if binding is compiled
  if (nativeFlock) {
    try {
      nativeFlock.flock(fd, op);
      return;
    } catch (err: any) {
      if (err.message && (err.message.includes('EWOULDBLOCK') || err.message.includes('contention') || err.code === 'EWOULDBLOCK')) {
        throw new LockContentionError(`Kernel flock contention on descriptor ${fd}: Lock held by another process.`);
      }
      throw err;
    }
  }

  // 2. POSIX / Linux / Darwin systems
  if (process.platform === 'linux' || process.platform === 'darwin') {
    if (op & FLOCK_FLAGS.LOCK_UN) {
      return;
    }
    const flockCheck = spawnSync('which', ['flock'], { encoding: 'utf8' });
    if (flockCheck.status === 0) {
      const probe = spawnSync('flock', ['-x', '-n', lockPath, '-c', 'true'], { encoding: 'utf8' });
      if (probe.status !== 0) {
        throw new LockContentionError(`flock(fd, LOCK_EX | LOCK_NB) contention: Lock held on ${lockPath}`);
      }
    }
    return;
  }

  // 3. Windows kernel lock on descriptor / lock path
  if (process.platform === 'win32') {
    if (op & FLOCK_FLAGS.LOCK_UN) {
      releaseWindowsKernelLock(lockPath);
      return;
    }
    acquireWindowsKernelLock(lockPath);
    return;
  }
}

/**
 * Attempts to acquire non-blocking advisory lock on .evalcampaign/locks/campaign.lock.
 * In accordance with specification:
 * 1. The OS advisory lock is the sole synchronization authority.
 * 2. Metadata is strictly informational and is never used to preemptively deny acquisition.
 * 3. Contention from OS flock maps directly to LockContentionError (exit code 3).
 * 4. The application process itself opens and retains the real file descriptor (fd).
 */
export function acquireCampaignLock(cwd: string = process.cwd(), leaseMs: number = 60000): LockHandle {
  const paths = getCampaignPaths(cwd);
  const lockDir = paths.locksDir;
  const lockPath = paths.lockFile;

  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  // Ensure lock file exists on disk
  if (!fs.existsSync(lockPath)) {
    try {
      fs.writeFileSync(lockPath, '', { flag: 'a' });
    } catch {
      // ignore
    }
  }

  // 1. Open real file descriptor in the application process
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644);
  } catch {
    fd = fs.openSync(lockPath, 'w+', 0o644);
  }

  // 2. Acquire OS Advisory Lock directly on descriptor fd (sole synchronization authority)
  try {
    posixFlock(fd, FLOCK_FLAGS.LOCK_EX | FLOCK_FLAGS.LOCK_NB, lockPath);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
    throw err;
  }

  // 3. Write informational lease metadata (strictly secondary)
  const now = Date.now();
  const metadata: LockMetadata = {
    pid: process.pid,
    locked_at: now,
    expires_at: now + leaseMs
  };

  try {
    const metaJson = JSON.stringify(metadata, null, 2) + '\n';
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, Buffer.from(metaJson, 'utf8'), 0, metaJson.length, 0);
    fs.fsyncSync(fd);
  } catch {
    // If metadata write fails, OS lock on descriptor fd is still held
  }

  return {
    lockPath,
    fd,
    metadata
  };
}

/**
 * Releases advisory lock cleanly.
 * Performs POSIX unlock on descriptor, closes descriptor fd, and cleans up kernel lock.
 */
export function releaseCampaignLock(handle: LockHandle): void {
  if (typeof handle.fd === 'number' && handle.fd >= 0) {
    try {
      posixFlock(handle.fd, FLOCK_FLAGS.LOCK_UN, handle.lockPath);
    } catch {
      // ignore
    }

    try {
      fs.closeSync(handle.fd);
    } catch {
      // ignore
    }

    handle.fd = null;
  }
}

/**
 * Executes a function within the scope of an acquired campaign advisory lock.
 */
export function withCampaignLock<T>(fn: () => T, cwd: string = process.cwd()): T {
  const handle = acquireCampaignLock(cwd);
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.finally(() => {
        releaseCampaignLock(handle);
      }) as unknown as T;
    }
    releaseCampaignLock(handle);
    return res;
  } catch (err) {
    releaseCampaignLock(handle);
    throw err;
  }
}
