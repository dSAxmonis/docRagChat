declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    numpages: number
    text: string
  }
  export default function pdfParse(data: Uint8Array): Promise<PdfParseResult>
}
