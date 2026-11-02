import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Writes a zip archive (deflate, or stored when that is no smaller) of the
 * given files, `/`-separated paths in the order given. Every entry gets the
 * same timestamp, so the same files make the same archive.
 */
export function zipFiles(files: Iterable<[string, Buffer]>, date = new Date()): Buffer {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day =
    (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  for (const [path, data] of files) {
    const name = Buffer.from(path, 'utf8');
    const deflated = deflateRawSync(data);
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    if (offset > 0xffffffff || data.length > 0xffffffff || count >= 0xffff)
      throw new Error('the package is too large for a zip file; write a folder instead');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x031e, 4); // made by: Unix, 3.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    entry.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
    count++;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
