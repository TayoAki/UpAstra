import type { BrandKit, CaptionOverrides } from "./caption-styles";
// UGCMediaClips data model. One document per workspace holds its campaigns,
// footage, clip plans, posts and activity.

export type Platform = "tiktok" | "instagram" | "youtube" | "x" | "facebook" | "threads" | "linkedin" | "bluesky" | "snapchat" | "other";
export const PLATFORMS: Platform[] = ["tiktok", "instagram", "youtube", "x", "facebook", "threads", "linkedin", "bluesky", "snapchat", "other"];
export const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube Shorts",
  x: "X",
  facebook: "Facebook",
  threads: "Threads",
  linkedin: "LinkedIn",
  bluesky: "Bluesky",
  snapchat: "Snapchat",
  other: "Other",
};

export interface Payout {
  /** Total campaign budget shared by every clipper (USD). */
  budget?: number;
  /** Paid per 1,000 views (USD). */
  cpm?: number;
  /** Cap per submission (USD). */
  maxPerSubmission?: number;
  /** Views a post needs before it pays out. */
  minViews?: number;
  currency: string;
}

export interface LinkRef {
  label: string;
  url: string;
}

/** Everything a clipper needs from a brief, extracted into fields. */
export interface CampaignBrief {
  title: string;
  brand: string;
  product: string;
  productUrl?: string;
  summary: string;
  goal: string;
  platforms: Platform[];
  /** Words or names that must be spoken (or shown) in every clip. */
  requiredPhrases: string[];
  cta: { text: string; placement: "end" | "anywhere" };
  hookExamples: string[];
  contentIdeas: string[];
  /** Facts about the product clips may state. Anything else is invention. */
  keyFacts: string[];
  dos: string[];
  donts: string[];
  /** Claims that get a clip rejected. */
  bannedClaims: string[];
  accountRequirements: string[];
  /** e.g. 0.01 for "at least 1% engagement". */
  minEngagementRate?: number;
  lengthSec: { min: number; max: number };
  payout: Payout;
  footage: LinkRef[];
  otherLinks: LinkRef[];
  deadline?: string;
}

export type CampaignStatus = "active" | "paused" | "ended";

/** A highlight found in a footage file by the vision model. */
export interface Moment {
  start: number;
  end: number;
  type: "goal" | "save" | "near-miss" | "boost" | "funny" | "reveal" | "menu" | "other";
  description: string;
  score: number;
}

export interface FootageFile {
  id: string;
  /** Provider id (e.g. the Google Drive file id). */
  sourceId: string;
  name: string;
  kind: "video" | "image" | "folder" | "other";
  mime?: string;
  viewUrl: string;
  thumbUrl?: string;
  folderUrl: string;
  folderLabel: string;
  /** Set when the file lives in our storage: an upload, or a copy the user supplied for a link. */
  storageKey?: string;
  sizeBytes?: number;
  /** Filled in when the file is analyzed for moments. */
  durationSec?: number;
  hasAudio?: boolean;
  moments?: Moment[];
  analyzedAt?: string;
  analysisError?: string;
}

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  source: { kind: "text" | "gdoc" | "url"; url?: string; text: string };
  brief: CampaignBrief;
  extractedBy: "ai" | "rules";
  extractionModel?: string;
  footage: FootageFile[];
  footageCheckedAt?: string;
  footageError?: string;
  notes: string;
  /** This campaign's caption style (else the brand kit's, else the default). */
  captions?: CaptionOverrides;
  createdAt: string;
  updatedAt: string;
}

export interface QACheck {
  rule: string;
  pass: boolean;
  note?: string;
}

export type ClipStatus = "draft" | "approved" | "rendering" | "ready" | "posted" | "rejected";
export const CLIP_STATUSES: ClipStatus[] = ["draft", "approved", "rendering", "ready", "posted", "rejected"];

