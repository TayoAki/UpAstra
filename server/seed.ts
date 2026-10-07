import type { ClientMemory, Job } from "../shared/types";
import { setAstraSimulated } from "./astra";
import { simulatedProvider } from "./higgsfield";
import { createJob, receiveClientMessage, resolveCheckpoint, settle, useProvider, type NewJobInput } from "./pipeline";
import { getDB, save } from "./store";

// Demo data: a small book of clients and jobs at every stage. Always produced
// with the free simulators, even when live keys are configured.

const CLIENTS: ClientMemory[] = [
  {
    id: "cl_sanguine",
    name: "Sanguine Aperitivo",
    contact: "Giulia Ferri",
    logo: "Wordmark 'SANGUINE' in a serif italic, red on cream",
    colors: ["#7a1020", "#f26b3a", "#fde7d6"],
    fonts: ["Canela Italic", "Söhne"],
    likes: ["Sun-drenched Mediterranean terraces", "Hard shadows, high contrast", "Citrus slices and condensation"],
    rejectedStyles: ["Neon nightclub lighting", "Cartoon or 3D-render look"],
    approvedClaims: ["Made with Sicilian blood oranges", "Low ABV"],
    notes: "Launching a blood orange aperitif this spring. Prefers fast iterations on low budgets.",
  },
  {
    id: "cl_moro",
    name: "Moro Coffee",
    contact: "Sam Okafor",
    logo: "Round stamp mark with a coffee cherry, espresso brown",
    colors: ["#3b2417", "#c8894b", "#f4ead8"],
    fonts: ["GT Alpina", "Inter"],
    likes: ["Warm morning light", "Ceramics and linen", "Hands in frame"],
    rejectedStyles: ["Steam that looks fake", "Busy café backgrounds"],
    approvedClaims: ["Single origin", "Roasted in small batches"],
    notes: "Ships weekly to Amazon; label must read 'MORO — HOUSE BLEND' exactly.",
  },
  {
    id: "cl_lumiere",
    name: "Lumière Parfums",
    contact: "Anaïs Roux",
    logo: "Thin serif wordmark, gold foil",
    colors: ["#1b1530", "#b48ad8", "#f3e8ff"],
    fonts: ["Didot", "Neue Haas"],
    likes: ["Aura, haze and soft glow", "Slow camera push-ins", "Glass refraction"],
    rejectedStyles: ["Floral clichés", "Visible text other than the bottle"],
    approvedClaims: [],
    notes: "Night-time fragrance launch. Bottle cap geometry must match reference.",
  },
  {
    id: "cl_brightline",
    name: "Brightline Fitness",
    contact: "Marcus Lee",
    logo: "Lime chevron + condensed sans wordmark",
    colors: ["#0f172a", "#22c55e", "#ecfdf5"],
    fonts: ["Druk Condensed", "Inter"],
    likes: ["Real members, not models", "Bold price callouts"],
    rejectedStyles: ["Stock-photo smiles"],
    approvedClaims: ["First month $1", "No contract"],
    notes: "64 locations across the Southeast. Disclaimer must appear on all promos.",
  },
  {
    id: "cl_halvorsen",
    name: "Halvorsen Commercial Kitchens",
    contact: "Erik Halvorsen",
    logo: "Steel-grey block wordmark",
    colors: ["#1f2937", "#94a3b8", "#e5e7eb"],
    fonts: ["IBM Plex Sans"],
    likes: ["Clean stainless environments", "Chefs mid-service"],
    rejectedStyles: ["Home kitchens"],
    approvedClaims: ["NSF certified", "Up to 40% faster recovery time"],
    notes: "Combi oven HX-10. Every spec number must match sheet rev C.",
  },
  {
    id: "cl_kindred",
    name: "Kindred Skincare",
    contact: "Priya Nair",
    logo: "Lowercase rounded wordmark",
    colors: ["#3f2d2a", "#e8b4a0", "#fff4ee"],
    fonts: ["Recoleta", "Inter"],
    likes: ["Texture close-ups", "Real skin"],
    rejectedStyles: ["Before/after comparisons"],
    approvedClaims: ["Fragrance free", "Dermatologist tested"],
    notes: "Meta ads are fatigued — same hook across most active ads.",
  },
  {
    id: "cl_shiftwise",
    name: "Shiftwise",
    contact: "Dana Brooks",
    logo: "Blue wordmark with a clock tick",
    colors: ["#0b1f3a", "#3b82f6", "#eff6ff"],
    fonts: ["Inter"],
    likes: ["Short, direct emails", "Specific numbers from real customers"],
    rejectedStyles: ["Hype words", "Long intros about ourselves"],
    approvedClaims: ["Used by 40 mid-size companies", "Setup in under a week"],
    notes: "Shift scheduling SaaS for mid-size employers. Sales team books demos via Calendly.",
  },
  {
    id: "cl_bridges",
    name: "Bridges Youth Mentoring",
    contact: "Monique Alvarez",
    logo: "Arched bridge mark, teal",
    colors: ["#134e4a", "#14b8a6", "#f0fdfa"],
    fonts: ["Source Serif", "Inter"],
    likes: ["Student voice", "Plain language"],
    rejectedStyles: ["Deficit framing of students", "Savior language"],
    approvedClaims: ["Served 240 students across 6 schools last year", "92% of seniors in the program graduated on time", "Annual budget $1.2M"],
    notes: "Community nonprofit. ED: Monique Alvarez. Applies to 10–15 foundations per year.",
  },
];

