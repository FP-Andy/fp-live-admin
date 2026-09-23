// PNGs are already compressed. ZIP STORE avoids extra CPU and external services.
export async function pngArchive(files: { name: string; blob: Blob }[]): Promise<Blob> {
  if (!files.length || files.length > 65535) throw new Error('내보낼 파일 수를 확인해 주세요.');
  const parts: Uint8Array[] = [], directory: Uint8Array[] = [];
  const names = new Set<string>();
  let offset = 0;
  for (const file of files) {
    if (names.has(file.name)) throw new Error('중복된 파일명입니다.');
    names.add(file.name);
    const name = new TextEncoder().encode(file.name), data = new Uint8Array(await file.blob.arrayBuffer());
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + name.length), h = new DataView(header.buffer);
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(12, 33, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); header.set(name, 30);
    const entry = new Uint8Array(46 + name.length), d = new DataView(entry.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x0800, true); d.setUint16(14, 33, true);
    d.setUint32(16, crc, true); d.setUint32(20, data.length, true); d.setUint32(24, data.length, true); d.setUint16(28, name.length, true); d.setUint32(42, offset, true); entry.set(name, 46);
    parts.push(header, data); directory.push(entry); offset += header.length + data.length;
    if (offset > 0xffffffff) throw new Error('ZIP 용량이 너무 큽니다.');
  }
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, directory.reduce((sum, item) => sum + item.length, 0), true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: 'application/zip' });
}
