// PDF 逐页文本抽取（pdfjs-dist 懒加载，worker 走 ?url 资产；仅取文本，不渲染位图）
export async function pdfToPages(file: File): Promise<{ pages: string[] }> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default

  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  const doc = await task.promise
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let text = ''
    for (const item of content.items) {
      if (!('str' in item)) continue
      text += item.str
      if (item.hasEOL) text += '\n'
    }
    pages.push(text.replace(/[ \t]+\n/g, '\n').trim())
  }
  await task.destroy()
  return { pages }
}
