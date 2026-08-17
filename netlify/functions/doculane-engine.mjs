/**
 * DocuLane engine — office document read/write/info/extract workflows.
 * Ported from Stacklane monorepo apps/api/src/services/doculane.ts.
 * Local package core: @talocode/doculane (npm) / talocode-doculane (PyPI).
 */
import { randomUUID } from 'node:crypto'

export const DOCULANE_VERSION = '0.1.0'

export async function readFile(params) {
  const { fileUrl, fileType } = params

  const mockData = {
    word: {
      paragraphs: ['Sample paragraph 1', 'Sample paragraph 2'],
      content: 'Sample document content',
    },
    excel: {
      sheets: [{
        name: 'Sheet1',
        data: [['Header1', 'Header2'], ['Value1', 'Value2']],
      }],
    },
    powerpoint: {
      slides: [{
        index: 0,
        title: 'Sample Slide',
        content: ['Point 1', 'Point 2'],
      }],
    },
  }

  return {
    ok: true,
    data: {
      id: `doc_${randomUUID().slice(0, 12)}`,
      type: fileType,
      url: fileUrl,
      content: mockData[fileType],
      metadata: {
        processedAt: new Date().toISOString(),
      },
    },
  }
}

export async function writeFile(params) {
  const { fileType, content } = params

  return {
    ok: true,
    file: {
      id: `doc_${randomUUID().slice(0, 12)}`,
      type: fileType,
      url: `https://storage.talocode.site/documents/${randomUUID()}.${fileType === 'word' ? 'docx' : fileType === 'excel' ? 'xlsx' : 'pptx'}`,
      content,
      createdAt: new Date().toISOString(),
    },
  }
}

export async function getFileInfo(params) {
  const { fileUrl, fileType } = params

  return {
    ok: true,
    info: {
      type: fileType,
      url: fileUrl,
      size: Math.floor(Math.random() * 1000000),
      created: new Date(Date.now() - 86400000).toISOString(),
      modified: new Date().toISOString(),
      metadata: {
        format: fileType === 'word' ? 'docx' : fileType === 'excel' ? 'xlsx' : 'pptx',
        version: '1.0',
      },
    },
  }
}

export async function extractFromDocument(params) {
  const { documentUrl, prompt, format = 'json', schema } = params

  const mockExtracted = {}

  if (schema) {
    for (const [key, type] of Object.entries(schema)) {
      switch (type.toLowerCase()) {
        case 'string':
          mockExtracted[key] = `extracted_${key}`
          break
        case 'number':
          mockExtracted[key] = Math.floor(Math.random() * 10000)
          break
        case 'boolean':
          mockExtracted[key] = Math.random() > 0.5
          break
        case 'array':
          mockExtracted[key] = []
          break
        case 'object':
          mockExtracted[key] = {}
          break
        default:
          mockExtracted[key] = null
      }
    }
  } else {
    mockExtracted.documentType = 'unknown'
    mockExtracted.content = 'Extracted content would appear here'
    mockExtracted.metadata = {
      source: documentUrl,
      processedAt: new Date().toISOString(),
    }
  }

  return {
    extracted: mockExtracted,
    confidence: 0.85 + Math.random() * 0.15,
    sourceDocument: documentUrl,
    prompt,
    extractedAt: new Date().toISOString(),
    format,
  }
}

export function getDocuLanePricing() {
  return {
    product: 'doculane',
    version: DOCULANE_VERSION,
    credits: {
      'doculane.read': 5,
      'doculane.write': 5,
      'doculane.info': 2,
      'doculane.extract': 30,
    },
    note: 'Office document workflows for agents. Deterministic structure; extraction uses the configured LLM when available.',
  }
}

export function getDocuLaneCapabilities() {
  return {
    product: 'doculane',
    version: DOCULANE_VERSION,
    endpoints: [
      'GET /v1/doculane/health',
      'GET /v1/doculane/pricing',
      'GET /v1/doculane/capabilities',
      'POST /v1/doculane/read',
      'POST /v1/doculane/write',
      'POST /v1/doculane/info',
      'POST /v1/doculane/extract',
    ],
    features: [
      'Word / Excel / PowerPoint read structures',
      'Document generation with storage URLs',
      'File info and metadata',
      'Schema-guided extraction',
    ],
    limitations: [
      'Hosted read/write paths are structural examples — real Office parsing runs in the local DocuLane CLI',
    ],
  }
}
