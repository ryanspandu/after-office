// A minimal ZIP writer (stored, no compression) for downloading several files at once. No dependency: local headers,
// a central directory and CRC-32 (Bun.hash.crc32). Names are UTF-8 (flag bit 11). Sizes up to 4 GB (no ZIP64).

export interface ZipEntry {
  name: string
  data: Uint8Array
  modified: Date
}

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

function unicodePath(name: Uint8Array) {
  const f = new DataView(new ArrayBuffer(9 + name.length))
  f.setUint16(0, 0x7075, true)
  f.setUint16(2, 5 + name.length, true)
  f.setUint8(4, 1) // version
  f.setUint32(5, Bun.hash.crc32(name) >>> 0, true) // of the name in the header
  const out = new Uint8Array(f.buffer)
  out.set(name, 9)
  return out
}

export function zip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    // non-ASCII names also go in an Info-ZIP Unicode Path field (0x7075), for unzip tools that ignore the UTF-8 flag
    const extra = /^[\x20-\x7e]*$/.test(e.name) ? new Uint8Array(0) : unicodePath(name)
    const crc = Bun.hash.crc32(e.data) >>> 0
    const { time, date } = dosTime(e.modified)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true) // version needed
    local.setUint16(6, 0x0800, true) // UTF-8 names
    local.setUint16(8, 0, true) // stored
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, e.data.length, true)
    local.setUint32(22, e.data.length, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, extra.length, true)
    parts.push(new Uint8Array(local.buffer), name, extra, e.data)

    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true) // made by
    cd.setUint16(6, 20, true)
    cd.setUint16(8, 0x0800, true)
    cd.setUint16(10, 0, true)
    cd.setUint16(12, time, true)
    cd.setUint16(14, date, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, e.data.length, true)
    cd.setUint32(24, e.data.length, true)
    cd.setUint16(28, name.length, true)
    cd.setUint16(30, extra.length, true)
    cd.setUint32(38, 0o100644 << 16, true) // a plain file (unix mode)
    cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), name, extra)
    offset += 30 + name.length + extra.length + e.data.length
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, cdSize, true)
  end.setUint32(16, offset, true)
  const all = [...parts, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.length
  }
  return out
}
