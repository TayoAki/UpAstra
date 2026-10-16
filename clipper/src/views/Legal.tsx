import { useEffect, useState } from "react";
import { Logo } from "../components/Logo";

type Config = { company: string; contact?: string; effective: string };

const DEFAULT: Config = { company: "UGCMediaClips", effective: "October 16, 2026" };

/** Public Terms of Service and Privacy Policy (#/terms, #/privacy). */
export function LegalPage({ kind }: { kind: "terms" | "privacy" }) {
  const [c, setC] = useState<Config>(DEFAULT);
  useEffect(() => {
    fetch("/api/public-config")
      .then((r) => (r.ok ? r.json() : DEFAULT))
      .then((x: Partial<Config>) => setC({ ...DEFAULT, ...x }))
      .catch(() => undefined);
  }, []);
  const contact = c.contact ? <a href={`mailto:${c.contact}`}>{c.contact}</a> : "the contact address on our website";

  return (
    <div className="legal">
      <a href="#/" aria-label="UGCMediaClips home">
        <Logo size={30} />
      </a>
      {kind === "terms" ? <Terms c={c} contact={contact} /> : <Privacy c={c} contact={contact} />}
      <p className="small faint" style={{ marginTop: 40 }}>
        <a href="#/terms">Terms</a> · <a href="#/privacy">Privacy</a> · <a href="#/">Back to the app</a>
      </p>
    </div>
  );
}

function Terms({ c, contact }: { c: Config; contact: React.ReactNode }) {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="faint small">Effective {c.effective}</p>
      <p>
        These terms are an agreement between you and {c.company} ("we", "us") for your use of UGCMediaClips (the "Service"). By creating an account or using the Service you agree to them. If you use the Service for a company,
        you agree for that company.
      </p>

      <h2>1. The Service</h2>
      <p>
        UGCMediaClips helps you turn clipping-campaign briefs and source footage into short videos: it reads briefs, plans and renders clips, adds captions and voiceovers, lets you edit them, and tracks posts and estimated
        earnings. The Service is in beta: features change, and it may be unavailable at times.
      </p>

      <h2>2. Your account</h2>
      <p>
        You must be at least 16 years old and give a real email address. Keep your password and agent keys secret; you're responsible for what happens under your account, including actions taken by AI agents or scripts
        you connect with an agent key. Tell us at {contact} if you think your account has been misused.
      </p>

      <h2>3. Your content</h2>
      <p>
        You keep ownership of what you bring to the Service — briefs, footage, fonts, scripts and the videos made from them ("Your Content"). You give us permission to store, process and transform Your Content only to run
        the Service for you (for example: sending it to AI models to plan clips or speak a voiceover, rendering videos, and posting to accounts you connect). You confirm you have the rights to use Your Content this way,
        including any campaign footage, music, logos and fonts, and that your use follows the campaign's rules and the license the campaign gives you.
      </p>

      <h2>4. AI output</h2>
      <p>
        Clip plans, scripts, captions, voiceovers and other AI output can be wrong, incomplete or similar to other people's output. Review everything before you post it. Rule checks against a brief are a help, not a
        guarantee that a campaign will approve or pay for a clip. Some platforms require you to label AI-generated or AI-voiced content; you're responsible for doing so.
      </p>

      <h2>5. Acceptable use</h2>
      <p>You agree not to use the Service to:</p>
      <ul>
        <li>post content you don't have the rights to, or that infringes anyone's intellectual property or privacy;</li>
        <li>create deceptive, hateful, harassing, sexually explicit or illegal content, or content that breaks a platform's or campaign's rules;</li>
        <li>spam, inflate views or engagement artificially, or evade platform enforcement;</li>
        <li>attack, overload, scrape or reverse-engineer the Service, or get around its limits;</li>
        <li>share your account, or resell the Service without our written permission.</li>
      </ul>
      <p>We may remove content or suspend accounts that break these rules.</p>

      <h2>6. Other services</h2>
      <p>
        The Service relies on third parties, including AI model providers, video hosting and storage, Google Drive (for campaign footage) and, if you connect social accounts, a publishing provider and the social platforms
        themselves. Their terms apply to your use of them, and we aren't responsible for their availability or decisions (for example, a platform removing a post or limiting an account).
      </p>

      <h2>7. Earnings</h2>
      <p>
        Views, payouts and earnings shown in the Service are estimates based on information you or the platforms provide. We don't run clipping campaigns and don't guarantee any campaign will approve your clips or pay
        you. Payment disputes are between you and the campaign.
      </p>

      <h2>8. Fees</h2>
      <p>The Service is free during the beta. If we introduce paid plans we'll tell you in advance, and you won't be charged unless you choose a paid plan.</p>

      <h2>9. Ending your use</h2>
      <p>
        You can delete your account at any time in Settings → Your account; this deletes your workspace and its videos. We may suspend or close accounts that break these terms or put the Service or others at risk, and we
        may end the beta or the Service with reasonable notice where we can.
      </p>

      <h2>10. Disclaimers and liability</h2>
      <p>
        The Service is provided "as is" and "as available", without warranties of any kind, to the extent the law allows. To the extent the law allows, we aren't liable for indirect, incidental or consequential damages, or
        for lost profits, revenue, data or campaign payouts, and our total liability for any claim is limited to the greater of the amount you paid us in the 12 months before the claim or US$50. Some places don't allow
        these limits, so they may not apply to you.
      </p>

      <h2>11. Changes</h2>
      <p>We may update these terms. If a change is significant we'll tell you in the app or by email before it takes effect. Continuing to use the Service after that means you accept the new terms.</p>

      <h2>12. Contact</h2>
      <p>Questions about these terms: {contact}.</p>
    </>
  );
}