/** One planned short: the hook, the narration and the shots, before render. */
export interface Clip {
  id: string;
  campaignId: string;
  title: string;
  angle: string;
  hook: string;
  /** Voiceover, spoken start to finish. */
  narration: string;
  onScreenText: string[];
  cta: string;
  /** Which footage to cut from, with what to look for. */
  shots: { footageId?: string; footageName?: string; moment: string; seconds: number }[];
  lengthSec: number;
  caption: string;
  hashtags: string[];
  status: ClipStatus;
  qa: { pass: boolean; checks: QACheck[] };
  model: string;
  cost: number;
  render?: RenderInfo;
  /** What the learning system compares across posts. */
  traits?: ClipTraits;
  createdAt: string;
  updatedAt: string;
}

export type HookStyle = "question" | "challenge" | "bold-claim" | "pov" | "reveal" | "how-to" | "story" | "number" | "other";
export const HOOK_STYLES: { id: HookStyle; label: string; example: string }[] = [
  { id: "question", label: "Question", example: "Can you score from the wall?" },
  { id: "challenge", label: "Challenge", example: "I challenged my friend to car soccer" },
  { id: "bold-claim", label: "Bold claim", example: "This is the best soccer game on Roblox" },
  { id: "pov", label: "POV", example: "POV: you finally hit the wall shot" },
  { id: "reveal", label: "Reveal / curiosity", example: "Someone made Rocket League in Roblox…" },
  { id: "how-to", label: "How-to / tip", example: "How to win every kickoff" },
  { id: "story", label: "Story", example: "I was down 3-0 and then this happened" },
  { id: "number", label: "Number / list", example: "3 shots every new player should learn" },
  { id: "other", label: "Other", example: "" },
];

export type ClipFormat = "montage" | "single-moment" | "explainer";

export interface ClipTraits {
  hookStyle: HookStyle;
  format: ClipFormat;
  /** Moment type the clip opens on (from the render), e.g. "goal". */
  opening?: string;
  voice?: VoiceOption;
  /** Planned to repeat a proven pattern, or to test something new. */
  strategy?: "proven" | "test";
}

export type VoiceOption = "none" | "alloy" | "ash" | "ballad" | "coral" | "echo" | "sage" | "shimmer" | "verse";
export const VOICES: { id: VoiceOption; label: string }[] = [
  { id: "ash", label: "Ash — warm, upbeat" },
  { id: "echo", label: "Echo — clear, neutral" },
  { id: "coral", label: "Coral — bright, friendly" },
  { id: "verse", label: "Verse — energetic" },
  { id: "sage", label: "Sage — calm" },
  { id: "alloy", label: "Alloy — balanced" },
  { id: "ballad", label: "Ballad — expressive" },
  { id: "shimmer", label: "Shimmer — light" },
  { id: "none", label: "No voice — captions only (record your own)" },
];

export type RenderStatus = "queued" | "analyzing" | "voicing" | "rendering" | "done" | "failed";

/** One render of a clip plan into a finished 9:16 video. */
export interface RenderInfo {
  status: RenderStatus;
  step: string;
  voice: VoiceOption;
  requestedAt: string;
  finishedAt?: string;
  error?: string;
  cost: number;
  videoKey?: string;
  durationSec?: number;
  sizeBytes?: number;
  /** Where each shot was cut from. */
  segments?: { footageName: string; start: number; seconds: number; moment?: string }[];
  /** The pieces of this render, kept so the editor can open it as a timeline. */
  parts?: EditParts;
  /** "aligned": captions timed word by word from the voiceover; "estimated": spread over the speech. */
  captionTiming?: "aligned" | "estimated";
  /** Spoken language detected in the voiceover (ISO 639-1). */
  language?: string;
  /** How long the voiceover actually speaks (voiced renders). */
  spokenSec?: number;
  /** Set when the current video was exported from the editor. */
  editedAt?: string;
}

