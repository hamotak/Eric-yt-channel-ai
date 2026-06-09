import { NextResponse } from "next/server";
import { setSetting } from "@/lib/db";
import {
  FORBIDDEN_WORDS,
  defaultIdeationTitleRulesText,
  getIdeationTitleRules,
  getIdeationTitleRulesText,
  IDEATION_MODEL_COMPOSE,
  IDEATION_TITLE_RULES_CAP,
  IDEATION_TITLE_RULES_SETTING,
  normalizeIdeationTitleRulesText,
} from "@/lib/ideate/pipeline";

export const runtime = "nodejs";

function titleSettingsPayload() {
  const rulesText = getIdeationTitleRulesText();
  return {
    model: IDEATION_MODEL_COMPOSE,
    rules: getIdeationTitleRules(),
    defaultRulesText: defaultIdeationTitleRulesText(),
    rulesText,
    rulesCap: IDEATION_TITLE_RULES_CAP,
    forbiddenWords: FORBIDDEN_WORDS,
  };
}

export async function GET() {
  return NextResponse.json({
    titleSettings: titleSettingsPayload(),
  });
}

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { rulesText, globalRules } = (body ?? {}) as {
    rulesText?: unknown;
    globalRules?: unknown;
  };
  const nextRules = typeof rulesText === "string" ? rulesText : globalRules;
  if (typeof nextRules !== "string") {
    return NextResponse.json({ error: "rulesText must be a string" }, { status: 400 });
  }
  if (nextRules.length > IDEATION_TITLE_RULES_CAP) {
    return NextResponse.json(
      { error: `rulesText must be ${IDEATION_TITLE_RULES_CAP} characters or less` },
      { status: 400 }
    );
  }
  const normalized = normalizeIdeationTitleRulesText(nextRules);
  if (!normalized) {
    return NextResponse.json({ error: "rulesText must include at least one rule" }, { status: 400 });
  }

  setSetting(IDEATION_TITLE_RULES_SETTING, normalized);
  return NextResponse.json({
    ok: true,
    titleSettings: titleSettingsPayload(),
  });
}
