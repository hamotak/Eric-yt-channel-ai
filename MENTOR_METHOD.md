# MENTOR_METHOD.md — The methodology this app implements

> Every AI feature in this app (Outliers explainer, Topic Validator, Topic Ideation, Daily Market Watch) MUST quote and follow these principles. The framework is channel-agnostic — it applies to any YouTube niche, any creator size. Channel-specific examples and personal anecdotes from the source briefing have been stripped out; only universal principles remain.

---

## 1. Competitor mapping (the B&S Method)

For any niche, classify every tracked channel into a **tier** and an **adjacency**.

**Tier (size + maturity):**
- **Authority** — established channel, large subscriber base, consistent uploads. Defines what the niche looks like and sets the quality benchmark.
- **Breakthrough** — smaller or newer channel currently blowing up. Reveals what's *currently* working — new formats, new angles, new positioning. **More important than Authority for prediction.**

**Adjacency (audience overlap):**
- **Own niche** — direct competition for the same audience.
- **Adjacent niche** — related but not direct competition. Some audience overlap. Useful for moderate-spin format borrowing.
- **Far niche** — unrelated audience. Best source for thumbnail format borrowing — zero audience overlap, so 1:1 reuse won't feel copied.

For each tracked channel, the app stores:
- Title format patterns across the best-performing videos (structural — see §4).
- Recurring topics across multiple channels in the niche.
- The *"what made it work"* lever for each outlier (see §9).

The *"what made it work"* attribution matters more than the topic itself. Two videos on the same topic can be 75× apart in views. The difference is the **angle**, not the topic.

---

## 2. Outliers (the engine)

**Definition.** An outlier is a video that performs significantly above **its own channel's average** — not above an absolute view threshold.

The standard threshold is **≥ 3× the channel's median views** over the last 30 or 90 days.

**Why relative not absolute:** a 100K-view video on a 10K-subscriber channel is a stronger signal than a 1M-view video on a 5M-subscriber channel. The relative outperformance reveals what the algorithm and audience just rewarded *for that creator's brand*.

**Trap to avoid:** absolute thresholds treat huge and small channels the same and miss breakthrough signals from emerging channels — which are the most valuable predictive signal.

---

## 3. Topic validation (proving evergreen demand)

Before committing to a topic, validate it across **multiple channels and multiple time periods**.

A topic is **evergreen** when:
- At least **2–3 different channels** have covered it.
- They got strong views **across different time periods** (not all in the same month).
- No single external event (movie release, news cycle, celebrity moment) explains the spike.
- The view counts aren't from a **pre-2020 era** when YouTube competition was 10× lower — those views accumulated under different rules and may not replicate today.

**Failure modes (the Topic Validator must auto-flag these):**
- *Single-channel success* — only one creator hit it. Could be packaging, audience loyalty, or luck. Low confidence — not validated.
- *Event-spike* — views correlate with a specific external event (movie, news cycle). Topic is situational, not evergreen.
- *Old-era boost* — view count is from years ago when competition was thin. Topic may not work today at that level.
- *Five-tried-one-worked* — survivorship bias. The winner's success likely came from packaging (thumbnail, title), not the topic itself. Low confidence.

If validation passes → topic enters the **Validated Topics pool** and is available to Topic Ideation.

---

## 4. Title formats (structural patterns, not literal titles)

A **title format** is a *structure* extracted from outlier titles — not the title itself.

Examples of formats (these are templates, not titles you would use):

- `[Counterintuitive claim] about [Familiar subject]`
- `[Specific number] [Surprising adjective] [Topic] You [Verb]`
- `Explain [Topic] Like You're [Age]`
- `Why [Authority figure] [Action] [Topic]`
- `The [Topic] That [Verb-ed] [Consequence]`

Title formats **shift over time**. A dominant format from six months ago may now be played out, and a new variant may be emerging. Daily research (see §6) catches these shifts before competitors do.

When generating new titles, the Topic Ideation feature must:
1. Pick a *validated* title format from the Styles Library.
2. Apply it to a *validated* topic.
3. Use a *current* format — flag formats older than 90 days as needing re-validation.

---

## 5. Thumbnail formats and the 90/10 rule

A **thumbnail format** is the structural style of an outlier thumbnail: background, focal subject, contrast strategy, text placement, color palette, expression type.

**Sourcing rule (depends on adjacency):**
- **Far niche** thumbnails → easiest to reuse 1:1 because zero audience overlap; the audience won't recognize the original.
- **Adjacent niche** → reuse with light variation. Some audience overlap means partial recognition.
- **Direct competitor (own niche)** → **never** copy 1:1. Always twist the angle, color palette, text, or framing.

**The 90/10 rule.** Your thumbnail should be **90% based on the proven outlier format** you took inspiration from, and **10% should be your channel's own branding** — a signature color, font, mascot, illustration style, or recurring graphic element. This keeps thumbnails consistent (subscribers recognize your channel at a glance) while still riding proven formats.

**Thumbnail text rule.** If thumbnails have text, the text should highlight a **specific curiosity hook from the story** (a surprising detail, a precise number, an unexpected name), not a generic descriptor of the topic.

---

## 6. Daily market research (non-negotiable)

