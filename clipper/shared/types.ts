// Clip Operator data model. One document per workspace holds its campaigns,
// footage, clip plans, posts and activity.

export type Platform = "tiktok" | "instagram" | "youtube" | "x" | "facebook" | "snapchat" | "other";
export const PLATFORMS: Platform[] = ["tiktok", "instagram", "youtube", "x", "facebook", "snapchat", "other"];
export const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube Shorts",
  x: "X",
  facebook: "Facebook",
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
  videoUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export type PostStatus = "live" | "submitted" | "approved" | "rejected" | "paid";
export const POST_STATUSES: PostStatus[] = ["live", "submitted", "approved", "rejected", "paid"];

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
}

export interface SocialAccount {
  id: string;
  platform: Platform;
  handle: string;
  niche: string;
  followers?: number;
}

export interface Activity {
  id: string;
  at: string;
  campaignId?: string;
  kind: "campaign" | "footage" | "clip" | "post" | "account";
  message: string;
  cost?: number;
}

export interface WorkspaceDoc {
  version: 1;
  campaigns: Campaign[];
  clips: Clip[];
  posts: Post[];
  accounts: SocialAccount[];
  activity: Activity[];
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
}

export interface Me {
  user: PublicUser;
  workspace: { id: string; name: string };
}

export interface ServiceStatus {
  ai: "live" | "simulated";
  aiModel: string;
  render: "not-connected" | "connected";
  storage: "postgres" | "file";
}

export interface CampaignStats {
  clips: number;
  clipsByStatus: Record<ClipStatus, number>;
  posts: number;
  views: number;
  engagementRate: number;
  estimatedEarnings: number;
  paid: number;
  /** Earnings capped by what the whole campaign budget could pay. */
  budgetShare?: number;
}
