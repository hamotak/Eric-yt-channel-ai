type DictionaryShape = {
  app: { name: string };
  nav: {
    dashboard: string;
    videos: string;
    chat: string;
    integrations: string;
    import: string;
    logs: string;
    settings: string;
  };
  logs: {
    title: string;
    subtitle: string;
    refresh: string;
    liveOn: string;
    liveOff: string;
    clearAll: string;
    confirmClear: string;
    clickToClear: string;
    levelAll: string;
    sourceAll: string;
    searchPlaceholder: string;
    empty: string;
    loading: string;
    kpi: {
      total: string;
      error: string;
      warn: string;
      info: string;
      debug: string;
    };
  };
  banner: { connectTitle: string; connectDesc: string; connectCta: string };
  dashboard: {
    title: string;
    subtitle: string;
    noData: string;
    emptyTitle: string;
    summaryTitle: string;
    summaryDesc: string;
    kpi: { subscribers: string; views: string; videos: string; avgViews: string };
    channelDetails: string;
    topByViews: string;
    topByViewsDesc: string;
    topByEngagement: string;
    topByEngagementDesc: string;
    deeper: string;
    deeperDesc: string;
    bottomByViews: string;
    bottomByViewsDesc: string;
    outliers: string;
    outliersDesc: string;
    monthly: string;
    monthlyDesc: string;
    monthlyCountSuffix: string;
  };
  videos: {
    title: string;
    subtitle: string;
    empty: string;
    search: string;
    sortLabel: string;
    durationLabel: string;
    countFound: string;
    sort: {
      recent: string;
      oldest: string;
      views: string;
      likes: string;
      comments: string;
      engagement: string;
    };
    duration: { all: string; long: string; short: string };
  };
  videoDetail: {
    openOnYouTube: string;
    views: string;
    likes: string;
    comments: string;
    engagementRate: string;
    avgViewsPerDay: string;
    tabOverview: string;
    tabComments: string;
    soon: string;
    description: string;
    noDescription: string;
    copy: string;
    copied: string;
    commentsComingSoon: string;
    openIntegrations: string;
  };
  channel: {
    backToDashboard: string;
    emptyTitle: string;
    emptyDesc: string;
    unknownTitle: string;
    openOnYouTube: string;
    aboutTitle: string;
    aboutDesc: string;
    showMore: string;
    showLess: string;
    noDescription: string;
    metaTitle: string;
    channelId: string;
    handleLabel: string;
    importedAt: string;
    engagementTitle: string;
    engagementDesc: string;
    totalLikes: string;
    totalComments: string;
    engagementRate: string;
    importedVideos: string;
    // ----- Deep analytics sections -----
    performanceTitle: string;
    performanceDesc: string;
    perfMin: string;
    perfP25: string;
    perfMedian: string;
    perfP75: string;
    perfMax: string;
    perfStdev: string;
    perfAboveMedian: string;
    perfTopViral: string;
    perfTopViralHint: string;
    contentMixTitle: string;
    contentMixDesc: string;
    shortsLabel: string;
    longFormLabel: string;
    durationDist: string;
    videosCountLabel: string;
    cadenceTitle: string;
    cadenceDesc: string;
    firstUpload: string;
    lastUpload: string;
    channelAge: string;
    daysAgo: string;
    sinceLastUpload: string;
    avgBetweenUploads: string;
    uploads30d: string;
    uploads90d: string;
    activeMonths: string;
    silentMonths: string;
    dayOfWeekTitle: string;
    dayOfWeekDesc: string;
    hourOfDayTitle: string;
    hourOfDayDesc: string;
    monthlyTitle: string;
    monthlyDesc: string;
    themesTitle: string;
    themesDesc: string;
    topTags: string;
    topTitleWords: string;
    avgTitleLen: string;
    charsShort: string;
    noTags: string;
    growthTitle: string;
    growthDesc: string;
    recent5Avg: string;
    previous5Avg: string;
    recent10Avg: string;
    previous10Avg: string;
    trendUp: string;
    trendDown: string;
    trendFlat: string;
    trendInsufficient: string;
    daysShort: string;
  };
  chat: {
    title: string;
    subtitle: string;
    placeholder: string;
    send: string;
    emptyHint: string;
    missingKey: string;
    newChat: string;
    noSessions: string;
    untitled: string;
    deleteConfirm: string;
    tools: string;
    toolHint: string;
    noKey: string;
    attach: string;
    reconnectedPendingTitle: string;
    reconnectedPendingHint: string;
  };
  attachPicker: {
    searchPlaceholder: string;
    empty: string;
    added: string;
    done: string;
    tabVideos: string;
    tabComments: string;
    searchCommentsPlaceholder: string;
    commentsHint: string;
    commentsEmpty: string;
    onVideo: string;
    replyBadge: string;
  };
  comments: {
    topLevelSuffix: string;
    repliesSuffix: string;
    lastSynced: string;
    neverSynced: string;
    syncFromYouTube: string;
    syncing: string;
    searchPlaceholder: string;
    empty: string;
    loading: string;
    loadMore: string;
    viewReplies: string;
    hideReplies: string;
    loadingReplies: string;
    repliesNotCached: string;
    fetchAllReplies: string;
    fetching: string;
    showMore: string;
    showLess: string;
    notSyncedTitle: string;
    notSyncedDescription: string;
  };
  youtube: {
    bindTitle: string;
    bindDesc: string;
    inputLabel: string;
    sync: string;
    needKey: string;
    boundTo: string;
    subscribers: string;
    videos: string;
    done: string;
  };
  integrations: {
    title: string;
    subtitle: string;
    save: string;
    saved: string;
    showKey: string;
    hideKey: string;
    connect: string;
    comingSoon: string;
    status: { connected: string; notConnected: string };
    claude: {
      name: string;
      desc: string;
      placeholder: string;
      helpTitle: string;
      helpSteps: string[];
      helpLink: string;
      helpLinkLabel: string;
    };
    youtube: {
      name: string;
      desc: string;
      placeholder: string;
      helpTitle: string;
      helpSteps: string[];
      helpLink: string;
      helpLinkLabel: string;
    };
  };
  claudeUsage: {
    title: string;
    total: string;
    last24h: string;
    statTurns: string;
    statInput: string;
    statOutput: string;
    statCacheRead: string;
    refresh: string;
    clearHistory: string;
    confirmClear: string;
    loading: string;
    empty: string;
    emptyMsg: string;
    advisorUsedTitle: string;
    rowModel: string;
    rowIterations: string;
    rowInputTokens: string;
    rowOutputTokens: string;
    rowCacheRead: string;
    rowCacheWrite: string;
    rowAdvisor: string;
    rowAdvisorTokens: string;
    rowDuration: string;
    rowActiveTools: string;
    ledgerSinceHint: string;
  };
  import: {
    title: string;
    subtitle: string;
    dropHint: string;
    button: string;
    processing: string;
    success: string;
    howTitle: string;
    howDesc: string;
    importBtn: string;
    imported: string;
    skipped: string;
  };
  settings: {
    title: string;
    subtitle: string;
    theme: string;
    themeLight: string;
    themeDark: string;
  };
  googleOAuth: {
    title: string;
    subtitle: string;
    howToTitle: string;
    howStep1: string;
    howStep2: string;
    howStep3: string;
    howStep4: string;
    howStep5: string;
    openConsole: string;
    clientIdLabel: string;
    clientSecretLabel: string;
    currentClientId: string;
    saveCredsFirst: string;
    connect: string;
    reconnect: string;
    disconnect: string;
    disconnectConfirm: string;
    disconnected: string;
    connectedJustNow: string;
    errorPrefix: string;
    activeSession: string;
    refreshAge: string;
    reconnectSoon: string;
    scopesLabel: string;
    // Extended tips for shared-channel / Brand Account scenarios.
    tipsTitle: string;
    tipBrandAccount: string;
    tipManagerLimitations: string;
    tipTestUsers: string;
    tipWhereScopes: string;
    tipRefreshTokenExpiry: string;
  };
};

