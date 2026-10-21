import * as React from 'react'
import type { ComponentEntry } from './types'
import { Markdown, CollapsibleMarkdownProvider, CodeBlock, InlineCode, MarkdownDatatableBlock, MarkdownSpreadsheetBlock, MarkdownImageBlock, ImageCardStack, PlatformProvider, RunCommandProvider } from '@nessy-agent/ui'

const sampleMarkdown = `# Welcome to Markdown

This is a **bold** statement and this is *italic*.

## Code Examples

Here's some inline code: \`const x = 42\`

\`\`\`typescript
function greet(name: string): string {
  return \`Hello, \${name}!\`
}

// Call the function
console.log(greet("World"))
\`\`\`

## Lists

- First item
- Second item
  - Nested item
- Third item

1. Numbered one
2. Numbered two
3. Numbered three

## Table

| Name | Role | Status |
|------|------|--------|
| Alice | Developer | Active |
| Bob | Designer | Away |

## Blockquote

> This is a blockquote with some important information
> that spans multiple lines.

---

That's all folks!`

const codeHeavyMarkdown = `# API Response

The endpoint returned:

\`\`\`json
{
  "status": "success",
  "data": {
    "users": [
      { "id": 1, "name": "Alice" },
      { "id": 2, "name": "Bob" }
    ]
  }
}
\`\`\`

Process with:

\`\`\`python
import json

def process_response(data: dict) -> list:
    return [user["name"] for user in data["users"]]
\`\`\`

Or in TypeScript:

\`\`\`typescript
interface User {
  id: number
  name: string
}

const getNames = (users: User[]): string[] =>
  users.map(u => u.name)
\`\`\``

// UB14.9 — the three wells of v0.15.1 side by side (code · diff · JSON) in the transcript's own
// `minimal` answer mode, so the dark sweep reaches the diff well's header (path, +/−) — no other
// entry renders a ```diff block.
const wellsMarkdown = `Code, diff and JSON wells:

\`\`\`typescript
const total = items.reduce((sum, item) => sum + item.price, 0)
\`\`\`

\`\`\`diff
--- a/src/app/main.ts
+++ b/src/app/main.ts
@@ -1,3 +1,4 @@
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 export { a }
\`\`\`

\`\`\`json
{ "status": "success", "count": 2 }
\`\`\``

const typescriptCode = `import { useState, useEffect } from 'react'

interface Todo {
  id: number
  title: string
  completed: boolean
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/todos')
      .then(res => res.json())
      .then(data => {
        setTodos(data)
        setLoading(false)
      })
  }, [])

  return { todos, loading }
}`

const pythonCode = `from dataclasses import dataclass
from typing import Optional

@dataclass
class User:
    id: int
    name: str
    email: Optional[str] = None

def get_user_by_id(user_id: int) -> Optional[User]:
    """Fetch user from database."""
    # Simulated database lookup
    users = {
        1: User(1, "Alice", "alice@example.com"),
        2: User(2, "Bob"),
    }
    return users.get(user_id)`

const jsonCode = `{
  "name": "nessy-general-agent",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.2.0",
    "typescript": "^5.0.0"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build"
  }
}`

const richBlockParityMarkdown = `# Rich Block Interaction Parity

Use this fixture to compare **inline** and **fullscreen** interactions for Mermaid and image blocks.

- Tap/click inline content to open fullscreen
- In fullscreen: wheel/pinch zoom, drag pan, double-click reset
- Keyboard: Cmd/Ctrl +, -, 0

## Mermaid block

\`\`\`mermaid
graph LR
    A[Input] --> B{Validate}
    B -->|Valid| C[Persist]
    B -->|Invalid| D[Show Error]
    C --> E[Notify]
\`\`\`

## Image block

\`\`\`image-preview
{
  "title": "Parity Check",
  "items": [
    { "src": "/mock/images/gallery-1.png", "label": "Lake" },
    { "src": "/mock/images/gallery-2.png", "label": "Forest" }
  ]
}
\`\`\`
`

// Wrapper for collapsible markdown
function CollapsibleWrapper({ children }: { children: React.ReactNode }) {
  return <CollapsibleMarkdownProvider>{children}</CollapsibleMarkdownProvider>
}

