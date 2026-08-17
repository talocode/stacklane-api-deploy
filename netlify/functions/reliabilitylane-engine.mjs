/**
 * ReliabilityLane engine — curated reliability patterns for AI agents.
 * Ported from Stacklane monorepo apps/api/src/services/reliabilitylane.ts.
 */
export const RELIABILITYLANE_VERSION = '0.1.0'

export const FAILURE_PATTERNS = [
  {
    id: 'retry-hammering',
    name: 'Retry Hammering',
    category: 'retries',
    severity: 'high',
    symptom: 'Agent retries the same failing call repeatedly with no delay, hammering a dead or degraded endpoint.',
    cause: 'A naive retry loop that ignores response class, backoff, and circuit state.',
    signs: ['Same call repeated with identical timing', 'Error log grows without progress', 'Downstream service degrades further from load'],
    prevention: ['Classify failures before retrying', 'Exponential backoff with jitter', 'Circuit breaker that opens after repeated failures'],
    detection: 'Monitor call frequency per tool; flag bursts that exceed a sane interval without a state change.',
  },
  {
    id: 'unverified-completion',
    name: 'Unverified Completion',
    category: 'verification',
    severity: 'high',
    symptom: 'Agent reports a task as done without checking the actual result (deploy passed, file written, email sent).',
    cause: 'The agent treats its own tool call as proof instead of verifying the end state.',
    signs: ['"Done" reported with no evidence', 'Green check without a runtime check', 'Follow-up failure immediately after "success"'],
    prevention: ['Verify the end state after every action', 'Independent check of the result', 'Log receipts: inputs, outputs, checks'],
    detection: 'Compare completion claims against the observable end state; require evidence for every done signal.',
  },
  {
    id: 'self-graded-work',
    name: 'Self-Graded Work',
    category: 'verification',
    severity: 'high',
    symptom: 'Agent grades its own output as passing with no independent check.',
    cause: 'The evaluator and the producer are the same model path, so errors are invisible to it.',
    signs: ['Pass/fail decided by the same agent', 'No independent assertion', 'Confident but wrong verdicts'],
    prevention: ['Use deterministic assertions', 'Separate producer from reviewer', 'Where feasible, independent evaluation'],
    detection: 'Flag any approval that came from the same agent that did the work.',
  },
  {
    id: 'lost-context',
    name: 'Lost Context',
    category: 'context',
    severity: 'high',
    symptom: 'Agent forgets earlier instructions or decisions and rebuilds context from scratch.',
    cause: 'Context is ephemeral, truncated, or not persisted between steps.',
    signs: ['Contradicts earlier explicit instruction', 'Re-asks for information already given', 'Duplicated work'],
    prevention: ['Persist decisions to memory or a file', 'Summarize state between steps', 'Keep instructions in the current window'],
    detection: 'Check consistency of the agent output against prior decisions in the run.',
  },
  {
    id: 'unsafe-tool-call',
    name: 'Unsafe Tool Call',
    category: 'safety',
    severity: 'high',
    symptom: 'Agent calls a destructive or irreversible tool without a policy gate.',
    cause: 'Tools are exposed without allow/deny policy or human approval on risky actions.',
    signs: ['Destructive commands executed directly', 'Sensitive data read without need', 'Side effects not gated'],
    prevention: ['Policy gate on high-risk tools', 'Human approval for destructive actions', 'Redact secrets from context'],
    detection: 'Audit tool calls against policy; flag unapproved destructive operations.',
  },
  {
    id: 'incident-no-timeline',
    name: 'Incident Without a Timeline',
    category: 'incidents',
    severity: 'medium',
    symptom: 'When something fails, there is no record of what happened when, so the root cause is unrecoverable.',
    cause: 'No structured logging of events, decisions, and evidence during the run.',
    signs: ['Failure without replayable history', 'No timestamps for key actions', 'Post-mortem is speculation'],
    prevention: ['Log every event with a timestamp', 'Record inputs, outputs, and checks', 'Keep the timeline queryable'],
    detection: 'For any incident, ask: can we reconstruct the sequence from logs?',
  },
  {
    id: 'wrong-math',
    name: 'Wrong Math',
    category: 'math',
    severity: 'high',
    symptom: 'Agent computes arithmetic incorrectly (e.g. 2 + 3 \u00d7 4) because it guesses instead of using a calculator.',
    cause: 'Language models are not calculators; evaluation order and precision are guessed.',
    signs: ['Simple arithmetic errors in output', 'Precedence mistakes', 'Rounding drift over multi-step math'],
    prevention: ['Route math to a deterministic engine', 'Never let the model guess arithmetic', 'Format numbers with an explicit mode'],
    detection: 'Re-run any arithmetic through a deterministic evaluator and compare.',
  },
  {
    id: 'security-ticket-fiction',
    name: 'Security Ticket Fiction',
    category: 'security',
    severity: 'high',
    symptom: 'Agent files a security finding that is not real, or a real finding with no evidence.',
    cause: 'Pattern-matching for vulnerabilities without verifying the code path is exploitable.',
    signs: ['Vulnerability claim with no repro', 'False positives shipped as findings', 'No proof of exploitability'],
    prevention: ['Require evidence for every finding', 'Verify the code path before filing', 'Prove exploitability or downgrade'],
    detection: 'Every finding must carry a repro or it is not a finding.',
  },
  {
    id: 'agents-overwrite-each-other',
    name: 'Agents Overwrite Each Other',
    category: 'coordination',
    severity: 'medium',
    symptom: 'Multiple agents editing the same files or resources clobber each other\u2019s work.',
    cause: 'No ownership or conflict detection across concurrent agents.',
    signs: ['Changes vanish after another agent runs', 'Merge conflicts in shared state', 'Two agents touching the same path'],
    prevention: ['Assign ownership per resource', 'Conflict detection before write', 'Shared context about who changed what'],
    detection: 'Track writes per resource and alert on concurrent modifications.',
  },
  {
    id: 'loop-forever',
    name: 'Looping Forever',
    category: 'retries',
    severity: 'medium',
    symptom: 'Agent repeats the same unsuccessful step without a termination condition.',
    cause: 'No attempt cap, no plan change, and no circuit on repeated identical failure.',
    signs: ['Same action repeated with no variation', 'Run length exceeds expectation', 'No progress between iterations'],
    prevention: ['Max attempts per step', 'Change plan when a step fails repeatedly', 'Break the loop after N identical failures'],
    detection: 'Detect repeated identical steps and halt or escalate.',
  },
]

