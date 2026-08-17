export const PRODUCT_REGISTRY = {
  agentlane: { name: 'AgentLane', summary: 'Agent workflow orchestration', operations: ['run'] },
  agentops: { name: 'AgentOps', summary: 'Agent run analysis and evaluation', operations: ['evaluate'] },
  archwiki: { name: 'ArchWiki', summary: 'Codebase architecture documentation', operations: ['generate'] },
  auditlane: { name: 'AuditLane', summary: 'Structured system audits', operations: ['audit'] },
  codelane: { name: 'CodeLane', summary: 'Code workflow assistance', operations: ['generate'] },
  contextlane: { name: 'ContextLane', summary: 'Context retrieval and assembly', operations: ['retrieve'] },
  crawlerlane: { name: 'CrawlerLane', summary: 'Crawler and visibility analysis', operations: ['audit'] },
  devtool: { name: 'DevTool', summary: 'Developer workflow utilities', operations: ['inspect'] },
  evallane: { name: 'EvalLane', summary: 'Evaluation suites and scoring', operations: ['suite'] },
  experimentlane: { name: 'ExperimentLane', summary: 'Experiment planning and analysis', operations: ['run'] },
  flowlane: { name: 'FlowLane', summary: 'Workflow composition', operations: ['run'] },
  forgecad: { name: 'ForgeCAD', summary: 'Parametric design workflows', operations: ['generate'] },
  leanlane: { name: 'LeanLane', summary: 'Lean product workflow support', operations: ['analyze'] },
  maillane: { name: 'MailLane', summary: 'Email workflow operations', operations: ['draft'] },
  memorylane: { name: 'MemoryLane', summary: 'Durable memory workflows', operations: ['store', 'retrieve'] },
  messagelane: { name: 'MessageLane', summary: 'Consent-aware messaging workflows', operations: ['contacts', 'campaigns', 'send'] },
  opensourcelane: { name: 'OpenSourceLane', summary: 'Open-source repository analysis', operations: ['analyze'] },
  promptlane: { name: 'PromptLane', summary: 'Prompt workflow management', operations: ['generate'] },
  replylane: { name: 'ReplyLane', summary: 'Reply opportunity workflows', operations: ['score'] },
  signallane: { name: 'SignalLane', summary: 'Signal analysis and content planning', operations: ['analyze'] },
  statuslane: { name: 'StatusLane', summary: 'Status and uptime workflows', operations: ['check'] },
  tradia: { name: 'Tradia', summary: 'Trading-plan and risk workflows', operations: ['plan'] },
  ugclane: { name: 'UGC Lane', summary: 'Content strategy workflows', operations: ['strategy'] },
  webdatalane: { name: 'WebDataLane', summary: 'Web page extraction workflows', operations: ['fetch'] },
  worklane: { name: 'WorkLane', summary: 'Work management workflows', operations: ['run'] },
  xprolane: { name: 'XProLane', summary: 'X account workflow analysis', operations: ['analyze'] },
  xsearchlane: { name: 'XSearchLane', summary: 'X search and research workflows', operations: ['search', 'research'] },
}

export function getProductNamespace(path) {
  const match = /^\/v1\/([a-z0-9-]+)\/(.*)$/.exec(path)
  if (!match || !PRODUCT_REGISTRY[match[1]]) return null
  return { namespace: match[1], subpath: `/${match[2]}`, product: PRODUCT_REGISTRY[match[1]] }
}

export function productCapabilities(namespace, product) {
  return {
    namespace: `/v1/${namespace}/*`,
    product: product.name,
    summary: product.summary,
    status: 'defined',
    execution: 'not_configured',
    endpoints: [`/v1/${namespace}/health`, `/v1/${namespace}/pricing`, `/v1/${namespace}/capabilities`, ...product.operations.map((operation) => `/v1/${namespace}/${operation}`)],
  }
}
