import {
  type PDFDocument as Doc,
  PageSizes,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  PDFString,
  rgb,
  StandardFonts,
} from 'pdf-lib'

/**
 * A deliberately small layout engine over pdf-lib: a cursor that flows headings, paragraphs, key/value lists
 * and tables down A4 pages, breaking pages as needed. Only the 14 standard fonts are used, so no font file is
 * bundled — which means text must be WinAnsi-safe; every string goes through `ascii` first.
 */

const [PAGE_WIDTH, PAGE_HEIGHT] = PageSizes.A4
const MARGIN = 48
const FOOTER_SPACE = 34
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2
const LINE_GAP = 1.35

const INK = rgb(0.06, 0.09, 0.16)
const MUTED = rgb(0.35, 0.39, 0.45)
const RULE = rgb(0.8, 0.83, 0.87)
const ACCENT = rgb(0.19, 0.18, 0.51)
const ZEBRA = rgb(0.96, 0.97, 0.98)
const LINK = rgb(0.11, 0.31, 0.72)

const REPLACEMENTS: [RegExp, string][] = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—−]/g, '-'],
  [/…/g, '...'],
  [/[·•]/g, '-'],
  [/→/g, '->'],
  [/ /g, ' '],
]

/** Anything → printable ASCII: accents are stripped, typographic punctuation mapped, the rest replaced. */
export const ascii = (value: unknown): string => {
  let text = String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
  for (const [pattern, replacement] of REPLACEMENTS) text = text.replace(pattern, replacement)
  return text.replace(/[\t\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?')
}

export interface Column {
  header: string
  /** Share of the content width; the shares of a table should sum to 1. */
  width: number
  mono?: boolean
  align?: 'left' | 'right'
}

interface Fonts {
  regular: PDFFont
  bold: PDFFont
  mono: PDFFont
}

export class PdfReport {
  private page: PDFPage
  private y: number

  private constructor(
    private readonly doc: Doc,
    private readonly fonts: Fonts,
  ) {
    this.page = doc.addPage(PageSizes.A4)
    this.y = PAGE_HEIGHT - MARGIN
  }

  static async create(meta: { title: string; subject: string }): Promise<PdfReport> {
    const doc = await PDFDocument.create()
    doc.setTitle(ascii(meta.title))
    doc.setSubject(ascii(meta.subject))
    doc.setCreator('VerifAid')
    doc.setProducer('VerifAid dashboard (pdf-lib)')
    doc.setCreationDate(new Date())
    const [regular, bold, mono] = await Promise.all([
      doc.embedFont(StandardFonts.Helvetica),
      doc.embedFont(StandardFonts.HelveticaBold),
      doc.embedFont(StandardFonts.Courier),
    ])
    return new PdfReport(doc, { regular, bold, mono })
  }

  private newPage(): void {
    this.page = this.doc.addPage(PageSizes.A4)
    this.y = PAGE_HEIGHT - MARGIN
  }

  /** Starts a new page unless `height` points still fit above the footer. */
  private ensure(height: number): void {
    if (this.y - height < MARGIN + FOOTER_SPACE) this.newPage()
  }

  /** Greedy word wrap; tokens longer than the line (hashes, URIs) are broken by character. */
  private wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const lines: string[] = []
    let line = ''
    const fits = (candidate: string) => font.widthOfTextAtSize(candidate, size) <= width
    for (const word of ascii(text).split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (fits(candidate)) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      line = ''
      let rest = word
      while (rest && !fits(rest)) {
        let cut = rest.length - 1
        while (cut > 1 && !fits(rest.slice(0, cut))) cut--
        lines.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      line = rest
    }
    if (line || lines.length === 0) lines.push(line)
    return lines
  }

  private draw(text: string, x: number, size: number, font: PDFFont, color = INK): void {
    this.page.drawText(text, { x, y: this.y - size, size, font, color })
  }

  /** A clickable region over text already drawn on this line, so a reviewer on a screen can just follow it. */
  private annotate(url: string, x: number, width: number, size: number): void {
    const annotation = this.doc.context.register(
      this.doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [x, this.y - size - 1, x + width, this.y + 1],
        Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
      }),
    )
    this.page.node.addAnnot(annotation)
  }

  /** True for a value this document should render as a link rather than as text. */
  private static isUrl(value: string): boolean {
    return value.startsWith('https://') || value.startsWith('http://')
  }

  spacer(points = 8): void {
    this.y -= points
  }

  title(text: string, subtitle?: string): void {
    this.draw(ascii(text), MARGIN, 18, this.fonts.bold, ACCENT)
    this.y -= 18 * LINE_GAP
    if (subtitle) this.paragraph(subtitle, { size: 10, color: MUTED })
    this.spacer(4)
  }

  heading(text: string): void {
    this.ensure(40)
    this.spacer(10)
    this.draw(ascii(text), MARGIN, 12, this.fonts.bold, ACCENT)
    this.y -= 12 * LINE_GAP
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 0.6,
      color: RULE,
    })
    this.spacer(6)
  }

  paragraph(
    text: string,
    options: { size?: number; color?: ReturnType<typeof rgb>; bold?: boolean } = {},
  ): void {
    const size = options.size ?? 9
    const font = options.bold ? this.fonts.bold : this.fonts.regular
    for (const line of this.wrap(text, font, size, CONTENT_WIDTH)) {
      this.ensure(size * LINE_GAP)
      this.draw(line, MARGIN, size, font, options.color ?? INK)
      this.y -= size * LINE_GAP
    }
  }

  /** Two columns: a label and a value that wraps. Values that look like hashes are set in monospace. */
  keyValues(rows: [string, string | number | null | undefined][]): void {
    const size = 8.5
    const labelWidth = 150
    const valueWidth = CONTENT_WIDTH - labelWidth
    for (const [label, raw] of rows) {
      const value = raw === null || raw === undefined || raw === '' ? '-' : String(raw)
      const url = PdfReport.isUrl(value)
      const mono = !url && /^0x[0-9a-fA-F]{8,}$/.test(value)
      const font = mono ? this.fonts.mono : this.fonts.regular
      const lines = this.wrap(value, font, size, valueWidth)
      this.ensure(lines.length * size * LINE_GAP)
      this.draw(ascii(label), MARGIN, size, this.fonts.bold, MUTED)
      for (const line of lines) {
        this.draw(line, MARGIN + labelWidth, size, font, url ? LINK : INK)
        if (url) this.annotate(value, MARGIN + labelWidth, font.widthOfTextAtSize(line, size), size)
        this.y -= size * LINE_GAP
      }
      this.spacer(2)
    }
  }

  table(columns: Column[], rows: (string | number | null | undefined)[][], empty = 'None.'): void {
    const size = 7.5
    const padding = 3
    const widths = columns.map((column) => column.width * CONTENT_WIDTH)

    const header = () => {
      const height = size * LINE_GAP + padding * 2
      this.ensure(height + size * LINE_GAP * 2)
      let x = MARGIN
      this.page.drawRectangle({ x: MARGIN, y: this.y - height, width: CONTENT_WIDTH, height, color: ZEBRA })
      this.y -= padding
      columns.forEach((column, index) => {
        this.draw(ascii(column.header), x + padding, size, this.fonts.bold, MUTED)
        x += widths[index] as number
      })
      this.y -= size * LINE_GAP + padding
    }

    if (rows.length === 0) {
      this.paragraph(empty, { size: 8.5, color: MUTED })
      return
    }

    header()
    for (const row of rows) {
      const cells = columns.map((column, index) => {
        const font = column.mono ? this.fonts.mono : this.fonts.regular
        const value = row[index]
        const text = value === null || value === undefined || value === '' ? '-' : String(value)
        return { font, lines: this.wrap(text, font, size, (widths[index] as number) - padding * 2) }
      })
      const height = Math.max(...cells.map((cell) => cell.lines.length)) * size * LINE_GAP + padding * 2
      if (this.y - height < MARGIN + FOOTER_SPACE) {
        this.newPage()
        header()
      }
      const top = this.y
      let x = MARGIN
      cells.forEach((cell, index) => {
        const width = widths[index] as number
        this.y = top - padding
        for (const line of cell.lines) {
          const lineWidth = cell.font.widthOfTextAtSize(line, size)
          const left = columns[index]?.align === 'right' ? x + width - padding - lineWidth : x + padding
          this.draw(line, left, size, cell.font)
          this.y -= size * LINE_GAP
        }
        x += width
      })
      this.y = top - height
      this.page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: PAGE_WIDTH - MARGIN, y: this.y },
        thickness: 0.3,
        color: RULE,
      })
    }
    this.spacer(4)
  }

  /** Draws the footer on every page ("Page i of n") and serializes the document. */
  async finish(footer: string): Promise<Uint8Array> {
    const pages = this.doc.getPages()
    const size = 7.5
    pages.forEach((page, index) => {
      const y = MARGIN / 2
      page.drawLine({
        start: { x: MARGIN, y: y + 12 },
        end: { x: PAGE_WIDTH - MARGIN, y: y + 12 },
        thickness: 0.4,
        color: RULE,
      })
      page.drawText(ascii(footer), { x: MARGIN, y, size, font: this.fonts.regular, color: MUTED })
      const label = `Page ${index + 1} of ${pages.length}`
      const width = this.fonts.regular.widthOfTextAtSize(label, size)
      page.drawText(label, {
        x: PAGE_WIDTH - MARGIN - width,
        y,
        size,
        font: this.fonts.regular,
        color: MUTED,
      })
    })
    return this.doc.save()
  }
}
