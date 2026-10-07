import { SERVICE_TEMPLATES, getTemplate } from "./templates";
import type { ClientStatus, JobStage, PortalConfig, PortalPackage, PortalQuestion } from "./types";

// Defaults for the client portal: one package per service template, with a
// guided brief that asks up front for what intake would otherwise chase.

const q = (id: string, label: string, type: PortalQuestion["type"], required: boolean, extra: Partial<PortalQuestion> = {}): PortalQuestion => ({
  id,
  label,
  type,
  required,
  ...extra,
});

const BRIEF = q("brief", "Describe what you need", "textarea", true, { help: "In your own words — what it's for, what matters most, anything to avoid." });
const DEADLINE = q("deadline", "When do you need it?", "text", false, { help: "e.g. by Friday, within 2 weeks" });

export const DEFAULT_QUESTIONS: Record<string, PortalQuestion[]> = {
  "product-still-pack": [
    BRIEF,
    q("product", "Upload clean product photos", "files", true, { help: "Front-on, neutral light, label readable." }),
    q("placement", "Where will these be used?", "select", true, { options: ["Amazon / product page (1:1)", "Instagram feed (4:5)", "Stories / Reels (9:16)", "Website hero (16:9)"] }),
    q("copy", "Exact text to show on the images (if any)", "text", false),
    q("style", "Look and feel", "textarea", false, { help: "Settings, moods, references you like." }),
    DEADLINE,
  ],
  "launch-video": [
    BRIEF,
    q("product", "Upload product photos", "files", true),
    q("length", "Video length", "select", true, { options: ["5 seconds", "10 seconds", "15 seconds", "30 seconds"] }),
    q("format", "Format", "select", true, { options: ["Vertical 9:16 (Reels, TikTok)", "Square 1:1", "Landscape 16:9"] }),
    q("copy", "Text or tagline to include (exact wording)", "text", false),
    DEADLINE,
  ],
  "always-on-ads": [
    BRIEF,
    q("product", "Upload product photos", "files", true),
    q("claims", "Claims we're allowed to make", "textarea", true, { help: "One per line, e.g. 'Dermatologist tested'." }),
    q("audience", "Who buys this?", "text", true),
    DEADLINE,
  ],
  "franchise-localization": [
    BRIEF,
    q("master", "Upload the approved master campaign", "files", true),
    q("locations", "Upload the location sheet (addresses, phones, prices)", "files", true),
    q("disclaimer", "Required disclaimer (exact wording)", "textarea", false),
    DEADLINE,
  ],
  "industrial-sku-pack": [
    BRIEF,
    q("specs", "Upload spec sheets, CAD or manuals", "files", true),
    q("product", "Upload product photos", "files", false),
    q("claims", "Approved claims and safety statements", "textarea", true),
    DEADLINE,
  ],
  "cold-email-sequence": [
    BRIEF,
    q("audience", "Who are we emailing? (titles, company type, size)", "text", true),
    q("offer", "What do you sell, and what result does it get customers?", "textarea", true),
    q("proof", "Results, customers or case studies we may mention", "textarea", false),
    q("cta", "What should readers do? (e.g. book a 15-minute demo)", "text", true),
    q("emails", "How many emails?", "select", true, { options: ["3", "4", "5", "6"] }),
    DEADLINE,
  ],
  "ad-copy-pack": [
    BRIEF,
    q("platform", "Platform", "select", true, { options: ["Meta (Facebook / Instagram)", "Google Search", "LinkedIn", "TikTok"] }),
    q("product", "Product and offer", "textarea", true),
    q("audience", "Who's the customer?", "text", true),
    q("claims", "Claims we're allowed to make", "textarea", false),
    DEADLINE,
  ],
  "grant-proposal": [
    BRIEF,
    q("funder", "Funder name", "text", true),
    q("amount", "Amount requested", "text", true, { help: "e.g. $50,000 over 12 months" }),
    q("format", "Format", "select", true, { options: ["Full proposal", "Letter of inquiry (LOI)"] }),
    q("guidelines", "Upload the funder's guidelines / RFP", "files", false),
    q("data", "Program data we can cite", "textarea", true, { help: "People served, outcomes, budget — only real numbers." }),
    DEADLINE,
  ],
};

export function defaultPackage(templateId: string): PortalPackage {
  const t = getTemplate(templateId);
  return {
    id: `pkg_${t.id}`,
    templateId: t.id,
    name: t.name,
    description: t.description,
    price: t.basePrice,
    turnaroundDays: t.turnaroundDays,
    includes: [...t.deliverables.map((d) => `${d.kind === "text" && d.copy?.format === "grant-proposal" ? "" : `${d.quantity}× `}${d.label}`), "One round of revisions", "Checked against your brief before delivery"],
    addOns:
      t.deliverables[0]?.kind === "text"
        ? [
            { id: "rush", label: "Rush (half the turnaround)", price: Math.round(t.basePrice * 0.5), kind: "rush" },
            { id: "revision", label: "Extra revision round", price: Math.round(t.basePrice * 0.2), kind: "revision" },
          ]
        : [
            { id: "extra", label: `+2 more ${t.deliverables[0]?.kind === "video" ? "videos" : "images"}`, price: Math.round(t.basePrice * 0.4), kind: "extra-units", value: 2 },
            { id: "rush", label: "Rush (half the turnaround)", price: Math.round(t.basePrice * 0.5), kind: "rush" },
          ],
    questions: structuredClone(DEFAULT_QUESTIONS[t.id] ?? [BRIEF, DEADLINE]),
    active: ["product-still-pack", "launch-video", "cold-email-sequence", "ad-copy-pack", "grant-proposal"].includes(t.id),
  };
}

export function defaultPortal(): PortalConfig {
  return {
    enabled: false,
    slug: "",
    headline: "Request work",
    intro: "Pick a package, tell us what you need, and track everything here — from first draft to final files.",
    accentColor: "#4f46e5",
    logoUrl: "",
    autoAccept: false,
    customDomain: "",
    embedOrigins: [],
    packages: SERVICE_TEMPLATES.map((t) => defaultPackage(t.id)),
  };
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "studio"
  );
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
export const RESERVED_SLUGS = new Set(["api", "app", "admin", "www", "p", "mcp", "files", "embed", "portal", "assets", "static", "login", "signup"]);

/** How a job's internal stage reads to the client. */
export function clientStatus(stage: JobStage, clientApproved: boolean, hasOpenQuestions: boolean): { status: ClientStatus; label: string } {
  if (stage === "rejected") return { status: "declined", label: "Declined" };
  if (stage === "delivered") return clientApproved ? { status: "completed", label: "Completed" } : { status: "ready", label: "Ready for your review" };
  if (stage === "revision") return { status: "revising", label: "Making your changes" };
  if (hasOpenQuestions) return { status: "questions", label: "We have a question" };
  if (stage === "intake" || stage === "review") return { status: "received", label: "Received — reviewing your brief" };
  return { status: "in-progress", label: "In production" };
}