export const RETRY_STRATEGIES = [
  {
    id: 'standard-transient',
    name: 'Standard Transient Retry',
    appliesTo: ['5xx', 'ECONNRESET', 'network', 'timeout'],
    plan: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 10000, jitter: true, retryOn: ['transient', 'timeout', 'unknown'] },
    note: 'Default for API and network calls. Exponential backoff with jitter avoids thundering herd.',
  },
  {
    id: 'rate-limit-slow',
    name: 'Rate Limit Slow Down',
    appliesTo: ['429', 'rate_limit', 'quota'],
    plan: { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30000, jitter: true, retryOn: ['rate_limit'] },
    note: 'Respect Retry-After when present. Longer base delay; do not hammer a 429.',
  },
  {
    id: 'no-retry-permanent',
    name: 'No Retry on Permanent Errors',
    appliesTo: ['400', '401', '403', '422', 'validation', 'auth'],
    plan: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false, retryOn: [] },
    note: 'Do not retry validation or auth errors; they will never succeed. Fail fast.',
  },
  {
    id: 'circuit-protected',
    name: 'Circuit-Protected Retry',
    appliesTo: ['downstream flaky', 'unstable dependency'],
    plan: { maxAttempts: 3, baseDelayMs: 300, maxDelayMs: 15000, jitter: true, retryOn: ['transient', 'unknown'] },
    note: 'Wrap with a circuit breaker: after N consecutive failures the circuit opens and the call is blocked until it cools down.',
  },
]

