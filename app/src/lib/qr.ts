/**
 * Minimal QR encoder: byte mode, error-correction level L, versions 1-9.
 *
 * Written by hand because the app has no QR dependency and the beneficiary page must show an identity
 * commitment that an enrolment officer can scan. Scope is deliberately small — versions 1-9 at level L all
 * have uniformly sized Reed-Solomon blocks and an 8-bit character-count indicator, which removes the two
 * fiddliest branches of the specification. 232 bytes is far more than a decimal commitment needs.
 *
 * This module is only ever reached through a dynamic import, so it stays out of the initial bundle.
 */

const EC_LEVEL_L = 0b01

interface VersionSpec {
  totalCodewords: number
  dataCodewords: number
  blocks: number
  alignment: number[]
}

const VERSIONS: Record<number, VersionSpec> = {
  1: { totalCodewords: 26, dataCodewords: 19, blocks: 1, alignment: [] },
  2: { totalCodewords: 44, dataCodewords: 34, blocks: 1, alignment: [6, 18] },
  3: { totalCodewords: 70, dataCodewords: 55, blocks: 1, alignment: [6, 22] },
  4: { totalCodewords: 100, dataCodewords: 80, blocks: 1, alignment: [6, 26] },
  5: { totalCodewords: 134, dataCodewords: 108, blocks: 1, alignment: [6, 30] },
  6: { totalCodewords: 172, dataCodewords: 136, blocks: 2, alignment: [6, 34] },
  7: { totalCodewords: 196, dataCodewords: 156, blocks: 2, alignment: [6, 22, 38] },
  8: { totalCodewords: 242, dataCodewords: 194, blocks: 2, alignment: [6, 24, 42] },
  9: { totalCodewords: 292, dataCodewords: 232, blocks: 2, alignment: [6, 26, 46] },
}

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number
}

const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : (EXP[((LOG[a] as number) + (LOG[b] as number)) % 255] as number)

/** Coefficients in descending degree order, leading 1 first. */
const generatorPolynomial = (degree: number): number[] => {
  let poly = [1]
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] as number) ^ (poly[j] as number)
      next[j + 1] = (next[j + 1] as number) ^ mul(poly[j] as number, EXP[i] as number)
    }
    poly = next
  }
  return poly
}

const reedSolomon = (data: number[], ecCount: number): number[] => {
  const generator = generatorPolynomial(ecCount)
  const remainder = new Array<number>(ecCount).fill(0)
  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number)
    remainder.shift()
    remainder.push(0)
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) {
        remainder[i] = (remainder[i] as number) ^ mul(generator[i + 1] as number, factor)
      }
    }
  }
  return remainder
}

const bch = (value: number, poly: number, bits: number): number => {
  let result = value
  const polyBits = 32 - Math.clz32(poly)
  while (32 - Math.clz32(result) >= polyBits) {
    result ^= poly << (32 - Math.clz32(result) - polyBits)
  }
  return result & ((1 << bits) - 1)
}

const formatBits = (mask: number): number => {
  const value = (EC_LEVEL_L << 3) | mask
  return ((value << 10) | bch(value << 10, 0x537, 10)) ^ 0x5412
}

const versionBits = (version: number): number => (version << 12) | bch(version << 12, 0x1f25, 12)

const pickVersion = (byteLength: number): number => {
  for (let version = 1; version <= 9; version++) {
    // 4 mode bits + 8 count bits + payload must fit the data capacity.
    if (byteLength + 2 <= (VERSIONS[version] as VersionSpec).dataCodewords) return version
  }
  throw new Error('payload too large for this encoder (max 230 bytes)')
}