Every working day, the operator scans:
- Their YouTube homepage (shaped by their research/competitor watch history).
- Their tracked competitor channels.
- The latest outliers from the last 24–72 hours.

What they're looking for:
- **New competitors** appearing in the niche that aren't tracked yet.
- **Title structure shifts** — a new variant outperforming the previous dominant format.
- **Topic claims** — a competitor uploaded a topic you had planned. If yes: kill it, repackage significantly, or accept head-to-head competition.
- **View floor changes** — is a channel's *worst* recent video view count rising or falling? Sustained vs. spike momentum.

Skipping daily research is the most common reason a channel stalls mid-production while a competitor takes the topic.

The **Daily Market Watch** page in the app automates this: it produces a one-page morning report covering all four buckets above for every channel the user manages.

---

## 7. Ideation (synthesizing the inputs)

Topic Ideation takes these inputs:
- **Channel context** — niche, positioning gap, audience, voice (from the channel's My Channels record).
- **Validated topics pool** — topics that passed the Topic Validator.
- **Saved title formats** — from the Styles Library.
- **Saved thumbnail formats** — from the Styles Library.
- **Recent outliers** — last 30–90 days from the channel's competitors.

For each generated idea, the output includes:
- **Topic** — one line.
- **Angle** — the *"what made it work"* lever it leans on (see §9).
- **Suggested title** — a validated title format applied to the topic.
- **Suggested thumbnail reference** — link to a saved thumbnail format that fits the topic + angle.
- **Confidence score** — derived from (a) how many channels validate the topic, (b) how recent the title format is, (c) how strong the source outlier's multiplier was, (d) how well the angle matches channel voice.

**External ideation sources** (beyond YouTube) the AI may reference if the user has populated `channels.external_sources`:
- Reddit / niche-specific forums — top posts surface what the audience cares about right now.
- Google articles and blog posts — often cover angles YouTube hasn't yet.
- TikTok / Reels — consistent short-form engagement on a topic suggests a long-form audience exists.
- Documentaries, books, news stories — strong source for factual angles and untold stories.
- LLMs (Claude / ChatGPT) — useful for brainstorming angles, but every factual claim **must be verified independently** before use.

---

## 8. Script reverse-engineering (deferred to a later phase)

When the operator wants a freelancer to write, edit, or voice videos in the niche style, they reverse-engineer top competitor scripts using a structured prompt that extracts: word count, opening type, fillers to avoid, must-include structural beats, research depth required, and a one-paragraph style summary.

The reverse-engineering prompt template will live at `prompts/script-reverse-engineer.md` once we reach that phase. For now, this section is documentation of the eventual feature, not a built feature.

---

## 9. The "what made it work" lever taxonomy

Every outlier video is tagged with **one or more** of these levers. Outliers usually combine 2–3 levers, not just one.

- **Curiosity** — opens an information gap the viewer cannot resist closing.
- **Nostalgia** — taps a shared memory from a specific era or generational reference.
- **Counterintuitive** — challenges a widely held belief or assumption.
- **Story most don't know** — surfaces a fact, person, or event the audience has never heard of.
- **Identity** — speaks to who the viewer is or who they want to become ("for the kind of person who…").
- **Authority** — leverages a named expert, institution, or insider source for credibility.
- **Specificity** — a precise, unusual number, name, or detail that signals real research went in.
- **Conflict** — frames the topic as a clash (people vs. people, idea vs. idea, expectation vs. reality).
- **Stakes** — establishes that something significant depends on the outcome (money, life, reputation, history).
- **Visual hook** — the thumbnail itself is the lever (a strange image, a moment frozen at peak weirdness).

The Outliers page must let users tag each outlier with one or more of these levers (multi-select), either manually or via AI auto-suggestion. The tags then feed back into Topic Ideation as context.

---

## 10. Hard rules for any AI feature reading this document

When any AI feature inside the app (Outliers explainer, Topic Validator, Topic Ideation, Daily Market Watch, Chat) is generating output, it MUST follow these:

1. **Never use absolute view thresholds.** Always reason in terms of multipliers vs the channel's own median.
2. **Never recommend a topic that hasn't passed validation** unless explicitly asked for speculative ideas.
3. **Never copy a competitor's title or thumbnail 1:1 from the same niche.** If the source is direct-niche, require a 10% twist.
4. **Always cite the source outlier** (channel name + video title + multiplier) when recommending a title format or thumbnail format.
5. **Always state the lever(s)** the recommendation leans on — never recommend without naming the *why*.
6. **Never confuse "topic" with "format."** A topic is what the video is about. A format is the structural pattern. Both must be validated separately.
7. **Flag pre-2020 outliers** as low-confidence signals — competition has changed.
8. **Verify factual claims** when the operator's `external_sources` include factual content (documentaries, books, news). Do not assert facts the source material doesn't support.
9. **Respect channel voice.** A counterintuitive angle that works for an irreverent channel doesn't fit a sincere one. Always check against `channels.voice` before generating.
10. **When confidence is low, say so.** Don't fabricate validation. Better to recommend three solid ideas than ten weak ones.

---

*This file is the single source of methodology for every AI feature in the app. When the methodology evolves (new lever names, refined validation thresholds, new sourcing rules), update this file — the AI prompts read it on every run and will pick up changes automatically.*

*Last updated: 2026-05-16.*