export const VERIFICATION_CHECKLISTS = [
  {
    id: 'deploy-verified',
    name: 'Deployment Verification',
    area: 'deployment',
    checks: [
      'Deploy command exited with a success status',
      'Service responds on the expected endpoint',
      'Health check returns healthy',
      'Latest version is actually live (not cached)',
      'Critical user flow returns expected output',
      'Rollback path is known and tested',
    ],
  },
  {
    id: 'code-complete',
    name: 'Code Completion Verification',
    area: 'code',
    checks: [
      'Code compiles and typechecks',
      'Tests run and pass',
      'Lint passes',
      'Changed behavior is covered by a test',
      'No secrets committed',
      'Diff contains only intended changes',
    ],
  },
  {
    id: 'security-finding',
    name: 'Security Finding Verification',
    area: 'security',
    checks: [
      'Repro steps produce the claimed failure',
      'Code path is reachable in practice',
      'Impact is concrete and scoped',
      'Not a known false-positive signature',
      'Finding includes the affected input and output',
    ],
  },
  {
    id: 'content-accurate',
    name: 'Content Accuracy Verification',
    area: 'content',
    checks: [
      'Every claim is supported by evidence',
      'Numbers and quotes match their sources',
      'No external brand references in first-party copy',
      'Title and caption match the asset',
      'Destination link resolves',
    ],
  },
  {
    id: 'data-intact',
    name: 'Data Integrity Verification',
    area: 'data',
    checks: [
      'Row counts match expected',
      'No partial writes (transactional)',
      'Foreign keys resolve',
      'Timestamps are correct',
      'Backup exists for destructive changes',
    ],
  },
]

export const INCIDENT_PLAYBOOKS = [
  {
    id: 'deploy-failed',
    name: 'Deploy Failed',
    triggers: ['Non-zero deploy exit', 'Health check failing after deploy', 'Version not live'],
    steps: [
      'Stop further changes to that environment',
      'Capture the failed deploy output',
      'Check the health endpoint and version',
      'Roll back if the previous version was healthy',
      'Log the incident timeline with timestamps',
    ],
    evidence: ['Deploy output', 'Health check result', 'Version before and after', 'Rollback decision'],
  },
  {
    id: 'outage-detected',
    name: 'Outage Detected',
    triggers: ['Uptime check fails', 'Users report unavailability', 'Error rate spikes'],
    steps: [
      'Confirm the outage is real, not a flake',
      'Identify the affected surface (route, region, service)',
      'Open the incident with a timeline',
      'Apply the smallest corrective action',
      'Verify recovery before declaring resolved',
      'Post-mortem: what changed right before',
    ],
    evidence: ['Uptime check history', 'Error rate chart', 'Change that preceded it', 'Recovery verification'],
  },
  {
    id: 'bad-tool-call',
    name: 'Dangerous Tool Call Caught',
    triggers: ['Policy gate blocked a call', 'Destructive command attempted', 'Secret nearly exposed'],
    steps: [
      'Confirm the call was blocked before execution',
      'Log which policy blocked it and why',
      'Check whether any prior similar call slipped through',
      'Update policy if the block was incomplete',
    ],
    evidence: ['Policy decision', 'Tool call payload', 'Audit log entry'],
  },
]