function Privacy({ c, contact }: { c: Config; contact: React.ReactNode }) {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="faint small">Effective {c.effective}</p>
      <p>
        This policy explains what {c.company} collects when you use UGCMediaClips, why, who we share it with, and the choices you have. We don't sell your personal information and we don't use advertising trackers.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account details:</strong> your name, email address and a scrambled (hashed) version of your password.
        </li>
        <li>
          <strong>Your workspace:</strong> campaign briefs, footage you upload or link, clip plans, scripts, captions, voiceovers, rendered videos, brand fonts and colours, posts you log or publish and their view counts,
          and chats with the Clipping Agent.
        </li>
        <li>
          <strong>Connected accounts:</strong> if you connect social accounts for publishing, their handles and profile pictures. The sign-in tokens for those accounts are held by our publishing provider, not by us.
        </li>
        <li>
          <strong>Usage and technical data:</strong> what you use (for example renders and AI calls and their cost), and server logs with IP addresses and error details, used to run, secure and fix the Service.
        </li>
        <li>
          <strong>Cookies:</strong> one cookie that keeps you signed in. We don't use analytics or advertising cookies.
        </li>
      </ul>

      <h2>How we use it</h2>
      <p>
        To provide the Service (plan, render, caption, edit and publish your clips), to secure it (sign-in, rate limits, abuse prevention), to send you service emails (confirming your email, resetting your password,
        important changes), to keep costs within limits, and to fix problems. We don't use your content to train AI models.
      </p>

      <h2>Who we share it with</h2>
      <p>Only the providers that run parts of the Service for us, and only what they need:</p>
      <ul>
        <li>
          <strong>Hosting, database and video storage:</strong> Railway.
        </li>
        <li>
          <strong>AI processing:</strong> OpenRouter and the model providers it routes to (such as Anthropic, Google and OpenAI) receive briefs, scripts, footage for analysis and text to read aloud, to produce results for
          you.
        </li>
        <li>
          <strong>Email:</strong> Resend, to deliver account emails.
        </li>
        <li>
          <strong>Publishing:</strong> Outstand and the social platforms you choose to post to, when you schedule or publish a clip.
        </li>
      </ul>
      <p>We may also disclose information if the law requires it, or to protect the Service and its users.</p>

      <h2>How long we keep it</h2>
      <p>
        As long as your account exists. When you delete your account we delete your workspace, videos and account details; copies in backups expire within about 30 days. Server logs are kept for a limited time.
      </p>

      <h2>Your choices and rights</h2>
      <p>
        You can see and change your content in the app, and delete your account in Settings → Your account. Depending on where you live, you may have the right to access, correct, export, or delete your personal
        information, or object to how we use it. Contact {contact} and we'll respond within 30 days.
      </p>

      <h2>Security</h2>
      <p>
        Passwords are hashed, sessions use secure cookies, connections are encrypted, and shared video links expire. No system is perfectly secure; tell us at {contact} if you find a problem.
      </p>

      <h2>Children</h2>
      <p>The Service isn't for anyone under 16, and we don't knowingly collect their information.</p>

      <h2>International transfers</h2>
      <p>Our providers may process data in the United States and other countries. Where required, we rely on appropriate safeguards for these transfers.</p>

      <h2>Changes</h2>
      <p>If we change this policy in a significant way, we'll tell you in the app or by email before it takes effect.</p>

      <h2>Contact</h2>
      <p>Privacy questions or requests: {contact}.</p>
    </>
  );
}