export const dictionaries: { en: DictionaryShape } = {
  en: {
    app: {
      name: "YT Channel AI",
    },
    nav: {
      dashboard: "Dashboard",
      videos: "Videos",
      chat: "AI Chat",
      integrations: "Integrations",
      import: "Import",
      logs: "Logs",
      settings: "Settings",
    },
    logs: {
      title: "Logs",
      subtitle: "Activity log.",
      refresh: "Refresh",
      liveOn: "Live",
      liveOff: "Live tail",
      clearAll: "Clear all",
      confirmClear: "Delete these logs? This cannot be undone.",
      clickToClear: "Click to clear this level",
      levelAll: "all levels",
      sourceAll: "all sources",
      searchPlaceholder: "Search logs…",
      empty: "No logs match these filters.",
      loading: "Loading…",
      kpi: {
        total: "Total",
        error: "Errors",
        warn: "Warnings",
        info: "Info",
        debug: "Debug",
      },
    },
    banner: {
      connectTitle: "Connect your integrations to get started",
      connectDesc:
        "Add your API keys for OpenAI or Claude and YouTube to unlock the full app.",
      connectCta: "Go to Integrations",
    },
    dashboard: {
      title: "Dashboard",
      subtitle: "Overview of your YouTube channel",
      noData: "No channel data yet. Import a YouTube Studio export or add your API keys first.",
      emptyTitle: "Nothing to show yet",
      summaryTitle: "Channel summary",
      summaryDesc: "Aggregated across all imported videos.",
      kpi: {
        subscribers: "Subscribers",
        views: "Total Views",
        videos: "Videos",
        avgViews: "Avg. Views / Video",
      },
      channelDetails: "Channel details",
      topByViews: "Top by views",
      topByViewsDesc: "Your most-watched videos.",
      topByEngagement: "Top by engagement",
      topByEngagementDesc: "Highest (likes + comments) / views ratio.",
      deeper: "Deeper analysis",
      deeperDesc: "Outliers, underperformers and monthly output.",
      bottomByViews: "Bottom by views",
      bottomByViewsDesc: "Lowest-viewed videos — candidates to retire or relaunch.",
      outliers: "Outliers",
      outliersDesc: "Videos that deviated ≥ 2σ from the channel average.",
      monthly: "Monthly uploads & views",
      monthlyDesc: "Output cadence and view totals per calendar month.",
      monthlyCountSuffix: "vids",
    },
    videos: {
      title: "Videos",
      subtitle: "All videos",
      empty: "No videos yet. Import your channel data first.",
      search: "Search videos…",
      sortLabel: "Sort",
      durationLabel: "Duration",
      countFound: "{n} videos",
      sort: {
        recent: "Newest",
        oldest: "Oldest",
        views: "Most views",
        likes: "Most likes",
        comments: "Most comments",
        engagement: "Engagement",
      },
      duration: { all: "All", long: "Long-form", short: "Shorts" },
    },
    videoDetail: {
      openOnYouTube: "Open on YouTube",
      views: "Views",
      likes: "Likes",
      comments: "Comments",
      engagementRate: "Engagement",
      avgViewsPerDay: "~{n} views / day since publish",
      tabOverview: "Overview",
      tabComments: "Comments",
      soon: "soon",
      description: "Description",
      noDescription: "No description.",
      copy: "Copy",
      copied: "Copied",
      commentsComingSoon: "Comments will appear here once Phase 2 is shipped.",
      openIntegrations: "Open Integrations",
    },
    channel: {
      backToDashboard: "Back to dashboard",
      emptyTitle: "No channel bound yet",
      emptyDesc: "Bind your YouTube channel from the Integrations page to populate this view.",
      unknownTitle: "Unnamed channel",
      openOnYouTube: "Open on YouTube",
      aboutTitle: "About",
      aboutDesc: "Description as it appears on YouTube.",
      showMore: "Show more",
      showLess: "Show less",
      noDescription: "No channel description on file.",
      metaTitle: "Metadata",
      channelId: "Channel ID",
      handleLabel: "Handle",
      importedAt: "Imported",
      engagementTitle: "Aggregate engagement",
      engagementDesc: "Summed across all imported videos.",
      totalLikes: "Total likes",
      totalComments: "Total comments",
      engagementRate: "Engagement rate",
      importedVideos: "Videos on file",
      performanceTitle: "Performance distribution",
      performanceDesc:
        "How views spread across your videos — is success concentrated in a few hits, or even across the catalog?",
      perfMin: "Worst",
      perfP25: "25th %ile",
      perfMedian: "Median",
      perfP75: "75th %ile",
      perfMax: "Best",
      perfStdev: "Stdev",
      perfAboveMedian: "Videos above median",
      perfTopViral: "Best-video reach vs subs",
      perfTopViralHint:
        "Your top video's views as % of subscribers. <10% means heavy audience saturation; >100% means you reached well beyond your current base.",
      contentMixTitle: "Content mix",
      contentMixDesc: "Shorts vs long-form split and duration breakdown.",
      shortsLabel: "Shorts (≤60s)",
      longFormLabel: "Long-form",
      durationDist: "Duration distribution",
      videosCountLabel: "videos",
      cadenceTitle: "Publishing cadence",
      cadenceDesc: "How often and when you actually ship videos.",
      firstUpload: "First upload",
      lastUpload: "Last upload",
      channelAge: "Channel age",
      daysAgo: "days ago",
      sinceLastUpload: "Since last upload",
      avgBetweenUploads: "Avg days between uploads",
      uploads30d: "Uploads, last 30d",
      uploads90d: "Uploads, last 90d",
      activeMonths: "Active months",
      silentMonths: "Silent months",
      dayOfWeekTitle: "By day of week",
      dayOfWeekDesc: "Which weekdays you publish on and how they perform on average.",
      hourOfDayTitle: "By hour of day (UTC)",
      hourOfDayDesc: "UTC hour of publication — shift to your local timezone mentally.",
      monthlyTitle: "Monthly publishing",
      monthlyDesc: "Upload count and views per calendar month.",
      themesTitle: "Content themes",
      themesDesc: "Recurring tags and title words across your catalog.",
      topTags: "Top tags",
      topTitleWords: "Title vocabulary",
      avgTitleLen: "Avg title length",
      charsShort: "chars",
      noTags: "No tags set on any video.",
      growthTitle: "Growth trajectory",
      growthDesc: "Recent uploads performance vs the preceding batch — are views trending up or cooling?",
      recent5Avg: "Recent 5 avg views",
      previous5Avg: "Previous 5 avg views",
      recent10Avg: "Recent 10 avg views",
      previous10Avg: "Previous 10 avg views",
      trendUp: "Trending up",
      trendDown: "Trending down",
      trendFlat: "Flat",
      trendInsufficient: "Need at least 10 uploads to judge",
      daysShort: "d",
    },
    chat: {
      title: "AI Chat",
      subtitle: "Ask Claude anything about your channel",
      placeholder: "Ask about your channel, competitors, content ideas...",
      send: "Send",
      emptyHint:
        "Try: \"What are my top performing videos?\" or \"Suggest 5 new video ideas based on my niche\"",
      missingKey: "Add your Claude API key in Integrations to start chatting.",
      newChat: "New chat",
      noSessions: "No chats yet",
      untitled: "Untitled chat",
      deleteConfirm: "Delete this chat permanently?",
      tools: "Tools for this conversation",
      toolHint: "Enable tools to let Claude fetch live data (YouTube, web, scrapers).",
      noKey: "no key",
      attach: "Attach video or comment",
      reconnectedPendingTitle: "Claude is still generating a response…",
      reconnectedPendingHint:
        "The turn is running on the server. You can keep browsing — the answer will appear here when it's ready.",
    },
    attachPicker: {
      searchPlaceholder: "Search videos by title...",
      empty: "No videos match that search.",
      added: "Added",
      done: "Done",
      tabVideos: "Videos",
      tabComments: "Comments",
      searchCommentsPlaceholder: "Search comments by text or author...",
      commentsHint: "Type to search your cached comments. Sync a video's comments first from its page.",
      commentsEmpty: "No comments match that search.",
      onVideo: "on",
      replyBadge: "reply",
    },
    comments: {
      topLevelSuffix: "top-level",
      repliesSuffix: "replies",
      lastSynced: "Last synced",
      neverSynced: "never",
      syncFromYouTube: "Sync from YouTube",
      syncing: "Syncing…",
      searchPlaceholder: "Filter comments…",
      empty: "No comments synced yet. Hit \"Sync from YouTube\" to pull them.",
      loading: "Loading…",
      loadMore: "Load more",
      viewReplies: "View {n} replies",
      hideReplies: "Hide replies",
      loadingReplies: "Loading replies…",
      repliesNotCached: "No replies cached for this thread yet.",
      fetchAllReplies: "Fetch {n} more replies from YouTube",
      fetching: "Fetching…",
      showMore: "Show more",
      showLess: "Show less",
      notSyncedTitle: "Comments not synced yet",
      notSyncedDescription:
        "AI can't analyze comments for this video until you sync them. One click → all comments and replies are pulled into the local DB so chat tools can read them.",
    },
    integrations: {
      title: "Integrations",
      subtitle: "API keys and providers.",
      save: "Save",
      saved: "Saved",
      showKey: "Show",
      hideKey: "Hide",
      connect: "Connect",
      comingSoon: "Coming soon",
      status: {
        connected: "Connected",
        notConnected: "Not connected",
      },
      claude: {
        name: "Claude (Anthropic)",
        desc: "Ideation, validation, and planning.",
        placeholder: "sk-ant-...",
        helpTitle: "How to get a Claude API key",
        helpSteps: [
          "Go to console.anthropic.com and sign in (or create an account — personal email works).",
          "Open the left sidebar → API Keys → Create Key. Give it any name (e.g. \"yt-channel-ai\").",
          "Copy the key (starts with sk-ant-…). You'll see it only once — save it now or regenerate later.",
          "Paste it into the field below and hit Save.",
          "Cost note: you pay per-token. A typical chat turn with 2+ tools + Opus advisor costs $0.05–$0.30. Budget a few dollars per audit session.",
        ],
        helpLink: "https://console.anthropic.com/settings/keys",
        helpLinkLabel: "Open Anthropic Console",
      },
      youtube: {
        name: "YouTube Data API v3",
        desc: "Videos, search, statistics, and comments.",
        placeholder: "YouTube API key",
        helpTitle: "How to get a YouTube API key",
        helpSteps: [
          "Open Google Cloud Console → APIs & Services → Library. Create a project (or reuse one).",
          "Search for \"YouTube Data API v3\" and click Enable.",
          "Go to APIs & Services → Credentials → Create credentials → API key. No OAuth needed for this key.",
          "Copy and paste below. Default quota is 10,000 units/day — a full channel sync uses ~50–200 units, plenty.",
          "Security tip: click \"Restrict key\" after creating and limit it to \"YouTube Data API v3\" only.",
        ],
        helpLink: "https://console.cloud.google.com/apis/credentials",
        helpLinkLabel: "Open Google Cloud Console",
      },
    },
    claudeUsage: {
      title: "AI spend history",
      total: "Total",
      last24h: "Last 24h",
      statTurns: "Chat turns",
      statInput: "Input tokens",
      statOutput: "Output tokens",
      statCacheRead: "Cache reads",
      refresh: "Refresh",
      clearHistory: "Clear history",
      confirmClear:
        "Clear the spend ledger? This only resets what's shown here — it doesn't refund anything on provider bills.",
      loading: "Loading…",
      empty: "No AI calls yet — the ledger fills up as the app plans and analyzes.",
      emptyMsg: "(attachments only)",
      advisorUsedTitle: "Advisor model was consulted this turn",
      rowModel: "Provider/model",
      rowIterations: "Tool iterations",
      rowInputTokens: "Input tokens",
      rowOutputTokens: "Output tokens",
      rowCacheRead: "Cache read (90% off)",
      rowCacheWrite: "Cache write",
      rowAdvisor: "Advisor",
      rowAdvisorTokens: "Advisor tokens (in/out)",
      rowDuration: "Duration",
      rowActiveTools: "Active tools",
      ledgerSinceHint:
        "Ledger tracks calls since {date}. Older calls (before tracking was added, or on error paths before a recent fix) won't appear here but still show in provider consoles.",
    },
    import: {
      title: "Import",
      subtitle: "Import your YouTube Studio CSV export",
      dropHint: "Drop your YT Studio CSV here or click to browse",
      button: "Select file",
      processing: "Processing...",
      success: "Imported successfully",
      howTitle: "Import from YouTube Studio",
      howDesc:
        "1. Open YouTube Studio → Content.\n2. Click the 'Export' button (top right) and choose 'Google Sheets' or 'Comma-separated values'.\n3. Upload the downloaded CSV file below.",
      importBtn: "Import",
      imported: "{n} videos imported",
      skipped: "{n} skipped",
    },
    youtube: {
      bindTitle: "Bind your channel",
      bindDesc:
        "Paste a @handle, channel URL, or channel ID. We'll pull public video data used by ideation.",
      inputLabel: "Channel",
      sync: "Sync",
      needKey: "Set a YouTube API key above to enable binding.",
      boundTo: "Bound",
      subscribers: "subs",
      videos: "videos",
      done: "Synced {n} videos.",
    },
    settings: {
      title: "Settings",
      subtitle: "App preferences",
      theme: "Theme",
      themeLight: "Light",
      themeDark: "Dark",
    },
    googleOAuth: {
      title: "YouTube Analytics (Google OAuth)",
      subtitle:
        "Connect your Google account to pull private analytics (retention, traffic sources, revenue, demographics). Different from the YouTube Data API key above — that one fetches public data, this one unlocks your private Studio data.",
      howToTitle: "How to set up your own OAuth client",
      howStep1: "Google Cloud Console → Credentials. Create a project (or reuse the one you made for the YouTube Data API key).",
      howStep2:
        "APIs & Services → Library. Enable both \"YouTube Analytics API\" and \"YouTube Data API v3\" — they are separate APIs and both must be enabled.",
      howStep3:
        "Credentials → Create credentials → OAuth 2.0 Client ID → \"Web application\". Under \"Authorised redirect URIs\" add:",
      howStep4:
        "Google Auth Platform → Audience → Test users → add the Google email you'll log in with (yours, or your boss's if that's whose channel you're analysing). Publishing status stays \"Testing\".",
      howStep5:
        "Google Auth Platform → Data Access → Add scopes. Paste: youtube.readonly, yt-analytics.readonly, yt-analytics-monetary.readonly. Save.",
      openConsole: "Open Google Cloud Console",
      clientIdLabel: "OAuth Client ID",
      clientSecretLabel: "OAuth Client secret",
      currentClientId: "Saved",
      saveCredsFirst: "Save your client ID and secret first",
      connect: "Connect with Google",
      reconnect: "Reconnect",
      disconnect: "Disconnect",
      disconnectConfirm: "Disconnect and remove saved Google tokens?",
      disconnected: "Disconnected from Google.",
      connectedJustNow: "Connected to Google successfully.",
      errorPrefix: "OAuth error",
      activeSession: "Active Google session",
      refreshAge:
        "Refresh token is {n} days old (Google test mode expires tokens after 7 days).",
      reconnectSoon: "reconnect soon",
      scopesLabel: "Scopes",
      tipsTitle: "Important tips (real-world scenarios)",
      tipBrandAccount:
        "If you are analysing someone else's channel (e.g. your boss's), they need to add your email as a Manager under YouTube Studio → Settings → Permissions. This only works for Brand Accounts — personal channels must either be converted to Brand, or the owner logs in once on your machine.",
      tipManagerLimitations:
        "Manager-level access gives you views, watch time, demographics, traffic sources, retention. It does NOT give revenue/RPM/earnings — those require Owner. If you need revenue data, the owner must either make you an Owner or log in themselves.",
      tipTestUsers:
        "The account you click \"Connect\" with must be in the Test users list (see step 4). If you sign in with a different account you'll get \"Access blocked: app has not completed verification\".",
      tipWhereScopes:
        "In Google's new Cloud Console UI, scopes are under \"Data Access\" (not \"OAuth consent screen → Scopes\" like the old docs say). Test users moved to \"Audience\".",
      tipRefreshTokenExpiry:
        "In Testing mode, Google expires refresh tokens after 7 days. When you see the amber \"reconnect soon\" hint below, just click Reconnect — your saved scopes stay, only the tokens refresh.",
    },
  },
};

export type Locale = keyof typeof dictionaries;
export type Dictionary = DictionaryShape;
