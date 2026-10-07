// Domain model for Studio Operator. Shared by server and client.

export type Channel = "upwork" | "fiverr" | "contra" | "direct";

export type JobStage =
  | "intake" // raw brief received, not yet analysed
  | "review" // Astra analysed it; a human must accept / reject / answer questions
  | "planned" // accepted, production route proposed
  | "production" // generations running
  | "qa" // outputs being checked / repaired
  | "approval" // QA passed — waiting for the human to approve delivery
  | "revision" // client asked for changes
  | "delivered"
  | "rejected";

export type MediaKind = "image" | "video" | "audio" | "text";

/** The four questions asked before choosing a model. */
export type StepIntent = "explore" | "final" | "repair" | "finish";
export type Preserve = "product" | "person" | "words" | "movement" | "none";
export type Lane =
  | "people" // Soul
  | "product" // Seedream, Flux
  | "typography" // Ideogram, Recraft
  | "repair" // Qwen edit
  | "explore-image" // Z-Image, marketing studio image
  | "explore-video" // Pixverse, fast Wan, low-cost Kling
  | "cinematic" // Seedance
  | "hero-video" // Kling
  | "speech" // Wan, Minimax
  | "motion-transfer" // Kling Motion Control
  | "finishing" // Topaz, lipsync, captions, export
  | "copy" // writing: drafts and finals
  | "copy-edit"; // controlled line edits that keep the rest of the copy

export interface ModelSpec {
  id: string;
  name: string;
  family: string;
  vendor: string;
  origin: string; // ISO-ish country code of the model developer
  kind: MediaKind;
  lanes: Lane[];
  /** USD list price per unit (image, second of video, or job for finishing tools). */
  price: number;
  unit: "image" | "second" | "job" | "ktok"; // ktok = 1,000 tokens (text models)
  strengths: string;
  watchOuts: string;
  quality: number; // 1–5, used to break ties for final work
}

/** A field inside one piece of copy, e.g. an email's subject or an ad's headline. */
export interface CopyField {
  key: string;
  label: string;
  maxChars?: number;
  maxWords?: number;
  minWords?: number;
}

export interface CopySpec {
  format: "cold-email" | "ad-copy" | "grant-proposal";
  funder?: string; // grants: who is being asked
  ask?: string; // grants: requested amount, e.g. "$50,000"
  platform?: string; // e.g. "Meta", "Google Search", "LinkedIn"
  fields: CopyField[];
  tone?: string;
  audience?: string;
  offer?: string;
  cta?: string;
  /** Allowed merge tags, e.g. {{first_name}}. Anything else is a broken token. */
  mergeTags?: string[];
}

/** One generated piece of copy: an email in a sequence, or one ad variant. */
export type CopyPiece = Record<string, string>;

export interface DeliverableSpec {
  id: string;
  label: string;
  kind: MediaKind;
  format: string; // png, mp4, …
  aspect: string; // 3:4, 9:16 …
  durationSec?: number;
  quantity: number;
  exactCopy?: string;
  copy?: CopySpec; // text deliverables only; quantity = number of pieces
}

export interface Deliverable extends DeliverableSpec {
  status: "pending" | "generating" | "qa" | "ready" | "needs-human" | "approved";
  outputIds: string[];
  approvedOutputId?: string;
}

export interface RecipeStep {
  id: string;
  label: string;
  deliverableId?: string;
  kind: MediaKind;
  intent: StepIntent;
  preserve: Preserve;
  lane: Lane;
  units: number; // images, seconds of video, or 1 for a finishing job
  modelId: string; // chosen by router
  routedBy: "astra" | "human";
  rationale: string;
  attempts: number;
  status: "pending" | "running" | "done" | "failed" | "blocked";
  feedback?: string; // client revision notes applied on the next run
}

export interface ServiceTemplate {
  id: string;
  name: string;
  buyer: string;
  description: string;
  basePrice: number;
  turnaroundDays: number;
  deliverables: DeliverableSpec[];
  recipe: Omit<RecipeStep, "modelId" | "routedBy" | "rationale" | "attempts" | "status">[];
  rulebook: string[]; // concrete definitions of "correct" for QA
  approvalPoints: string[];
}

export interface IntakeAnalysis {
  summary: string;
  templateId: string;
  deliverables: DeliverableSpec[];
  exactCopy: string[];
  deadline?: string;
  suppliedAssets: string[];
  missingInputs: string[];
  risks: string[];
  revisionRisks: string[];
  clientQuestions: string[];
  recommendation: "accept" | "review" | "reject";
  reasoning: string;
  source: "astra" | "simulated";
}