type Target = "review" | "planned" | "approval" | "delivered" | "revision";

const JOBS: (NewJobInput & { target: Target; followUp?: string })[] = [
  {
    title: "Blood orange aperitif — hero still",
    channel: "direct",
    clientId: "cl_sanguine",
    price: 10,
    rawBrief:
      'Launching our new blood orange aperitif! Need 1 scroll-stopping product image, 3:4, png, for Instagram. Text on image: "Sanguine — Aperitivo Rosso". Bottle photo attached. Need it by Friday.',
    referenceAssets: ["sanguine-bottle-front.jpg"],
    target: "approval",
  },
  {
    title: "Blood orange aperitif — 5s launch video",
    channel: "direct",
    clientId: "cl_sanguine",
    price: 10,
    productionBudget: 3,
    rawBrief: "Same aperitif — a 5 second vertical video 9:16 mp4, slow pour over ice on a sunny terrace. Product photo attached. By Friday please.",
    referenceAssets: ["sanguine-bottle-front.jpg"],
    target: "approval",
  },
  {
    title: "Amazon listing images — House Blend",
    channel: "upwork",
    clientId: "cl_moro",
    price: 180,
    sourceUrl: "https://www.upwork.com/jobs/~example-moro",
    rawBrief:
      'Looking for 3 lifestyle images 1:1 png for our Amazon listing. Product photos attached. Label must say "MORO — HOUSE BLEND". Deliver within 3 days. Warm, morning kitchen vibe.',
    referenceAssets: ["moro-bag-front.png", "moro-bag-side.png"],
    target: "delivered",
  },
  {
    title: "Night fragrance launch spot",
    channel: "fiverr",
    clientId: "cl_lumiere",
    price: 450,
    sourceUrl: "https://www.fiverr.com/requests/example-lumiere",
    rawBrief:
      "We need a 6 second 9:16 mp4 for our new perfume launch. Dreamy, hazy, aura glow, slow push in on the bottle. Bottle photography attached. Due next Friday.",
    referenceAssets: ["lumiere-nuit-bottle.png"],
    target: "revision",
    followUp: "Love it — could you make the glow a little warmer on the launch spot and slow the push-in?",
  },
  {
    title: "Spring promo — 5 location pilot",
    channel: "direct",
    clientId: "cl_brightline",
    price: 500,
    rawBrief:
      'Our national "First month $1" campaign needs local versions for 5 franchise locations (Miami, Austin, Atlanta, Tampa, Charlotte) with each address and phone number. Spreadsheet attached. Also need a Spanish spokesperson cut. Disclaimer must be on everything.',
    referenceAssets: ["brightline-master-campaign.pdf", "locations.csv"],
    target: "review",
  },
  {
    title: "HX-10 combi oven sales pack",
    channel: "upwork",
    clientId: "cl_halvorsen",
    price: 1500,
    sourceUrl: "https://www.upwork.com/jobs/~example-halvorsen",
    rawBrief:
      "Manufacturer of commercial kitchen equipment. Need a 15 second 16:9 product demo video of our HX-10 combi oven, 2 application scenes and 2 spec graphics for a trade show. Spec sheet, CAD and product photos attached. Deadline within 7 days.",
    referenceAssets: ["HX-10-spec-revC.pdf", "HX-10.step", "hx10-photos.zip"],
    target: "planned",
  },
  {
    title: "Weekly Meta ad pack — barrier cream",
    channel: "direct",
    clientId: "cl_kindred",
    price: 900,
    rawBrief:
      "Our ads are tired. We want a weekly pack of fresh creatives for our barrier cream — new hooks every friday. Something cool, you decide on the angles. Text overlays welcome.",
    target: "review",
  },
  {
    title: "Outbound sequence — HR managers",
    channel: "upwork",
    clientId: "cl_shiftwise",
    price: 250,
    sourceUrl: "https://www.upwork.com/jobs/~example-shiftwise",
    rawBrief:
      "Need a 5-email cold outreach sequence for our shift scheduling software, targeting HR managers at mid-size companies. CTA is book a 15 minute demo. Tone: plain and direct. Due by Friday.",
    target: "approval",
  },
  {
    title: "Meta ad copy — barrier cream",
    channel: "fiverr",
    clientId: "cl_kindred",
    price: 120,
    sourceUrl: "https://www.fiverr.com/requests/example-kindred-copy",
    rawBrief: "Need 6 Meta ad copy variations (headline, primary text, description) for our barrier cream, aimed at people with sensitive skin. Within 2 days.",
    target: "delivered",
  },
  {
    title: "Hartwell Foundation proposal — Bridges",
    channel: "direct",
    clientId: "cl_bridges",
    price: 900,
    rawBrief:
      'We need a grant proposal requesting $75,000 from the Hartwell Community Foundation for our mentoring program called "Bridges". Last year we served 240 students across 6 schools, and 92% of seniors in the program graduated on time. Our annual budget is $1.2M. Foundation priorities: youth development and education equity. Due by October 30th.',
    target: "approval",
  },
  {
    title: "Ad with celebrity lookalike",
    channel: "upwork",
    price: 300,
    newClientName: "Unnamed energy drink",
    sourceUrl: "https://www.upwork.com/jobs/~example-lookalike",
    rawBrief: "Need a 10 second video ad where a guy who looks like Drake drinks our energy drink. 9:16. ASAP, unlimited revisions.",
    target: "review",
  },
];