export interface EditParts {
  /** 9:16 shots in order (already framed, with game audio). */
  shots: { key: string; seconds: number }[];
  voiceKey?: string;
  captions: { text: string; start: number; end: number; words: { text: string; start: number; end: number }[] }[];
  hook: { text: string; end: number };
  cta: { text: string; from: number };
  duration: number;
}

export type PostStatus = "scheduled" | "live" | "submitted" | "approved" | "rejected" | "paid" | "failed";
export const POST_STATUSES: PostStatus[] = ["scheduled", "live", "submitted", "approved", "rejected", "paid", "failed"];

export interface PostMetrics {
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

/** A clip published to an account and (usually) submitted to the campaign. */
export interface Post {
  id: string;
  campaignId: string;
  clipId?: string;
  platform: Platform;
  account: string;
  url: string;
  postedAt: string;
  status: PostStatus;
  metrics: PostMetrics;
  metricsUpdatedAt?: string;
  /** What the campaign actually paid, once known. */
  paidAmount?: number;
  notes: string;
  /** Every metrics update, so posts can be compared at the same age. */
  history?: (PostMetrics & { at: string })[];
  /** Published through Outstand: its post id, the connected account, and how it went. */
  outstand?: { postId: string; accountId: string; scheduledAt?: string; error?: string; metricsSyncedAt?: string };
}

export interface SocialAccount {
  id: string;
  platform: Platform;
  handle: string;
  niche: string;
  followers?: number;
  /** Connected through Outstand (can be posted to and scheduled). */
  outstandId?: string;
  avatarUrl?: string;
  /** The platform asked for the account to be reconnected. */
  needsReconnect?: boolean;
}

export interface Activity {
  id: string;
  at: string;
  campaignId?: string;
  kind: "campaign" | "footage" | "clip" | "post" | "account" | "learning";
  message: string;
  /** Set when an agent (API key / MCP) did it. */
  actor?: "agent";
  cost?: number;
}

export interface WorkspaceDoc {
  version: 1;
  campaigns: Campaign[];
  clips: Clip[];
  posts: Post[];
  accounts: SocialAccount[];
  activity: Activity[];
  /** Written findings from the learning system, keyed by scope ("all" or a campaign id). */
  insights?: Record<string, Insights>;
  /** Conversations with the in-app Clipping Agent. */
  agentRuns?: AgentRun[];
  /** Videos captioned on the Captions page. */
  captionJobs?: CaptionJob[];
  /** Fonts, colours and default caption style for everything this workspace renders. */
  brand?: BrandKit;
  /** What this workspace has used: AI spend, renders, captions, posts. */
  usage?: WorkspaceUsage;
}

/** Where AI money goes. */
export type AIKind = "extract" | "script" | "moments" | "voice" | "agent" | "editor";

export interface MonthUsage {
  /** Dollars and calls per kind of AI work, as billed by the provider. */
  ai: Partial<Record<AIKind, { usd: number; calls: number }>>;
  renders: number;
  renderSec: number;
  captionJobs: number;
  captionSec: number;
  posts: number;
}

export interface UsageCost {
  ai: number;
  compute: number;
  posts: number;
  total: number;
}

/** GET /api/usage */
export interface UsageReport {
  today: { usd: number; calls: number; budget: number; callLimit: number };
  months: { month: string; usage: MonthUsage; cost: UsageCost }[];
  rates: { renderSec: number; captionSec: number; post: number };
}

/** GET /api/admin/usage: every workspace, for the operator. */
export interface AdminUsage {
  month: string;
  workspaces: { id: string; name: string; email: string; createdAt: string; usage: MonthUsage; cost: UsageCost }[];
  total: UsageCost;
}

export interface WorkspaceUsage {
  /** Today (UTC): AI dollars and calls, for the daily caps. */
  day: string;
  dayUsd: number;
  dayCalls: number;
  /** Keyed by "YYYY-MM". */
  months: Record<string, MonthUsage>;
}

// ---------------------------------------------------------------------------
// Learning

export type Confidence = "too-early" | "early-signal" | "solid";

/** How one trait value (e.g. hook style "challenge") has performed. */
export interface TraitStat {
  value: string;
  label: string;
  posts: number;
  /** Median views of its posts at comparable age. */
  medianViews: number;
  /** Average performance vs. each post's account baseline (1 = normal, 2 = twice normal), shrunk toward 1 when data is thin. */
  lift: number;
  confidence: Confidence;
}

export interface LearningReport {
  scope: string;
  posts: number;
  /** Posts old enough (≥ 24h) to count. */
  maturePosts: number;
  dimensions: { id: string; label: string; stats: TraitStat[] }[];
  topHooks: { hook: string; views: number; lift: number; platform: Platform; postId: string; campaignId: string }[];
  playbook: Playbook;
}

/** What the planner should lean on, avoid and test next. */
export interface Playbook {
  proven: { dimension: string; value: string; label: string; lift: number; posts: number }[];
  weak: { dimension: string; value: string; label: string; lift: number; posts: number }[];
  untested: { dimension: string; value: string; label: string }[];
  winningHooks: string[];
}

export interface Insights {
  generatedAt: string;
  basedOnPosts: number;
  findings: string[];
  doMore: string[];
  stopDoing: string[];
  testNext: string[];
  model: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
}

export interface Me {
  user: PublicUser & { admin?: boolean };
  workspace: { id: string; name: string; hasAgentKey?: boolean };
}

export interface ServiceStatus {
  ai: "live" | "simulated";
  aiModel: string;
  render: "not-connected" | "connected";
  voice: "live" | "off";
  storage: "postgres" | "file";
  /** The OpenReel editor is installed at /editor/. */
  editor?: boolean;
  /** Speech-to-text for captions is installed. */
  captions?: boolean;
  /** Scheduling and publishing through Outstand is set up. */
  publishing?: boolean;
}

export interface CampaignStats {
  clips: number;
  clipsByStatus: Record<ClipStatus, number>;
  posts: number;
  /** Waiting to go out (Outstand). */
  scheduled: number;
  views: number;
  engagementRate: number;
  estimatedEarnings: number;
  paid: number;
  /** Earnings capped by what the whole campaign budget could pay. */
  budgetShare?: number;
}

// ---------------------------------------------------------------------------
// Captions page: caption any video with speech

export type CaptionJobStatus = "uploaded" | "transcribing" | "ready" | "rendering" | "done" | "failed";

export interface CaptionJob {
  id: string;
  name: string;
  status: CaptionJobStatus;
  step?: string;
  error?: string;
  sourceKey: string;
  width?: number;
  height?: number;
  durationSec?: number;
  /** "auto" or an ISO 639-1 code chosen by the user. */
  languageHint: string;
  /** Names and terms to spell right (passed to the recognizer as a hint). */
  glossary?: string[];
  /** Detected (or chosen) spoken language. */
  language?: string;
  joiner?: "" | " ";
  /** Every spoken word with its time. Editing a word keeps its timing. */
  words: { text: string; start: number; end: number }[];
  captions: import("./caption-styles").CaptionOverrides;
  outputKey?: string;
  renderedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Clipping Agent (in-app chat)

export type AgentRunStatus = "running" | "waiting" | "done" | "failed" | "stopped";

/** One step the agent took, for display. */
export interface AgentStep {
  id: string;
  kind: "user" | "assistant" | "tool";
  text?: string;
  tool?: string;
  args?: Record<string, unknown>;
  /** Short result shown under the step. */
  result?: string;
  error?: boolean;
  at: string;
}

export interface AgentRun {
  id: string;
  title: string;
  status: AgentRunStatus;
  steps: AgentStep[];
  /** A tool call waiting for the user's OK (publishing). */
  pending?: { stepId: string; tool: string; args: Record<string, unknown>; callId: string };
  error?: string;
  cost: number;
  model?: string;
  createdAt: string;
  updatedAt: string;
}
