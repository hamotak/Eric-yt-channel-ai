"use client";

import { useEffect } from "react";

/**
 * Fire-and-forget freshness pass for the user's own channel videos.
 * Mounted once from the root layout so it runs on every app open and on
 * every channel switch (the switcher does a full window.location.reload,
 * which remounts this component).
 *
 * Deliberately UI-less: no spinner, no toast, no error surface. The
 * server side enforces a 15-minute per-channel throttle, so repeated
 * mounts are cheap.
 */
export function SilentVideoSync() {
  useEffect(() => {
    fetch("/api/sync/user-videos", {
      method: "POST",
      keepalive: true,
    }).catch(() => {
      /* swallow — silent by contract */
    });
  }, []);
  return null;
}