export const ANTI_PATTERNS = [
  {
    id: 'trust-the-green-check',
    name: 'Trusting the Green Check',
    why: 'A success status on the tool call is not proof the work is done. The end state can still be wrong.',
    replacement: 'Verify the end state independently after every action.',
  },
  {
    id: 'retry-everything',
    name: 'Retrying Everything',
    why: 'Retrying validation or auth errors wastes time and can multiply the damage of a permanent mistake.',
    replacement: 'Classify failures first; only retry transient and rate-limited ones.',
  },
  {
    id: 'self-review',
    name: 'Self-Review',
    why: 'The same model path that produced the output cannot reliably see its own errors.',
    replacement: 'Use deterministic assertions and, where possible, an independent reviewer.',
  },
  {
    id: 'infinite-loop',
    name: 'Infinite Retry Loop',
    why: 'No attempt cap means a broken step repeats until you stop the agent manually.',
    replacement: 'Cap attempts, change the plan on repeated failure, and trip a circuit.',
  },
  {
    id: 'model-does-math',
    name: 'Letting the Model Do Math',
    why: 'Language models guess arithmetic; precision and precedence drift without a deterministic engine.',
    replacement: 'Route every calculation to a deterministic evaluator.',
  },
]

const SYMPTOM_TERMS = {
  'retry-hammering': ['retry', 'retries', 'hammer', '500', 'econnreset', 'again', 'loop'],
  'unverified-completion': ['done', 'finished', 'completed', 'deployed', 'success', 'no evidence', 'didn\u2019t check'],
  'self-graded-work': ['self', 'grade', 'approve', 'own', 'passed', 'verified by itself'],
  'lost-context': ['forgot', 'memory', 'context', 'again', 'rebuilt', 'instructions', 're-ask'],
  'unsafe-tool-call': ['destructive', 'rm ', 'delete', 'drop', 'policy', 'approval', 'secret'],
  'incident-no-timeline': ['incident', 'timeline', 'post-mortem', 'what happened', 'logs', 'no record'],
  'wrong-math': ['math', 'arithmetic', 'calculate', '2+3', 'wrong answer', 'number'],
  'security-ticket-fiction': ['security', 'vulnerability', 'finding', 'cve', 'exploit', 'false positive'],
  'agents-overwrite-each-other': ['overwrite', 'conflict', 'another agent', 'clobber', 'same file'],
  'loop-forever': ['loop', 'forever', 'stuck', 'same step', 'no progress', 'infinite'],
}

export function classifyError(input) {
  const status = input.status
  const msg = (input.message || '').toLowerCase()
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 400 || status === 422) return 'validation'
  if (status === 429) return 'rate_limit'
  if (status === 408 || msg.includes('timeout') || msg.includes('aborted')) return 'timeout'
  if (status && status >= 500) return 'transient'
  if (msg.includes('econnreset') || msg.includes('econnrefused') || msg.includes('network')) return 'transient'
  if (status && status >= 400 && status < 500) return 'permanent'
  return 'unknown'
}

export function matchFailure(input) {
  const text = `${input.symptom || ''} ${input.error || ''}`.toLowerCase()
  const category = input.category?.toLowerCase()
  const scored = []

  for (const p of FAILURE_PATTERNS) {
    if (category && p.category !== category) continue
    const terms = SYMPTOM_TERMS[p.id] || []
    const matchedTerms = terms.filter((t) => text.includes(t))
    if (matchedTerms.length > 0) {
      scored.push({ pattern: p, score: matchedTerms.length, matchedTerms })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, 3)
  return { product: 'reliabilitylane', version: RELIABILITYLANE_VERSION, matches: top, count: top.length }
}

export function planRetry(input) {
  const classification = input.kind || classifyError(input)
  const strategy = RETRY_STRATEGIES.find((s) => s.plan.retryOn.includes(classification)) || null
  if (!strategy) {
    return {
      product: 'reliabilitylane',
      version: RELIABILITYLANE_VERSION,
      strategy: null,
      classification,
      shouldRetry: false,
      nextDelayMs: null,
      reason: `non_retriable_${classification}`,
    }
  }
  const { maxAttempts, baseDelayMs, maxDelayMs, jitter } = strategy.plan
  const attempt = 1
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1))
  const nextDelayMs = jitter ? Math.min(maxDelayMs, exp + Math.floor(Math.random() * Math.max(1, exp * 0.25))) : exp
  return {
    product: 'reliabilitylane',
    version: RELIABILITYLANE_VERSION,
    strategy,
    classification,
    shouldRetry: attempt < maxAttempts,
    nextDelayMs: attempt < maxAttempts ? nextDelayMs : null,
    reason: attempt < maxAttempts ? `retry_${classification}_after_${nextDelayMs}ms` : 'max_attempts_reached',
  }
}