const buildCodewords = (bytes: number[], version: number): number[] => {
  const spec = VERSIONS[version] as VersionSpec
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }

  push(0b0100, 4)
  push(bytes.length, 8)
  for (const byte of bytes) push(byte, 8)

  const capacityBits = spec.dataCodewords * 8
  push(0, Math.min(4, capacityBits - bits.length))
  while (bits.length % 8 !== 0) bits.push(0)

  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] as number)
    data.push(byte)
  }
  const padding = [0xec, 0x11]
  for (let i = 0; data.length < spec.dataCodewords; i++) data.push(padding[i % 2] as number)

  const perBlock = spec.dataCodewords / spec.blocks
  const ecPerBlock = (spec.totalCodewords - spec.dataCodewords) / spec.blocks
  const dataBlocks: number[][] = []
  const ecBlocks: number[][] = []
  for (let b = 0; b < spec.blocks; b++) {
    const block = data.slice(b * perBlock, (b + 1) * perBlock)
    dataBlocks.push(block)
    ecBlocks.push(reedSolomon(block, ecPerBlock))
  }

  const interleaved: number[] = []
  for (let i = 0; i < perBlock; i++) {
    for (const block of dataBlocks) interleaved.push(block[i] as number)
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) interleaved.push(block[i] as number)
  }
  return interleaved
}

type Grid = Int8Array[]

const createGrid = (size: number): Grid => Array.from({ length: size }, () => new Int8Array(size).fill(-1))

const placeFunctionPatterns = (grid: Grid, version: number): void => {
  const size = grid.length
  const set = (row: number, col: number, value: number) => {
    ;(grid[row] as Int8Array)[col] = value
  }

  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r
        const cc = col + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const dark =
          inRing && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
        set(rr, cc, dark ? 1 : 0)
      }
    }
  }

  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  for (let i = 8; i < size - 8; i++) {
    const value = i % 2 === 0 ? 1 : 0
    set(6, i, value)
    set(i, 6, value)
  }

  const centers = (VERSIONS[version] as VersionSpec).alignment
  for (const row of centers) {
    for (const col of centers) {
      const overlapsFinder =
        (row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)
      if (overlapsFinder) continue
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1
          set(row + r, col + c, dark ? 1 : 0)
        }
      }
    }
  }

  // Dark module and the reserved format-information strips.
  set(size - 8, 8, 1)
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      set(8, i, 0)
      set(i, 8, 0)
    }
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, 0)
    if (size - 1 - i !== size - 8) set(size - 1 - i, 8, 0)
  }

  if (version >= 7) {
    const bits = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1
      set(Math.floor(i / 3), size - 11 + (i % 3), bit)
      set(size - 11 + (i % 3), Math.floor(i / 3), bit)
    }
  }
}

const placeData = (grid: Grid, codewords: number[]): void => {
  const size = grid.length
  let bitIndex = 0
  const nextBit = (): number => {
    const byte = codewords[bitIndex >> 3]
    const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1
    bitIndex++
    return bit
  }

  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    const columnRight = right <= 6 ? right - 1 : right
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step
      for (const col of [columnRight, columnRight - 1]) {
        if ((grid[row] as Int8Array)[col] === -1) {
          ;(grid[row] as Int8Array)[col] = nextBit()
        }
      }
    }
    upward = !upward
  }
}

