import { Plugin, MarkdownView, Notice, addIcon, Editor } from 'obsidian'

const COPY_URL_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
  <rect x="14" y="14" width="8" height="6" rx="2"/>
  <path d="M18 16h.01"/>
  <path d="M16 20h.01"/>
  <path d="M20 20h.01"/>
</svg>
`

export default class CopyURLPlugin extends Plugin {
  async onload() {
    addIcon('copy-url-icon', COPY_URL_ICON)

    this.addCommand({
      id: 'copy-url-current-line',
      name: 'Copy URL from current line',
      icon: 'copy-url-icon',
      editorCallback: editor => this.copyURLFromCurrentLine(editor)
    })

    this.addRibbonIcon(
      'copy-url-icon',
      'Copy URL from current line',
      () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView)
        if (view) {
          this.copyURLFromCurrentLine(view.editor)
        }
      }
    )
  }

  onunload() {}

  copyURLFromCurrentLine(editor: Editor) {
    const { line } = editor.getCursor()
    const lineText = editor.getLine(line)

    const urlPatterns: RegExp[] = [
      /https?:\/\/[^\s\])\}]+/gi,
      /\[([^\]]*)\]\(([^)]+)\)/g,
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      /(?:^|\s)([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s]*)?/g
    ]

    const urls: string[] = []

    for (const pattern of urlPatterns) {
      let match: RegExpExecArray | null
      while ((match = pattern.exec(lineText)) !== null) {
        if (pattern.source.includes('\\]\\(')) {
          urls.push(match[2])
        } else if (pattern.source.includes('\\[\\[')) {
          urls.push(match[1])
        } else {
          urls.push(match[0].trim())
        }
      }
    }

    if (urls.length === 0) {
      new Notice('No URL found on current line')
      return
    }

    const urlToCopy = urls[0]

    navigator.clipboard.writeText(urlToCopy)
      .then(() => new Notice(`URL copied: ${urlToCopy}`))
      .catch(err => {
        console.error(err)
        new Notice('Failed to copy URL to clipboard')
      })
  }
}