export async function seed() {
  const db = getDB();
  setAstraSimulated(true);
  useProvider(simulatedProvider(0));
  try {
    db.clients.push(...structuredClone(CLIENTS));
    for (const spec of JOBS) {
      const { target, followUp, ...input } = spec;
      const job = await createJob(input);
      await advance(job, target, followUp);
    }
  } finally {
    useProvider(null);
    setAstraSimulated(false);
    save();
  }
}

const open = (job: Job, kind: string) => job.checkpoints.find((c) => c.kind === kind && c.status === "open");

async function approve(job: Job, kind: string) {
  const cp = open(job, kind);
  if (cp) await resolveCheckpoint(job, cp.id, "approved");
  await settle(job);
}

async function advance(job: Job, target: Target, followUp?: string) {
  if (target === "review") return;
  await approve(job, "client-questions");
  await approve(job, "accept-job");
  if (target === "planned") return;
  await approve(job, "start-production");
  // Let a human sign off any QA escalations so the demo reaches its stage.
  for (let i = 0; i < 6 && open(job, "qa-escalation"); i++) await approve(job, "qa-escalation");
  await approve(job, "budget-limit");
  if (target === "approval") return;
  if (target === "revision" && followUp) {
    await receiveClientMessage(job, followUp);
    await settle(job);
    return;
  }
  await approve(job, "final-delivery");
}
