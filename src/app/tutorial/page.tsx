"use client";

import Link from "next/link";

export default function TutorialPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          How to use this app
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A 3-minute walkthrough. Read top-to-bottom or jump to a section.
        </p>
      </header>

      <nav className="mb-10 rounded-md border border-border bg-muted/30 p-3 text-sm">
        <ul className="space-y-1">
          <li>
            <a href="#intro" className="text-primary hover:underline">
              What this app does
            </a>
          </li>
          <li>
            <a href="#quick-start" className="text-primary hover:underline">
              Your first 5 minutes
            </a>
          </li>
          <li>
            <a href="#pages" className="text-primary hover:underline">
              Every page, in plain words
            </a>
          </li>
          <li>
            <a href="#methodology" className="text-primary hover:underline">
              The methodology
            </a>
          </li>
          <li>
            <a href="#troubleshooting" className="text-primary hover:underline">
              Troubleshooting
            </a>
          </li>
        </ul>
      </nav>

      <Section id="intro" title="What this app does">
        <p>
          This is your local YouTube research and ideation HQ. Everything runs
          on your Mac.
        </p>
        <p>
          No data leaves your laptop unless you send it to an external API
          (Claude, YouTube Data, Deepgram).
        </p>
        <p>
          The app&apos;s job: find what&apos;s working for your competitors,
          validate topics across the niche, and generate channel-specific video
          ideas.
        </p>
      </Section>

      <Section id="quick-start" title="Your first 5 minutes">
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Open{" "}
            <Link href="/settings/integrations" className="text-primary hover:underline">
              Integrations
            </Link>{" "}
            → paste your Claude and YouTube Data API keys.
          </li>
          <li>
            Open{" "}
            <Link href="/channel-info" className="text-primary hover:underline">
              Channel Info
            </Link>{" "}
            → fill in niche, positioning, audience, voice — or click
            &ldquo;Analyze with AI&rdquo; to auto-populate from recent
            videos.
          </li>
          <li>
            Open{" "}
            <Link href="/competitors" className="text-primary hover:underline">
              Competitors
            </Link>{" "}
            → add competitor channels and tag each as Authority, Breakthrough,
            Adjacent, or Far.
          </li>
          <li>
            <ComingSoon /> Open <strong>Outliers</strong> → see which competitor
            videos broke out 3× or more above their own channel&apos;s median.
          </li>
          <li>
            <ComingSoon /> Open <strong>Topic Ideation</strong> → generate 10
            video ideas built from your context + outliers + saved styles.
          </li>
        </ol>
      </Section>

      <Section id="pages" title="Every page, in plain words">
        <div className="space-y-5">
          <PageDescription name="Dashboard" href="/" status="active">
            Overview of every channel you&apos;ve connected: revenue, views,
            top performers. Use the channel picker top-right to switch focus.
          </PageDescription>

          <PageDescription name="Channel Info" href="/channel-info" status="active">
            Where you describe each channel to the AI — niche, positioning,
            audience, voice, off-YouTube research sources — and where the
            per-channel detail view lives (themes, transcripts coverage,
            audience, revenue). One channel selected → full detail card.
            &ldquo;All channels&rdquo; selected → summary table with a
            &ldquo;Context filled&rdquo; / &ldquo;Needs context&rdquo;
            status per channel. The &ldquo;Analyze with AI&rdquo; button
            asks Claude to propose all 5 context fields from your recent
            videos and transcripts. Every AI feature in the app reads
            from this — fill it in carefully.
          </PageDescription>

          <PageDescription name="Videos" href="/videos" status="active">
            Every video from your channels with transcript, AI analysis, and
            comments. Click one to drill in.
          </PageDescription>

          <PageDescription name="AI Chat" href="/chat" status="active">
            Your central ideation agent. Talk to it about your channel, ask
            for video ideas, ask why a competitor&apos;s video blew up, find
            topic gaps. It reads your channel context, competitors, outliers,
            format patterns, your videos, transcripts, comment analysis.
            Follows the methodology in <code className="rounded bg-muted px-1 py-0.5 text-[10px]">MENTOR_METHOD.md</code>.
          </PageDescription>

          <PageDescription
            name="Competitors"
            href="/competitors"
            status="active"
          >
            Tracked competitors of each of your channels. Each one is tagged as
            Authority (established, large), Breakthrough (newer, blowing up —
            more predictive), Adjacent (related niche, light overlap), or Far
            (unrelated audience, best source for thumbnail formats).
          </PageDescription>

          <PageDescription name="Alerts" href="/settings/alerts" status="active">
            Rules that ping you when something happens — e.g. a competitor
            uploads, a video crosses a view threshold.
          </PageDescription>

          <PageDescription
            name="Integrations"
            href="/settings/integrations"
            status="active"
          >
            Your API keys for Claude, YouTube Data, Deepgram, Apify, and
            others. One-time setup.
          </PageDescription>

          <PageDescription name="Import" href="/settings/import" status="active">
            Bulk-import data from CSV. Useful when migrating from another tool.
          </PageDescription>

          <PageDescription name="Logs" href="/settings/logs" status="active">
            Every API call, error, and event in chronological order. Look here
            if something feels broken.
          </PageDescription>

          <PageDescription name="Settings" href="/settings" status="active">
            App preferences.
          </PageDescription>

          <PageDescription name="Outliers" href="/outliers" status="active">
            Two tabs. <strong>Library</strong> shows competitor videos that
            beat their own channel&apos;s median by 3×+. Click any card →
            Claude tags it with &ldquo;what made it work&rdquo; levers
            (curiosity, nostalgia, counterintuitive, etc.) plus 2-3 sentences
            of reasoning. <strong>Patterns</strong> extracts title format
            templates from those outliers (like &ldquo;[Place]&apos;s most
            [Adjective] [Thing]&rdquo;) so you see WHAT is structurally
            working in the niche right now. To turn outliers into ideas, ask
            the AI Chat.
          </PageDescription>

          <PageDescription name="Styles Library" status="coming-soon">
            Your collected title formats and thumbnail formats, tagged by source
            niche tier. The building blocks Topic Ideation uses to generate new
            ideas.
          </PageDescription>

          <PageDescription name="Topic Validator" status="coming-soon">
            Paste a topic, the app checks how many different channels covered
            it and across what time periods. Auto-flags traps: single-channel
            only, event-spike, pre-2020 boost, evergreen-confirmed.
          </PageDescription>

          <PageDescription name="Daily Market Watch" status="coming-soon">
            Runs every morning. Reports new outliers, emerging title
            structures, new competitors blowing up, and topic conflicts (a
            competitor uploaded something you had planned).
          </PageDescription>

          <PageDescription name="Topic Ideation" status="coming-soon">
            The synthesizer. Pick a channel → Claude generates 10 video ideas
            using your channel context + recent outliers + saved title /
            thumbnail formats. Approve, edit, or trash each one. Available now
            in AI Chat — full standalone page comes later.
          </PageDescription>
        </div>
      </Section>

      <Section id="methodology" title="The methodology">
        <ul className="space-y-2 pl-5">
          <li className="list-disc">
            <strong>Outliers are relative.</strong> A video is an outlier if it
            beats its own channel&apos;s median by 3× or more — not because it
            crossed some absolute view threshold.
          </li>
          <li className="list-disc">
            <strong>Validate topics across channels and time.</strong> A single
            channel&apos;s success doesn&apos;t prove a topic — three different
            channels hitting it across different months does.
          </li>
          <li className="list-disc">
            <strong>Title formats are patterns, not literal titles.</strong>{" "}
            Save the structure (<code className="rounded bg-muted px-1 py-0.5 text-xs">[Counterintuitive claim] about [Familiar topic]</code>),
            not the words. Formats shift every few months.
          </li>
          <li className="list-disc">
            <strong>The 90/10 rule for thumbnails.</strong> 90% of your
            thumbnail should be the proven outlier format you took inspiration
            from. 10% is your channel&apos;s own branding.
          </li>
          <li className="list-disc">
            <strong>Daily research is non-negotiable.</strong> Spot new
            competitors, new title structures, and topic claims before you
            waste a week producing something that&apos;s already been taken.
          </li>
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          Full methodology in <code className="rounded bg-muted px-1 py-0.5">MENTOR_METHOD.md</code> at the project root.
        </p>
      </Section>

      <Section id="troubleshooting" title="Troubleshooting">
        <div className="space-y-4">
          <div>
            <div className="font-medium">The app forgot my keys</div>
            <p className="text-sm text-muted-foreground">
              Confirm the project folder is NOT inside iCloud Drive, Dropbox,
              or OneDrive. Those services corrupt the SQLite database.
            </p>
          </div>
          <div>
            <div className="font-medium">Port 3000 already in use</div>
            <p className="text-sm text-muted-foreground">
              Quit the other app, or start this one on a different port:{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                npm run dev -- -p 3001
              </code>
              .
            </p>
          </div>
          <div>
            <div className="font-medium">App won&apos;t start at all</div>
            <p className="text-sm text-muted-foreground">
              Re-run{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                install.command
              </code>{" "}
              from the project folder. If the issue persists, screenshot the
              terminal output.
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-10 scroll-mt-6">
      <h2 className="mb-4 border-b border-border pb-2 text-xl font-semibold tracking-tight">
        {title}
      </h2>
      <div className="space-y-3 text-sm leading-relaxed text-foreground/90">
        {children}
      </div>
    </section>
  );
}

function PageDescription({
  name,
  href,
  status,
  children,
}: {
  name: string;
  href?: string;
  status: "active" | "coming-soon";
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        {href ? (
          <Link
            href={href}
            className="text-base font-medium text-primary hover:underline"
          >
            {name}
          </Link>
        ) : (
          <span className="text-base font-medium text-foreground/90">
            {name}
          </span>
        )}
        {status === "active" ? <ActivePill /> : <ComingSoonPill />}
      </div>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function ActivePill() {
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
      Currently active
    </span>
  );
}

function ComingSoonPill() {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      Coming soon
    </span>
  );
}

function ComingSoon() {
  return (
    <span className="mr-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      Coming soon
    </span>
  );
}
