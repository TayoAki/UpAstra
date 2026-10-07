import type { CopyField, ServiceTemplate } from "./types";

/** Standard grant sections. Funders' RFPs override the word limits. */
export const GRANT_SECTIONS: Record<"full" | "loi", CopyField[]> = {
  full: [
    { key: "summary", label: "Executive summary", maxWords: 250, minWords: 80 },
    { key: "need", label: "Statement of need", maxWords: 500, minWords: 120 },
    { key: "program", label: "Program description", maxWords: 600, minWords: 150 },
    { key: "objectives", label: "Goals & measurable objectives", maxWords: 300, minWords: 60 },
    { key: "evaluation", label: "Evaluation plan", maxWords: 300, minWords: 60 },
    { key: "organization", label: "Organizational capacity", maxWords: 300, minWords: 60 },
    { key: "budget", label: "Budget narrative", maxWords: 300, minWords: 50 },
    { key: "sustainability", label: "Sustainability", maxWords: 200, minWords: 40 },
  ],
  loi: [
    { key: "intro", label: "Introduction & request", maxWords: 150, minWords: 40 },
    { key: "need", label: "Need", maxWords: 200, minWords: 50 },
    { key: "program", label: "Program & outcomes", maxWords: 250, minWords: 60 },
    { key: "organization", label: "About the organization", maxWords: 150, minWords: 40 },
  ],
};

