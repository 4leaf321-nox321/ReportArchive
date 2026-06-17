/**
 * 의존성 없는 최소 ZIP 작성기 (STORE 방식 — 무압축).
 *
 * 작은 UTF-8 텍스트 파일 몇 개(예: Claude 스킬 폴더 = SKILL.md + 레퍼런스)를
 * 묶어 다운로드용 Blob 으로 만드는 용도. 범용 ZIP 라이브러리가 아니다 —
 * 압축·zip64·디렉터리 엔트리는 없다. STORE 라 파일이 그대로 들어가지만,
 * 텍스트 수십 KB 수준이라 크기 문제는 없고 Claude Desktop 업로드도 정상 동작한다.
 *
 * makeZip([{ name: 'folder/file.md', data: '...' }]) → Blob('application/zip')
 *   - name 의 `/` 는 zip 내부 경로(폴더)로 그대로 쓰인다.
 *   - data 는 문자열(UTF-8 로 인코딩).
 */

// CRC-32 (IEEE 802.3) 룩업 테이블 — ZIP 로컬/센트럴 헤더에 들어갈 체크섬용.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff])
const u32 = (n) =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])

function concat(parts) {
  let len = 0
  for (const p of parts) len += p.length
  const out = new Uint8Array(len)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** files: Array<{ name: string, data: string }> → Blob */
export function makeZip(files) {
  const enc = new TextEncoder()
  const chunks = [] // 파일 데이터 섹션 (로컬헤더 + 데이터 …)
  const central = [] // 센트럴 디렉터리 레코드
  let offset = 0

  // DOS 날짜/시간은 고정값(1980-01-01) — 결정적이고 Date 의존이 없다.
  const dosTime = u16(0)
  const dosDate = u16(0x21)

  for (const f of files) {
    const nameBytes = enc.encode(f.name)
    const dataBytes = enc.encode(f.data ?? '')
    const crc = crc32(dataBytes)
    const size = dataBytes.length

    const lfh = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0x0800), // general purpose flag: UTF-8 (bit 11)
      u16(0), // method: 0 = store
      dosTime,
      dosDate,
      u32(crc),
      u32(size), // compressed size (= size, store)
      u32(size), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
    ])
    chunks.push(lfh, dataBytes)

    central.push(
      concat([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0x0800), // flags: UTF-8
        u16(0), // method: store
        dosTime,
        dosDate,
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0), // extra len
        u16(0), // comment len
        u16(0), // disk number start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // relative offset of local header
        nameBytes,
      ]),
    )

    offset += lfh.length + dataBytes.length
  }

  const centralStart = offset
  let centralSize = 0
  for (const c of central) {
    chunks.push(c)
    centralSize += c.length
  }

  chunks.push(
    concat([
      u32(0x06054b50), // end of central directory signature
      u16(0), // disk number
      u16(0), // disk with central dir
      u16(central.length), // entries on this disk
      u16(central.length), // total entries
      u32(centralSize),
      u32(centralStart),
      u16(0), // comment len
    ]),
  )

  return new Blob(chunks, { type: 'application/zip' })
}
