declare module 'hira://pdfjs/pdf.min.mjs' {
  export interface PDFPageViewport {
    width: number
    height: number
  }

  export interface PDFRenderTask {
    promise: Promise<void>
  }

  export interface PDFPageProxy {
    getViewport(options: { scale: number; rotation?: number }): PDFPageViewport
    render(options: {
      canvasContext: CanvasRenderingContext2D | null
      viewport: PDFPageViewport
      transform?: number[]
    }): PDFRenderTask
  }

  export interface PDFDocumentProxy {
    numPages: number
    getPage(pageNumber: number): Promise<PDFPageProxy>
    destroy(): Promise<void>
  }

  export interface PDFLoadingTask {
    promise: Promise<PDFDocumentProxy>
  }

  export const GlobalWorkerOptions: { workerSrc: string }
  export function getDocument(source: { url: string } | string): PDFLoadingTask
}
