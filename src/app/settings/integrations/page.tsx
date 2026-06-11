"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff, Check, Loader2, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/i18n/provider";
import { YouTubeChannelBinder } from "@/components/youtube-channel-binder";
import { ClaudeUsage } from "@/components/claude-usage";

type Name = "openai" | "claude" | "youtube" | "brave" | "69labs";

type StatusMap = Record<
  Name,
  { hasKey: boolean; masked: string; enabled: boolean; config?: { source?: string | null } }
>;

export default function IntegrationsPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<StatusMap | null>(null);

  const load = async () => {
    const res = await fetch("/api/integrations");
    const data = await res.json();
    setStatus(data.integrations);
  };

  useEffect(() => {
    load();
  }, []);

  type ItemMode = "key" | "oauth";
  type Help = {
    title: string;
    steps: string[];
    link: string;
    linkLabel: string;
  };
  const items: {
    name: Name;
    label: string;
    desc: string;
    placeholder: string;
    mode: ItemMode;
    help: Help;
  }[] = [
    {
      name: "openai",
      label: "OpenAI",
      desc: "GPT-5.5 thumbnail planning and visual analysis for Image Studio.",
      placeholder: "sk-...",
      mode: "key",
      help: {
        title: "How to get an OpenAI API key",
        steps: [
          "Open the OpenAI platform dashboard and sign in.",
          "Create a project API key from API keys.",
          "Paste the API key here. Do not paste a ChatGPT browser/session token.",
        ],
        link: "https://platform.openai.com/api-keys",
        linkLabel: "Open OpenAI API keys",
      },
    },
    {
      name: "claude",
      label: t.integrations.claude.name,
      desc: t.integrations.claude.desc,
      placeholder: t.integrations.claude.placeholder,
      mode: "key",
      help: {
        title: t.integrations.claude.helpTitle,
        steps: t.integrations.claude.helpSteps,
        link: t.integrations.claude.helpLink,
        linkLabel: t.integrations.claude.helpLinkLabel,
      },
    },
    {
      name: "youtube",
      label: t.integrations.youtube.name,
      desc: t.integrations.youtube.desc,
      placeholder: t.integrations.youtube.placeholder,
      mode: "key",
      help: {
        title: t.integrations.youtube.helpTitle,
        steps: t.integrations.youtube.helpSteps,
        link: t.integrations.youtube.helpLink,
        linkLabel: t.integrations.youtube.helpLinkLabel,
      },
    },
    {
      name: "brave",
      label: "Brave Search",
      desc: "Reddit Web Signals via Brave Search for Auto and Reddit Angles.",
      placeholder: "BSA...",
      mode: "key",
      help: {
        title: "How to get a Brave Search API key",
        steps: [
          "Open Brave Search API and sign in.",
          "Create or select a Search API plan.",
          "Copy the generated API key and paste it here.",
        ],
        link: "https://brave.com/search/api/",
        linkLabel: "Open Brave Search API",
      },
    },
    {
      name: "69labs",
      label: "69labs",
      desc: "Image generation for Image Studio.",
      placeholder: "vk_...",
      mode: "key",
      help: {
        title: "How to connect 69labs",
        steps: [
          "Open your 69labs dashboard.",
          "Create or copy a key that starts with vk_.",
          "Paste it here so Image Studio can generate final images.",
        ],
        link: "https://69labs.vip/",
        linkLabel: "Open 69labs",
      },
    },
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6">
        <h2 className="text-xl font-semibold tracking-tight">{t.integrations.title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t.integrations.subtitle}</p>
      </header>

      <div className="space-y-4">
        {items.map((it) => (
          <IntegrationCard
            key={it.name}
            name={it.name}
            label={it.label}
            desc={it.desc}
            placeholder={it.placeholder}
            mode={it.mode}
            help={it.help}
            status={status?.[it.name]}
            onSaved={load}
          />
        ))}
      </div>
    </div>
  );
}

function IntegrationCard({
  name,
  label,
  desc,
  placeholder,
  mode,
  help,
  status,
  onSaved,
}: {
  name: Name;
  label: string;
  desc: string;
  placeholder: string;
  mode: "key" | "oauth";
  help: { title: string; steps: string[]; link: string; linkLabel: string };
  status?: { hasKey: boolean; masked: string; enabled: boolean; config?: { source?: string | null } };
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await fetch("/api/integrations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, api_key: value }),
      });
      setValue("");
      setJustSaved(true);
      onSaved();
      setTimeout(() => setJustSaved(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  const connected = !!status?.hasKey;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle>{label}</CardTitle>
          <CardDescription className="mt-1">{desc}</CardDescription>
        </div>
        <span
          className={
            connected
              ? "inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400"
              : "inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          }
        >
          {connected && <Check className="h-3 w-3" />}
          {connected ? t.integrations.status.connected : t.integrations.status.notConnected}
        </span>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {/* Expandable how-to block. Closed by default — power users don't
            need it, but new users get a step-by-step path to the key
            without leaving the page. */}
        <details className="rounded-md border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none text-foreground">
            {help.title}
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 leading-relaxed">
            {help.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
          <a
            href={help.link}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {help.linkLabel}
            <ExternalLink className="h-3 w-3" />
          </a>
        </details>

        {mode === "oauth" ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t.integrations.comingSoon}</p>
            <Button disabled variant="outline" size="sm">
              {t.integrations.connect}
            </Button>
          </div>
        ) : (
          <>
            {connected && (
              <div className="text-xs text-muted-foreground">
                <span className="font-mono">{status?.masked}</span>
                {name === "brave" && status?.config?.source === "env" && (
                  <span className="ml-2">from .env</span>
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor={`key-${name}`}>API key</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id={`key-${name}`}
                    type={show ? "text" : "password"}
                    placeholder={placeholder}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShow((s) => !s)}
                    className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                    aria-label={show ? t.integrations.hideKey : t.integrations.showKey}
                  >
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <Button
                  onClick={save}
                  disabled={saving || !value.trim()}
                  variant={value.trim() ? "default" : "outline"}
                >
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : justSaved ? (
                    <>
                      <Check className="h-4 w-4" />
                      {t.integrations.saved}
                    </>
                  ) : (
                    t.integrations.save
                  )}
                </Button>
              </div>
            </div>
          </>
        )}

        {name === "youtube" && (
          <>
            <YouTubeChannelBinder hasKey={!!status?.hasKey} />
          </>
        )}
        {name === "openai" && <ClaudeUsage enabled={!!status?.hasKey} />}
      </CardContent>
    </Card>
  );
}
