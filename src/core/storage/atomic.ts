import * as fs from 'fs';
import * as path from 'path';
import { toDeterministicJson } from './json';

let tempCounter = 0;

/**
 * Atomically writes data to a file as deterministic JSON using temporary file replacement.
 * Follows the contract:
 * 1. Write to hidden temporary file in same directory
 * 2. Flush and fsync kernel buffers
 * 3. Close file descriptor
 * 4. Atomic rename (POSIX rename / os.replace equivalent)
 */
export function atomicWriteJson(filePath: string, data: unknown, indent: number = 2): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  tempCounter += 1;
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${tempCounter}.tmp`
  );

  const jsonContent = toDeterministicJson(data, indent);
  let fd: number | null = null;

  try {
    fd = fs.openSync(tempPath, 'w', 0o644);
    fs.writeSync(fd, jsonContent, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error in catch block
      }
    }
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore unlink error
      }
    }
    throw error;
  }
}

/**
 * Reads and parses JSON file from disk.
 */
export function readJson<T = unknown>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}