const MOCK_IMAGE_DATA: Record<string, string> = {
  '/mock/images/gallery-1.png': 'https://picsum.photos/id/1015/1200/900',
  '/mock/images/gallery-2.png': 'https://picsum.photos/id/1025/900/1200',
  '/mock/images/gallery-3.png': 'https://picsum.photos/id/1035/1400/900',
  '/mock/images/gallery-4.png': 'https://picsum.photos/id/1043/1200/900',
  '/mock/images/gallery-5.png': 'https://picsum.photos/id/1067/1200/900',
}

function MarkdownImageBlockWrapper({ children }: { children: React.ReactNode }) {
  return (
    <PlatformProvider
      actions={{
        onReadFileDataUrl: async (path: string) => {
          await new Promise((resolve) => setTimeout(resolve, 120))
          const dataUrl = MOCK_IMAGE_DATA[path]
          if (!dataUrl) {
            throw new Error(`Mock image not found for: ${path}`)
          }
          return dataUrl
        },
      }}
    >
      {children}
    </PlatformProvider>
  )
}

function ImageCardStackPlayground({
  items,
  maxRotate,
}: {
  items: Array<{ src: string; label?: string; ratio?: number }> | string
  maxRotate: number
}) {
  const parsedItems = React.useMemo(() => {
    if (Array.isArray(items)) return items
    if (typeof items === 'string') {
      try {
        const parsed = JSON.parse(items)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return []
  }, [items])

  const [currentIndex, setCurrentIndex] = React.useState(0)

  React.useEffect(() => {
    setCurrentIndex(0)
  }, [parsedItems])

  return (
    <div className="h-full w-full p-4 flex flex-col gap-3">
      <div className="text-xs text-muted-foreground flex items-center justify-between">
        <span>Active card: {Math.min(currentIndex + 1, Math.max(parsedItems.length, 1))} / {parsedItems.length}</span>
        <span>Swipe left/right on top card</span>
      </div>
      <div className="flex-1 min-h-0 rounded-md border border-border/60 bg-muted/20 p-4 flex items-center justify-center">
        {parsedItems.length > 0 ? (
          <div className="h-[320px] w-full">
            <ImageCardStack items={parsedItems} currentIndex={currentIndex} onIndexChange={setCurrentIndex} maxRotate={maxRotate} maxHeight={320} />
          </div>
        ) : (
          <div className="h-full w-full flex items-center justify-center text-sm text-muted-foreground">
            Invalid or empty items JSON
          </div>
        )}
      </div>
    </div>
  )
}

const runnableMarkdown = [
  'Shell and console blocks get **Run in background** where the transcript provides a runner:',
  '',
  '```console',
  '$ list-md.sh apps/electron -r | head -3',
  'apps/electron/CLAUDE.md',
  'apps/electron/README.md',
  '```',
  '',
  '```bash',
  'bun test src/labels',
  '```',
  '',
  'Other languages do not:',
  '',
  '```ts',
  "const x = 'no play button'",
  '```',
].join('\n')

/** Code blocks inside a RunCommandProvider (the chat transcript in the app) */
function RunnableCodeBlocks() {
  const [ran, setRan] = React.useState<string[]>([])
  return (
    <RunCommandProvider value={(command) => setRan(previous => [...previous, command])}>
      <div className="flex flex-col gap-3 p-4">
        <Markdown mode="full">{runnableMarkdown}</Markdown>
        <div className="text-xs text-muted-foreground" data-testid="ran-commands">
          {ran.length ? `Ran: ${ran.map(c => JSON.stringify(c)).join(', ')}` : 'Nothing run yet'}
        </div>
      </div>
    </RunCommandProvider>
  )
}

// UA1.23 — knobs of the two preview-Publish entries below.
const PREVIEW_PUBLISH_KNOBS: ComponentEntry['props'] = [
  { name: 'kind', description: 'The preview block', control: { type: 'select', options: [
    { label: 'html-preview', value: 'html-preview' },
    { label: 'markdown-preview', value: 'markdown-preview' },
  ] }, defaultValue: 'html-preview' },
  { name: 'publishable', description: 'A session wired onPublishFile (the chat does; the viewer and detached windows do not)', control: { type: 'boolean' }, defaultValue: true },
  { name: 'withSrc', description: 'The block names a file (no src → no Publish)', control: { type: 'boolean' }, defaultValue: true },
  // UB14.10 — several files: the header's item navigator (v0.15.1 PreviewItemNavigator) beside Publish.
  { name: 'multi', description: 'Several files (the header navigator; Publish names the active one)', control: { type: 'boolean' }, defaultValue: false },
]

// UB14.10 — the loading and error wells every file-backed preview block shares (v0.15.1 PreviewBlockChrome).
type PreviewStateKind = 'datatable' | 'spreadsheet' | 'pdf-preview' | 'html-preview' | 'markdown-preview' | 'image-preview'

const PREVIEW_STATE_SPECS: Record<PreviewStateKind, Record<string, string>> = {
  datatable: { src: '/mock/data/q3-pipeline.json', title: 'Q3 pipeline' },
  spreadsheet: { src: '/mock/data/q3-pipeline.json', filename: 'Q3.xlsx', sheetName: 'Pipeline' },
  'pdf-preview': { src: '/mock/out/q3-deck.pdf', title: 'Q3 deck' },
  'html-preview': { src: '/mock/out/q3-report.html', title: 'Q3 report' },
  'markdown-preview': { src: '/mock/out/q3-notes.md', title: 'Q3 notes' },
  'image-preview': { src: '/mock/out/q3-chart.png', title: 'Q3 chart' },
}

/** A file-backed preview block whose read never settles (loading) or fails (error). */
function PreviewBlockStatesPlayground({ kind, state }: { kind: PreviewStateKind; state: 'loading' | 'error' }) {
  const read = state === 'loading'
    ? () => new Promise<never>(() => {})
    : (path: string) => Promise.reject(new Error(`Mock file not found: ${path}`))
  const fence = '```' + kind + '\n' + JSON.stringify(PREVIEW_STATE_SPECS[kind], null, 2) + '\n```'
  return (
    <PlatformProvider actions={{ onReadFile: read, onReadFileBinary: read, onReadFileDataUrl: read }}>
      <div className="w-[640px]"><Markdown mode="full">{fence}</Markdown></div>
    </PlatformProvider>
  )
}

const PREVIEW_STATE_KINDS: PreviewStateKind[] = ['datatable', 'spreadsheet', 'pdf-preview', 'html-preview', 'markdown-preview', 'image-preview']

export const markdownComponents: ComponentEntry[] = [
  {
    id: 'markdown-run-command',
    name: 'Code blocks · Run in background',
    category: 'Markdown',
    description: 'Shell/console code blocks show a play button when a RunCommandProvider supplies a runner',
    component: RunnableCodeBlocks,
    layout: 'top',
    props: [],
    variants: [{ name: 'Default', props: {} }],
  },
  {
    id: 'markdown',
    name: 'Markdown',
    category: 'Markdown',
    description: 'Customizable markdown renderer with three render modes: terminal, minimal, full',
    component: Markdown,
    layout: 'top',
    props: [
      {
        name: 'children',
        description: 'Markdown content to render',
        control: { type: 'textarea', rows: 10 },
        defaultValue: sampleMarkdown,
      },
      {
        name: 'mode',
        description: 'Render mode controlling formatting level',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'minimal',
      },
      {
        name: 'collapsible',
        description: 'Enable collapsible headings',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'Terminal', props: { children: sampleMarkdown, mode: 'terminal' } },
      { name: 'Minimal', props: { children: sampleMarkdown, mode: 'minimal' } },
      { name: 'Full', props: { children: sampleMarkdown, mode: 'full' } },
      { name: 'Code Heavy', props: { children: codeHeavyMarkdown, mode: 'minimal' } },
      { name: 'Wells (code · diff · JSON)', props: { children: wellsMarkdown, mode: 'minimal' } },
      { name: 'Collapsible', props: { children: sampleMarkdown, mode: 'full', collapsible: true } },
    ],
    mockData: () => ({
      onUrlClick: (url: string) => console.log('[Playground] URL clicked:', url),
      onFileClick: (path: string) => console.log('[Playground] File clicked:', path),
    }),
    wrapper: CollapsibleWrapper,
  },
  {
    id: 'code-block',
    name: 'CodeBlock',
    category: 'Markdown',
    description: 'Syntax highlighted code block using Shiki with copy button',
    component: CodeBlock,
    props: [
      {
        name: 'code',
        description: 'Code to display',
        control: { type: 'textarea', rows: 8 },
        defaultValue: typescriptCode,
      },
      {
        name: 'language',
        description: 'Programming language for syntax highlighting',
        control: {
          type: 'select',
          options: [
            { label: 'TypeScript', value: 'typescript' },
            { label: 'JavaScript', value: 'javascript' },
            { label: 'Python', value: 'python' },
            { label: 'JSON', value: 'json' },
            { label: 'Bash', value: 'bash' },
            { label: 'Plain Text', value: 'text' },
          ],
        },
        defaultValue: 'typescript',
      },
      {
        name: 'mode',
        description: 'Render mode',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'full',
      },
    ],
    variants: [
      { name: 'TypeScript Full', props: { code: typescriptCode, language: 'typescript', mode: 'full' } },
      { name: 'TypeScript Minimal', props: { code: typescriptCode, language: 'typescript', mode: 'minimal' } },
      { name: 'Python', props: { code: pythonCode, language: 'python', mode: 'full' } },
      { name: 'JSON', props: { code: jsonCode, language: 'json', mode: 'full' } },
    ],
  },
  {
    id: 'inline-code',
    name: 'InlineCode',
    category: 'Markdown',
    description: 'Styled inline code span with subtle background and border',
    component: InlineCode,
    props: [
      {
        name: 'children',
        description: 'Code text',
        control: { type: 'string' },
        defaultValue: 'const x = 42',
      },
    ],
    variants: [
      { name: 'Variable', props: { children: 'useState' } },
      { name: 'Function', props: { children: 'handleClick()' } },
      { name: 'Type', props: { children: 'React.FC<Props>' } },
      { name: 'Path', props: { children: 'src/components/App.tsx' } },
    ],
  },
  {
    id: 'datatable-block',
    name: 'MarkdownDatatableBlock',
    category: 'Markdown',
    description: 'Interactive data table with sorting for ```datatable code blocks',
    component: MarkdownDatatableBlock,
    props: [
      {
        name: 'code',
        description: 'JSON string with columns and rows',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify({
          title: 'Sales by Region',
          columns: [
            { key: 'region', label: 'Region', type: 'text' },
            { key: 'revenue', label: 'Revenue', type: 'currency' },
            { key: 'growth', label: 'Growth', type: 'percent' },
            { key: 'units', label: 'Units Sold', type: 'number' },
            { key: 'status', label: 'Status', type: 'badge' },
          ],
          rows: [
            { region: 'North America', revenue: 1250000, growth: 0.124, units: 8420, status: 'Active' },
            { region: 'Europe', revenue: 980000, growth: 0.087, units: 6230, status: 'Active' },
            { region: 'Asia Pacific', revenue: 1580000, growth: 0.215, units: 12100, status: 'Active' },
            { region: 'Latin America', revenue: 420000, growth: -0.032, units: 2800, status: 'Revoked' },
            { region: 'Middle East', revenue: 310000, growth: 0.156, units: 1900, status: 'Active' },
          ],
        }, null, 2),
      },
    ],
    variants: [
      {
        name: 'Sales Data',
        props: {
          code: JSON.stringify({
            title: 'Sales by Region',
            columns: [
              { key: 'region', label: 'Region', type: 'text' },
              { key: 'revenue', label: 'Revenue', type: 'currency' },
              { key: 'growth', label: 'Growth', type: 'percent' },
              { key: 'status', label: 'Status', type: 'badge' },
            ],
            rows: [
              { region: 'North America', revenue: 1250000, growth: 0.124, status: 'Active' },
              { region: 'Europe', revenue: 980000, growth: 0.087, status: 'Active' },
              { region: 'Asia Pacific', revenue: 1580000, growth: 0.215, status: 'Active' },
              { region: 'Latin America', revenue: 420000, growth: -0.032, status: 'Revoked' },
            ],
          }),
        },
      },
      {
        name: 'Boolean & Badge Types',
        props: {
          code: JSON.stringify({
            title: 'API Keys',
            columns: [
              { key: 'name', label: 'Name', type: 'text' },
              { key: 'active', label: 'Active', type: 'boolean' },
              { key: 'status', label: 'Status', type: 'badge' },
            ],
            rows: [
              { name: 'Production', active: true, status: 'Passing' },
              { name: 'Staging', active: true, status: 'Passing' },
              { name: 'Legacy', active: false, status: 'Failed' },
            ],
          }),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        props: { code: '{ invalid json here' },
      },
    ],
  },
  {
    id: 'spreadsheet-block',
    name: 'MarkdownSpreadsheetBlock',
    category: 'Markdown',
    description: 'Excel-style grid with column letters and row numbers for ```spreadsheet code blocks',
    component: MarkdownSpreadsheetBlock,
    props: [
      {
        name: 'code',
        description: 'JSON string with columns and rows',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify({
          filename: 'Q1_Revenue.xlsx',
          sheetName: 'Summary',
          columns: [
            { key: 'region', label: 'Region', type: 'text' },
            { key: 'q1', label: 'Q1', type: 'currency' },
            { key: 'q2', label: 'Q2', type: 'currency' },
            { key: 'change', label: 'Change', type: 'percent' },
            { key: 'total', label: 'Total', type: 'formula' },
          ],
          rows: [
            { region: 'North', q1: 500000, q2: 620000, change: 0.24, total: 1120000 },
            { region: 'South', q1: 340000, q2: 310000, change: -0.088, total: 650000 },
            { region: 'East', q1: 780000, q2: 850000, change: 0.09, total: 1630000 },
            { region: 'West', q1: 420000, q2: 480000, change: 0.143, total: 900000 },
          ],
        }, null, 2),
      },
    ],
    variants: [
      {
        name: 'Revenue Sheet',
        props: {
          code: JSON.stringify({
            filename: 'Q1_Revenue.xlsx',
            sheetName: 'Summary',
            columns: [
              { key: 'region', label: 'Region', type: 'text' },
              { key: 'q1', label: 'Q1', type: 'currency' },
              { key: 'q2', label: 'Q2', type: 'currency' },
              { key: 'change', label: 'Change', type: 'percent' },
            ],
            rows: [
              { region: 'North', q1: 500000, q2: 620000, change: 0.24 },
              { region: 'South', q1: 340000, q2: 310000, change: -0.088 },
              { region: 'East', q1: 780000, q2: 850000, change: 0.09 },
            ],
          }),
        },
      },
      {
        name: 'Simple Sheet (No Filename)',
        props: {
          code: JSON.stringify({
            columns: [
              { key: 'item', label: 'Item', type: 'text' },
              { key: 'qty', label: 'Quantity', type: 'number' },
              { key: 'price', label: 'Price', type: 'currency' },
            ],
            rows: [
              { item: 'Widget A', qty: 100, price: 29 },
              { item: 'Widget B', qty: 250, price: 15 },
              { item: 'Widget C', qty: 50, price: 89 },
            ],
          }),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        props: { code: '{ invalid json here' },
      },
    ],
  },
  {
    id: 'image-card-stack',
    name: 'ImageCardStack',
    category: 'Markdown',
    description: 'Swipeable card stack used for image gallery previews.',
    component: ImageCardStackPlayground,
    layout: 'full',
    props: [
      {
        name: 'items',
        description: 'Gallery items with optional aspect ratio values (width/height).',
        control: { type: 'textarea', rows: 10 },
        defaultValue: JSON.stringify([
          { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Lake', ratio: 4 / 3 },
          { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Forest', ratio: 3 / 4 },
          { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Sunset', ratio: 16 / 9 },
        ], null, 2),
      },
      {
        name: 'maxRotate',
        description: 'Maximum baseline random card rotation in degrees.',
        control: { type: 'number', min: 0, max: 16, step: 1 },
        defaultValue: 5,
      },
    ],
    variants: [
      {
        name: 'Mixed Ratios',
        props: {
          items: JSON.stringify([
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Lake', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Forest', ratio: 3 / 4 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Sunset', ratio: 16 / 9 },
          ], null, 2),
          maxRotate: 5,
        },
      },
      {
        name: 'Large Gallery',
        props: {
          items: JSON.stringify([
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'Shot 1', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Shot 2', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Shot 3', ratio: 16 / 9 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-4.png'], label: 'Shot 4', ratio: 3 / 4 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-5.png'], label: 'Shot 5', ratio: 4 / 3 },
          ], null, 2),
          maxRotate: 7,
        },
      },
      {
        name: 'Subtle Rotation',
        props: {
          items: JSON.stringify([
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-1.png'], label: 'One', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-2.png'], label: 'Two', ratio: 4 / 3 },
            { src: MOCK_IMAGE_DATA['/mock/images/gallery-3.png'], label: 'Three', ratio: 4 / 3 },
          ], null, 2),
          maxRotate: 2,
        },
      },
    ],
  },
  {
    id: 'markdown-image-block',
    name: 'MarkdownImageBlock',
    category: 'Markdown',
    description: 'Renders ```image-preview blocks with card-stack galleries and fullscreen overlay support.',
    component: MarkdownImageBlock,
    wrapper: MarkdownImageBlockWrapper,
    layout: 'top',
    props: [
      {
        name: 'code',
        description: 'JSON spec for image-preview block.',
        control: { type: 'textarea', rows: 12 },
        defaultValue: JSON.stringify({
          title: 'Image Gallery',
          items: [
            { src: '/mock/images/gallery-1.png', label: 'Lake', ratio: 4 / 3 },
            { src: '/mock/images/gallery-2.png', label: 'Forest', ratio: 3 / 4 },
            { src: '/mock/images/gallery-3.png', label: 'Sunset', ratio: 16 / 9 },
          ],
        }, null, 2),
      },
    ],
    variants: [
      {
        name: 'Single Image',
        props: {
          code: JSON.stringify({
            title: 'Single Image',
            src: '/mock/images/gallery-1.png',
          }, null, 2),
        },
      },
      {
        name: 'Gallery Stack',
        props: {
          code: JSON.stringify({
            title: 'Gallery Stack',
            items: [
              { src: '/mock/images/gallery-1.png', label: 'Lake', ratio: 4 / 3 },
              { src: '/mock/images/gallery-2.png', label: 'Forest', ratio: 3 / 4 },
              { src: '/mock/images/gallery-3.png', label: 'Sunset', ratio: 16 / 9 },
              { src: '/mock/images/gallery-4.png', label: 'City', ratio: 4 / 3 },
            ],
          }, null, 2),
        },
      },
      {
        name: 'Unknown Path Error',
        props: {
          code: JSON.stringify({
            title: 'Missing Image',
            items: [
              { src: '/mock/images/gallery-1.png', label: 'Found' },
              { src: '/mock/images/does-not-exist.png', label: 'Missing' },
            ],
          }, null, 2),
        },
      },
      {
        name: 'Invalid JSON (Fallback)',
        props: { code: '{ invalid json here' },
      },
    ],
  },
  {
    id: 'rich-block-interaction-parity',
    name: 'RichBlockInteractionParity',
    category: 'Markdown',
    description: 'Single playground fixture to verify inline + fullscreen interaction parity across Mermaid and image-preview blocks.',
    component: Markdown,
    wrapper: MarkdownImageBlockWrapper,
    layout: 'top',
    props: [
      {
        name: 'children',
        description: 'Markdown fixture for parity checks',
        control: { type: 'textarea', rows: 20 },
        defaultValue: richBlockParityMarkdown,
      },
      {
        name: 'mode',
        description: 'Render mode controlling formatting level',
        control: {
          type: 'select',
          options: [
            { label: 'Terminal', value: 'terminal' },
            { label: 'Minimal', value: 'minimal' },
            { label: 'Full', value: 'full' },
          ],
        },
        defaultValue: 'full',
      },
    ],
    variants: [
      { name: 'Parity Fixture', props: { children: richBlockParityMarkdown, mode: 'full' } },
    ],
    mockData: () => ({
      onUrlClick: (url: string) => console.log('[Playground] URL clicked:', url),
      onFileClick: (path: string) => console.log('[Playground] File clicked:', path),
    }),
  },
  // UA1.23 — the preview entries with the Publish knob (owner 2026-09-23): `publishable` wires a session's
  // `onPublishFile` (here a console log — the host card is the sitting's); `withSrc` off is the negative: a block
  // whose item names no file offers no Publish.
  {
    id: 'html-preview-publish',
    name: 'HTML preview — Publish',
    category: 'Markdown',
    description: 'UA1.23 — an inline html-preview block with the Publish action beside fullscreen (shown only where a session wired it and the block names a file).',
    component: PreviewPublishPlayground,
    layout: 'top',
    props: PREVIEW_PUBLISH_KNOBS,
    variants: [
      { name: 'Publish offered', props: { kind: 'html-preview', publishable: true, withSrc: true } },
      { name: 'No session wired (no Publish)', props: { kind: 'html-preview', publishable: false, withSrc: true } },
      { name: 'No file (no Publish)', props: { kind: 'html-preview', publishable: true, withSrc: false } },
      { name: 'Several files (navigator)', props: { kind: 'html-preview', publishable: true, withSrc: true, multi: true } },
    ],
  },
  {
    id: 'markdown-preview-publish',
    name: 'Markdown preview — Publish',
    category: 'Markdown',
    description: 'UA1.23 — an inline markdown-preview block with the Publish action beside expand.',
    component: PreviewPublishPlayground,
    layout: 'top',
    props: PREVIEW_PUBLISH_KNOBS,
    variants: [
      { name: 'Publish offered', props: { kind: 'markdown-preview', publishable: true, withSrc: true } },
      { name: 'No session wired (no Publish)', props: { kind: 'markdown-preview', publishable: false, withSrc: true } },
      { name: 'Several files (navigator)', props: { kind: 'markdown-preview', publishable: true, withSrc: true, multi: true } },
    ],
  },
  {
    id: 'preview-block-states',
    name: 'Preview blocks · loading and error',
    category: 'Markdown',
    description: 'UB14.10 — the shared well (v0.15.1 PreviewBlockChrome) of every file-backed preview block while its file loads, and when the read fails.',
    component: PreviewBlockStatesPlayground,
    layout: 'top',
    props: [
      { name: 'kind', description: 'The preview block', control: { type: 'select', options: PREVIEW_STATE_KINDS.map(kind => ({ label: kind, value: kind })) }, defaultValue: 'datatable' },
      { name: 'state', description: 'The read never settles (loading) or fails (error)', control: { type: 'select', options: [
        { label: 'loading', value: 'loading' },
        { label: 'error', value: 'error' },
      ] }, defaultValue: 'loading' },
    ],
    variants: [
      ...PREVIEW_STATE_KINDS.map(kind => ({ name: `${kind} · loading`, props: { kind, state: 'loading' } })),
      ...PREVIEW_STATE_KINDS.map(kind => ({ name: `${kind} · error`, props: { kind, state: 'error' } })),
    ],
  },
]

const PREVIEW_PUBLISH_FILES: Record<string, string> = {
  '/mock/out/report.html': '<!doctype html><html><head><title>Q3</title></head><body><h1>Q3 report</h1><p>Numbers.</p></body></html>',
  '/mock/out/summary.md': '# Summary\n\n- one\n- two\n',
  '/mock/out/report-q4.html': '<!doctype html><html><head><title>Q4</title></head><body><h1>Q4 report</h1><p>More numbers.</p></body></html>',
  '/mock/out/summary-v2.md': '# Summary v2\n\n- one\n- two\n- three\n',
}

function PreviewPublishPlayground({ kind, publishable, withSrc, multi = false }: { kind: 'html-preview' | 'markdown-preview'; publishable: boolean; withSrc: boolean; multi?: boolean }) {
  const src = kind === 'html-preview' ? '/mock/out/report.html' : '/mock/out/summary.md'
  const second = kind === 'html-preview' ? '/mock/out/report-q4.html' : '/mock/out/summary-v2.md'
  const title = kind === 'html-preview' ? 'Q3 report' : 'Summary'
  // A spec without `src`/`items` is not a preview at all (the block falls back to the code view) — the negative arm.
  // UB14.10 — `multi` names two files, so the header draws the item navigator before Publish.
  const spec = !withSrc
    ? { title: 'No file' }
    : multi
      ? { title, items: [{ src, label: 'v1' }, { src: second, label: 'v2' }] }
      : { src, title }
  const fence = '```' + kind + '\n' + JSON.stringify(spec, null, 2) + '\n```'
  return (
    <PlatformProvider
      actions={{
        onReadFile: async (path: string) => PREVIEW_PUBLISH_FILES[path] ?? '',
        ...(publishable ? { onPublishFile: (path: string) => console.log('[Playground] publish requested for', path) } : {}),
      }}
    >
      <div className="w-[640px]"><Markdown mode="full">{fence}</Markdown></div>
    </PlatformProvider>
  )
}