const maskBit = (mask: number, row: number, col: number): boolean => {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

const penalty = (matrix: Uint8Array[]): number => {
  const size = matrix.length
  let score = 0

  const runScore = (run: number) => (run >= 5 ? run - 2 : 0)

  for (let i = 0; i < size; i++) {
    for (const horizontal of [true, false]) {
      let run = 1
      for (let j = 1; j < size; j++) {
        const current = horizontal ? (matrix[i] as Uint8Array)[j] : (matrix[j] as Uint8Array)[i]
        const previous = horizontal ? (matrix[i] as Uint8Array)[j - 1] : (matrix[j - 1] as Uint8Array)[i]
        if (current === previous) {
          run++
        } else {
          score += runScore(run)
          run = 1
        }
      }
      score += runScore(run)
    }
  }

  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const a = (matrix[row] as Uint8Array)[col]
      if (
        a === (matrix[row] as Uint8Array)[col + 1] &&
        a === (matrix[row + 1] as Uint8Array)[col] &&
        a === (matrix[row + 1] as Uint8Array)[col + 1]
      ) {
        score += 3
      }
    }
  }

  const pattern = [1, 0, 1, 1, 1, 0, 1]
  const matches = (values: number[], start: number): boolean => {
    for (let i = 0; i < 7; i++) if (values[start + i] !== pattern[i]) return false
    const before = values.slice(Math.max(0, start - 4), start)
    const after = values.slice(start + 7, start + 11)
    const quietBefore = before.length === 4 && before.every((v) => v === 0)
    const quietAfter = after.length === 4 && after.every((v) => v === 0)
    return (start === 0 || quietBefore) && (start + 7 === values.length || quietAfter)
  }

  for (let i = 0; i < size; i++) {
    const row = Array.from(matrix[i] as Uint8Array)
    const col = Array.from({ length: size }, (_, j) => (matrix[j] as Uint8Array)[i] as number)
    for (const values of [row, col]) {
      for (let start = 0; start + 7 <= size; start++) if (matches(values, start)) score += 40
    }
  }

  let dark = 0
  for (const row of matrix) for (const cell of row) dark += cell
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10

  return score
}

/**
 * Encodes `text` and returns the module matrix (1 = dark). The caller decides how to draw it.
 * `forceMask` exists so the encoder can be diffed against a reference implementation mask by mask; production
 * callers leave it out and get the lowest-penalty mask.
 */
export const encodeQr = (text: string, forceMask?: number): Uint8Array[] => {
  const bytes = Array.from(new TextEncoder().encode(text))
  const version = pickVersion(bytes.length)
  const size = 17 + version * 4
  const template = createGrid(size)
  placeFunctionPatterns(template, version)

  const reserved = template.map((row) => Int8Array.from(row))
  placeData(template, buildCodewords(bytes, version))

  let best: Uint8Array[] | null = null
  let bestScore = Number.POSITIVE_INFINITY
  const masks = forceMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask]
  for (const mask of masks) {
    const matrix = template.map((row, rowIndex) =>
      Uint8Array.from(row, (value, colIndex) => {
        const isFunction = (reserved[rowIndex] as Int8Array)[colIndex] !== -1
        const bit = value === -1 ? 0 : value
        return isFunction ? bit : bit ^ (maskBit(mask, rowIndex, colIndex) ? 1 : 0)
      }),
    )

    const bits = formatBits(mask)
    for (let i = 0; i < 15; i++) {
      const bit = (bits >> i) & 1
      if (i < 6) (matrix[i] as Uint8Array)[8] = bit
      else if (i === 6) (matrix[7] as Uint8Array)[8] = bit
      else if (i === 7) (matrix[8] as Uint8Array)[8] = bit
      else if (i === 8) (matrix[8] as Uint8Array)[7] = bit
      else (matrix[8] as Uint8Array)[14 - i] = bit

      if (i < 8) (matrix[8] as Uint8Array)[size - 1 - i] = bit
      else (matrix[size - 15 + i] as Uint8Array)[8] = bit
    }
    ;(matrix[size - 8] as Uint8Array)[8] = 1

    const score = penalty(matrix)
    if (score < bestScore) {
      bestScore = score
      best = matrix
    }
  }

  return best as Uint8Array[]
}

/** Draws the matrix as an SVG path string with a 4-module quiet zone, ready for a data-free inline <svg>. */
export const qrToSvgPath = (matrix: Uint8Array[]): { path: string; size: number } => {
  const quiet = 4
  const size = matrix.length + quiet * 2
  const parts: string[] = []
  matrix.forEach((row, y) => {
    row.forEach((cell, x) => {
      if (cell) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`)
    })
  })
  return { path: parts.join(''), size }
}