// Service templates are the firm's product catalog. Swapping the template —
// buyer, deliverables, production recipe, rulebook and approval points —
// produces a different firm on the same operating system.
export const SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    id: "product-still-pack",
    name: "Product Still Pack",
    buyer: "DTC & Amazon sellers",
    description: "Campaign-ready lifestyle stills of one SKU from a clean product reference.",
    basePrice: 150,
    turnaroundDays: 2,
    deliverables: [
      { id: "hero-still", label: "Hero lifestyle still", kind: "image", format: "png", aspect: "3:4", quantity: 1 },
      { id: "alt-stills", label: "Alternate scenes", kind: "image", format: "png", aspect: "1:1", quantity: 2 },
    ],
    recipe: [
      { id: "explore", label: "Explore scene directions", kind: "image", intent: "explore", preserve: "none", lane: "explore-image", units: 6 },
      { id: "hero", label: "Render hero still", deliverableId: "hero-still", kind: "image", intent: "final", preserve: "product", lane: "product", units: 1 },
      { id: "alts", label: "Render alternate scenes", deliverableId: "alt-stills", kind: "image", intent: "final", preserve: "product", lane: "product", units: 2 },
      { id: "upscale", label: "Upscale for delivery", kind: "image", intent: "finish", preserve: "product", lane: "finishing", units: 1 },
    ],
    rulebook: [
      "Product label text matches the reference exactly",
      "Brand colors within tolerance of the supplied palette",
      "Requested aspect ratio and file format",
      "No rejected styles from client memory",
      "No unapproved claims in any visible copy",
    ],
    approvalPoints: ["Final delivery"],
  },
  {
    id: "launch-video",
    name: "Product Launch Video",
    buyer: "Brands launching a SKU",
    description: "Short vertical launch spot: cheap motion tests, then one planned hero shot.",
    basePrice: 400,
    turnaroundDays: 4,
    deliverables: [
      { id: "launch-spot", label: "Launch spot", kind: "video", format: "mp4", aspect: "9:16", durationSec: 5, quantity: 1 },
      { id: "key-still", label: "Key still / thumbnail", kind: "image", format: "png", aspect: "9:16", quantity: 1 },
    ],
    recipe: [
      { id: "key", label: "Product key frame", deliverableId: "key-still", kind: "image", intent: "final", preserve: "product", lane: "product", units: 1 },
      { id: "tests", label: "Motion tests (hooks & camera)", kind: "video", intent: "explore", preserve: "none", lane: "explore-video", units: 15 },
      { id: "hero", label: "Hero shot", deliverableId: "launch-spot", kind: "video", intent: "final", preserve: "product", lane: "hero-video", units: 5 },
      { id: "export", label: "Captions & export", kind: "video", intent: "finish", preserve: "words", lane: "finishing", units: 1 },
    ],
    rulebook: [
      "Duration matches the brief",
      "Product stays recognizable in every frame",
      "Exact copy appears as written",
      "Vertical 9:16 delivery",
      "Motion feels physically plausible — no warping",
    ],
    approvalPoints: ["Production start over auto limit", "Final delivery"],
  },
  {
    id: "always-on-ads",
    name: "Always-On Ad Pack (weekly)",
    buyer: "E-commerce brands with tired creative",
    description: "Weekly batch for one SKU: hooks from customer language, 20 cheap angles, the best few finished.",
    basePrice: 900,
    turnaroundDays: 5,
    deliverables: [
      { id: "static-ads", label: "Static ads", kind: "image", format: "png", aspect: "4:5", quantity: 4 },
      { id: "short-videos", label: "Short video ads", kind: "video", format: "mp4", aspect: "9:16", durationSec: 6, quantity: 2 },
    ],
    recipe: [
      { id: "angles", label: "Explore 20 angles", kind: "image", intent: "explore", preserve: "none", lane: "explore-image", units: 20 },
      { id: "statics", label: "Product-consistent statics", deliverableId: "static-ads", kind: "image", intent: "final", preserve: "product", lane: "product", units: 4 },
      { id: "copyfix", label: "Packaging / copy repair", kind: "image", intent: "repair", preserve: "words", lane: "repair", units: 2 },
      { id: "vtests", label: "Movement tests", kind: "video", intent: "explore", preserve: "none", lane: "explore-video", units: 12 },
      { id: "videos", label: "Premium video ads", deliverableId: "short-videos", kind: "video", intent: "final", preserve: "product", lane: "hero-video", units: 12 },
    ],
    rulebook: [
      "Label and pack colors match source photography",
      "Only approved claims appear",
      "Each ad uses a distinct hook",
      "Required formats: 4:5 statics, 9:16 video",
    ],
    approvalPoints: ["Weekly batch delivery"],
  },
  {
    id: "franchise-localization",
    name: "Franchise Localization Desk",
    buyer: "Franchise brands with 20–200 locations",
    description: "Turns an approved national campaign into per-location versions: address, price, offer, language.",
    basePrice: 500,
    turnaroundDays: 3,
    deliverables: [
      { id: "local-posters", label: "Localized posters", kind: "image", format: "png", aspect: "4:5", quantity: 5 },
      { id: "local-vo", label: "Localized spokesperson cut", kind: "video", format: "mp4", aspect: "9:16", durationSec: 8, quantity: 1 },
    ],
    recipe: [
      { id: "layouts", label: "Localize layouts & copy", deliverableId: "local-posters", kind: "image", intent: "final", preserve: "words", lane: "typography", units: 5 },
      { id: "fixes", label: "Headline / price repairs", kind: "image", intent: "repair", preserve: "words", lane: "repair", units: 2 },
      { id: "vo", label: "Language version", deliverableId: "local-vo", kind: "video", intent: "final", preserve: "person", lane: "speech", units: 8 },
      { id: "lipsync", label: "Lip sync pass", kind: "video", intent: "finish", preserve: "person", lane: "finishing", units: 8 },
    ],
    rulebook: [
      "Every address, price, offer and phone number matches the location sheet",
      "Disclaimer present and verbatim",
      "Master campaign art direction unchanged",
      "Language version matches approved script",
    ],
    approvalPoints: ["Pilot delivery", "Any new language"],
  },
  {
    id: "industrial-sku-pack",
    name: "Industrial SKU Sales Pack",
    buyer: "Manufacturers with dense spec sheets",
    description: "One SKU → demo video, application scene, trade-show loop and sales graphics, checked against specs.",
    basePrice: 1500,
    turnaroundDays: 7,
    deliverables: [
      { id: "demo", label: "Product demo", kind: "video", format: "mp4", aspect: "16:9", durationSec: 10, quantity: 1 },
      { id: "application", label: "Application scene", kind: "image", format: "png", aspect: "16:9", quantity: 2 },
      { id: "spec-graphic", label: "Spec sales graphic", kind: "image", format: "png", aspect: "16:9", quantity: 2 },
    ],
    recipe: [
      { id: "scenes", label: "Product in real environments", deliverableId: "application", kind: "image", intent: "final", preserve: "product", lane: "product", units: 2 },
      { id: "graphics", label: "Spec graphics", deliverableId: "spec-graphic", kind: "image", intent: "final", preserve: "words", lane: "typography", units: 2 },
      { id: "demo", label: "Cinematic demo sequence", deliverableId: "demo", kind: "video", intent: "final", preserve: "product", lane: "cinematic", units: 10 },
      { id: "upscale", label: "Upscale & export", kind: "video", intent: "finish", preserve: "product", lane: "finishing", units: 1 },
    ],
    rulebook: [
      "Every dimension, feature and compatibility claim matches the spec sheet",
      "Safety statements verbatim",
      "Product geometry matches CAD / reference",
      "No unapproved performance claims",
    ],
    approvalPoints: ["Spec claim review", "Final delivery"],
  },
  {
    id: "cold-email-sequence",
    name: "Cold Email Sequence",
    buyer: "B2B founders, SDR teams, agencies running outbound",
    description: "A personalized outbound sequence: angle exploration, then a coherent multi-touch sequence that passes deliverability and length rules.",
    basePrice: 250,
    turnaroundDays: 2,
    deliverables: [
      {
        id: "sequence",
        label: "Email sequence",
        kind: "text",
        format: "md",
        aspect: "—",
        quantity: 4,
        copy: {
          format: "cold-email",
          fields: [
            { key: "subject", label: "Subject", maxChars: 50 },
            { key: "body", label: "Body", maxWords: 120, minWords: 40 },
          ],
          tone: "Plain, specific, peer-to-peer",
          mergeTags: ["{{first_name}}", "{{company}}", "{{title}}"],
        },
      },
    ],
    recipe: [
      { id: "angles", label: "Explore angles & hooks", kind: "text", intent: "explore", preserve: "none", lane: "copy", units: 2 },
      { id: "write", label: "Write the sequence", deliverableId: "sequence", kind: "text", intent: "final", preserve: "words", lane: "copy", units: 3 },
    ],
    rulebook: [
      "Subject lines ≤ 50 characters, no ALL CAPS or clickbait",
      "Each email body 40–120 words",
      "Exactly one clear call to action per email",
      "No spam-trigger phrases",
      "Merge tags are valid ({{first_name}}, {{company}}, {{title}})",
      "Only approved claims and proof points",
      "Each email opens with a different angle",
    ],
    approvalPoints: ["Final delivery"],
  },
  {
    id: "ad-copy-pack",
    name: "Ad Copy Pack",
    buyer: "DTC brands and media buyers",
    description: "Platform-ready ad copy variants built from customer language — distinct hooks, within character limits, claims checked.",
    basePrice: 150,
    turnaroundDays: 1,
    deliverables: [
      {
        id: "ad-variants",
        label: "Ad copy variants",
        kind: "text",
        format: "md",
        aspect: "—",
        quantity: 6,
        copy: {
          format: "ad-copy",
          platform: "Meta",
          fields: [
            { key: "headline", label: "Headline", maxChars: 40 },
            { key: "primaryText", label: "Primary text", maxChars: 125 },
            { key: "description", label: "Description", maxChars: 30 },
          ],
          tone: "Punchy, benefit-led",
        },
      },
    ],
    recipe: [
      { id: "hooks", label: "Mine hooks from customer language", kind: "text", intent: "explore", preserve: "none", lane: "copy", units: 2 },
      { id: "write", label: "Write ad variants", deliverableId: "ad-variants", kind: "text", intent: "final", preserve: "words", lane: "copy", units: 2 },
    ],
    rulebook: [
      "Every field within the platform's character limit",
      "Each variant uses a distinct hook",
      "Clear call to action in each variant",
      "No spam-trigger phrases or ALL CAPS",
      "Only approved claims",
    ],
    approvalPoints: ["Final delivery"],
  },
  {
    id: "grant-proposal",
    name: "Nonprofit Grant Proposal",
    buyer: "Nonprofits, development directors, grant consultants",
    description:
      "Funder-ready proposal narrative built from the org's own facts: aligned to the funder's priorities, within every section limit, every number traceable to a source.",
    basePrice: 600,
    turnaroundDays: 5,
    deliverables: [
      {
        id: "proposal",
        label: "Proposal narrative",
        kind: "text",
        format: "md",
        aspect: "—",
        quantity: 1,
        copy: {
          format: "grant-proposal",
          fields: GRANT_SECTIONS.full,
          tone: "Clear, evidence-based, community-centered",
        },
      },
    ],
    recipe: [
      { id: "align", label: "Map funder priorities to the program", kind: "text", intent: "explore", preserve: "none", lane: "copy", units: 3 },
      { id: "write", label: "Write the proposal narrative", deliverableId: "proposal", kind: "text", intent: "final", preserve: "words", lane: "copy", units: 6 },
    ],
    rulebook: [
      "Every required section present and within the funder's word limit",
      "Funder named and its priorities addressed",
      "Requested amount stated and consistent",
      "Every statistic traceable to the org's data or a cited source",
      "Measurable objectives (SMART) and an evaluation plan",
      "No unsupported promises or guarantees",
    ],
    approvalPoints: ["Fact & figure review", "Final delivery"],
  },
];

/** Platform character limits for ad copy. */
export const AD_PLATFORMS: Record<string, { key: string; label: string; maxChars: number }[]> = {
  Meta: [
    { key: "headline", label: "Headline", maxChars: 40 },
    { key: "primaryText", label: "Primary text", maxChars: 125 },
    { key: "description", label: "Description", maxChars: 30 },
  ],
  "Google Search": [
    { key: "headline", label: "Headline", maxChars: 30 },
    { key: "description", label: "Description", maxChars: 90 },
  ],
  LinkedIn: [
    { key: "headline", label: "Headline", maxChars: 70 },
    { key: "primaryText", label: "Intro text", maxChars: 150 },
  ],
  TikTok: [{ key: "primaryText", label: "Ad text", maxChars: 100 }],
};

export function getTemplate(id: string): ServiceTemplate {
  return SERVICE_TEMPLATES.find((t) => t.id === id) ?? SERVICE_TEMPLATES[0];
}
