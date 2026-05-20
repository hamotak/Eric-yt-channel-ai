import { redirect } from "next/navigation";

/**
 * /settings used to host the Preferences card (light/dark toggle).
 * The theme toggle moved to the top bar in T11, leaving this page empty —
 * so we redirect to /settings/integrations, the first surviving sub-tab.
 * The "Settings" sidebar item still points here as a stable alias.
 */
export default function SettingsIndex() {
  redirect("/settings/integrations");
}