export function verify(input) {
  const checklist =
    (input.checklist && VERIFICATION_CHECKLISTS.find((c) => c.id === input.checklist)) ||
    (input.area && VERIFICATION_CHECKLISTS.find((c) => c.area === input.area)) ||
    null
  if (!checklist) {
    return {
      product: 'reliabilitylane',
      version: RELIABILITYLANE_VERSION,
      checklist: null,
      passed: [],
      pending: [],
      failed: [],
      verdict: 'incomplete',
    }
  }
  const evidence = input.evidence || {}
  const passed = []
  const pending = []
  const failed = []
  for (const check of checklist.checks) {
    const found = Object.keys(evidence).some((k) => check.toLowerCase().includes(k.toLowerCase()))
    if (evidence[check] === false) failed.push(check)
    else if (found || evidence[check] === true) passed.push(check)
    else pending.push(check)
  }
  const verdict = failed.length > 0 ? 'fail' : passed.length === checklist.checks.length ? 'pass' : 'incomplete'
  return { product: 'reliabilitylane', version: RELIABILITYLANE_VERSION, checklist, passed, pending, failed, verdict }
}

export function incidentFor(input) {
  const text = `${input.symptom || ''} ${input.error || ''}`.toLowerCase()
  if (text.includes('deploy') || text.includes('health') || text.includes('rollback')) {
    return { playbook: { id: 'deploy-failed', name: 'Deploy Failed' }, classification: 'deploy' }
  }
  if (text.includes('outage') || text.includes('down') || text.includes('uptime') || text.includes('users')) {
    return { playbook: { id: 'outage-detected', name: 'Outage Detected' }, classification: 'outage' }
  }
  if (text.includes('policy') || text.includes('blocked') || text.includes('destructive') || text.includes('dangerous')) {
    return { playbook: { id: 'bad-tool-call', name: 'Dangerous Tool Call Caught' }, classification: 'tool_call' }
  }
  return { playbook: null, classification: 'unknown' }
}

export function getReliabilityLanePricing() {
  return {
    product: 'reliabilitylane',
    version: RELIABILITYLANE_VERSION,
    credits: {
      'reliabilitylane.patterns': 1,
      'reliabilitylane.retry': 1,
      'reliabilitylane.verify': 1,
      'reliabilitylane.incident': 2,
      'reliabilitylane.antipatterns': 1,
    },
    note: 'Curated reliability patterns for agents. Deterministic dataset, no LLM.',
  }
}

export function getReliabilityLaneCapabilities() {
  return {
    product: 'reliabilitylane',
    version: RELIABILITYLANE_VERSION,
    datasets: {
      failure_patterns: FAILURE_PATTERNS.length,
      retry_strategies: RETRY_STRATEGIES.length,
      verification_checklists: VERIFICATION_CHECKLISTS.length,
      incident_playbooks: INCIDENT_PLAYBOOKS.length,
      anti_patterns: ANTI_PATTERNS.length,
    },
    endpoints: [
      'GET /v1/reliabilitylane/health',
      'GET /v1/reliabilitylane/pricing',
      'GET /v1/reliabilitylane/capabilities',
      'GET /v1/reliabilitylane/patterns',
      'GET /v1/reliabilitylane/patterns/:id',
      'POST /v1/reliabilitylane/match',
      'GET /v1/reliabilitylane/retries',
      'POST /v1/reliabilitylane/retry-plan',
      'GET /v1/reliabilitylane/checklists',
      'POST /v1/reliabilitylane/verify',
      'GET /v1/reliabilitylane/playbooks',
      'POST /v1/reliabilitylane/incident',
      'GET /v1/reliabilitylane/antipatterns',
    ],
  }
}