export interface Economics {
  price: number;
  channelFeePct: number;
  channelFee: number;
  productionEstimate: number;
  repairReserve: number;
  actualSpend: number;
  expectedProfit: number;
  expectedMargin: number; // 0..1
  meetsMinimum: boolean;
}

export interface Generation {
  id: string;
  jobId: string;
  stepId: string;
  deliverableId?: string;
  modelId: string;
  prompt: string;
  attempt: number;
  purpose: "generate" | "edit" | "regenerate" | "finish";
  status: "queued" | "running" | "completed" | "failed";
  providerRequestId?: string;
  estimatedCost: number;
  actualCost?: number;
  outputUrl?: string;
  copy?: CopyPiece[]; // text generations
  error?: string;
  createdAt: string;
  completedAt?: string;
  qa?: QAResult;
}

export type QAVerdict = "ready" | "edit" | "regenerate" | "human";

export interface QACheck {
  rule: string;
  pass: boolean;
  note?: string;
}

export interface QAResult {
  verdict: QAVerdict;
  score: number; // 0–100
  checks: QACheck[];
  summary: string;
  source: "astra" | "simulated";
  fixes?: string[]; // actionable fixes for an editor pass (copy)
}

export interface Checkpoint {
  id: string;
  kind:
    | "accept-job"
    | "client-questions"
    | "start-production"
    | "budget-limit"
    | "scope-change"
    | "final-delivery"
    | "qa-escalation"
    | "client-message";
  title: string;
  detail: string;
  status: "open" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  payload?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  jobId?: string;
  at: string;
  actor: "astra" | "human" | "system" | "higgsfield" | "agent"; // agent = external MCP client (Claude, Astra, …)
  type:
    | "intake"
    | "decision"
    | "route"
    | "generation"
    | "cost"
    | "qa"
    | "repair"
    | "approval"
    | "message"
    | "policy"
    | "memory"
    | "delivery";
  message: string;
  cost?: number;
}

export interface ClientMessage {
  id: string;
  at: string;
  direction: "inbound" | "outbound";
  body: string;
  status: "draft" | "sent" | "received";
  classification?: "routine" | "scope-change" | "question" | "approval";
}

export interface Job {
  id: string;
  title: string;
  clientId: string;
  channel: Channel;
  sourceUrl?: string;
  rawBrief: string;
  referenceAssets: string[];
  clientNotes: string;
  templateId: string;
  stage: JobStage;
  price: number;
  productionBudget?: number; // optional per-job cap set by the operator
  deadline?: string;
  analysis?: IntakeAnalysis;
  deliverables: Deliverable[];
  steps: RecipeStep[];
  checkpoints: Checkpoint[];
  messages: ClientMessage[];
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
  running?: boolean;
}

export interface ClientMemory {
  id: string;
  name: string;
  contact: string;
  logo: string;
  colors: string[];
  fonts: string[];
  likes: string[];
  rejectedStyles: string[];
  approvedClaims: string[];
  notes: string;
}

export interface Lesson {
  id: string;
  at: string;
  jobId?: string;
  clientId?: string;
  category: "missing-input" | "model" | "margin" | "qa" | "revision";
  text: string;
}

export interface AutonomyPolicy {
  maxSpendPerJob: number;
  maxRepairSpendPerJob: number;
  maxRepairCostPerAttempt: number;
  maxAttemptsPerStep: number;
  minGrossMargin: number; // 0..1
  autoStartBelowCost: number; // production estimates under this start without a human gate
  blockedFamilies: string[];
  blockedOrigins: string[];
  clientMessages: "draft-only" | "auto-send-routine";
  requireApproval: {
    acceptJob: boolean;
    finalDelivery: boolean; // always true in practice; kept visible
    scopeChange: boolean;
  };
  channelFees: Record<Channel, number>;
  repairReservePct: number;
  /** Checkpoint kinds an external agent (via MCP) may resolve. Final delivery is never allowed. */
  agentMayResolve: Checkpoint["kind"][];
}

export interface FirmStats {
  activeJobs: number;
  pipelineValue: number;
  estimatedGrossProfit: number;
  needsAttention: number;
  deliveredRevenue: number;
  spendToDate: number;
}

export interface ProviderStatus {
  astra: { mode: "live" | "simulated"; model: string };
  higgsfield: { mode: "live" | "simulated"; baseUrl: string };
}
