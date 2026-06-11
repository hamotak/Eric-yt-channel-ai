import "server-only";

export type ImageRunStatus = "processing" | "completed" | "failed";
export type ImageRunPhase = "planning" | "rendering" | "reviewing" | "completed" | "failed";
export type ImageRunErrorCategory =
  | "planner_timeout"
  | "planner_failed"
  | "provider_capacity"
  | "provider_rejected"
  | "provider_timeout"
  | "download_failed"
  | "provider_failed"
  | "unknown";
export type ImageCandidateStatus = "processing" | "completed" | "failed";
export type ImageFeedback = "accepted" | "rejected";
export type ImageRunMode = "prompt" | "assist" | "ideate";
export type ImageGenerationMode = "generate" | "remix";

export type ImageReferenceKind =
  | "idea_topic"
  | "idea_format"
  | "idea_evidence"
  | "competitor_outlier"
  | "channel_winner"
  | "attachment";

export type ImageReference = {
  id: string;
  kind: ImageReferenceKind;
  videoId: string | null;
  title: string;
  channelName: string | null;
  channelHandle: string | null;
  thumbnailUrl: string;
  views: number | null;
  medianViews: number | null;
  multiplier: number | null;
  reason: string;
  relevanceScore?: number;
  relevanceLabels?: string[];
  feedback?: "liked" | "disliked" | null;
  feedbackReason?: string | null;
};

export type ImageAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  path: string;
};

export type ImageDirection = {
  rank: 1 | 2 | 3 | 4;
  label: string;
  rationale: string;
  prompt: string;
  changes: string;
  critique: string;
  imageUrls: string[];
  referenceIds: string[];
};

export type ImagePlannerUsage = {
  provider: "openai" | "anthropic";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  costMillicents: number;
};

export type ImageProviderAttempt = {
  attemptType: "generate" | "reference" | "source_free_retry";
  model: string;
  promptPreview: string;
  promptHash: string;
  imageUrls: string[];
  referenceIds: string[];
  imagePayloads?: Array<{
    sourceUrl: string;
    submittedKind: "data_url" | "remote_url";
    mimeType: string | null;
    byteSize: number | null;
    sha256: string | null;
    submittedPreview: string;
  }>;
  submittedAt: string;
  jobId: string | null;
  error?: string | null;
};

export type ImagePlanningResult = {
  directions: ImageDirection[];
  usage: ImagePlannerUsage | null;
};

export type ImageRunRow = {
  id: string;
  user_channel_id: string;
  source_idea_id: string | null;
  mode: ImageRunMode;
  generation_mode: ImageGenerationMode;
  input_prompt: string;
  title: string | null;
  sample_count: number;
  aspect_ratio: string;
  resolution: string;
  ai_assist: number;
  status: ImageRunStatus;
  phase: ImageRunPhase;
  error_category: ImageRunErrorCategory | null;
  selected_references_json: string;
  attachments_json: string;
  channel_snapshot_json: string | null;
  learned_rules_json: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};

export type ImageCandidateRow = {
  id: string;
  run_id: string;
  rank: number;
  status: ImageCandidateStatus;
  job_id: string | null;
  model: string | null;
  resolution: string | null;
  image_path: string | null;
  source_images_json: string;
  provider_attempts_json: string;
  prompt: string | null;
  rationale: string | null;
  changes: string | null;
  critique: string | null;
  feedback: ImageFeedback | null;
  feedback_reason: string | null;
  feedback_at: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

export type ImageFeedbackRuleRow = {
  id: number;
  user_channel_id: string;
  rule_type: "accepted_pattern" | "rejected_pattern";
  rule_value: string;
  source_candidate_id: string | null;
  source_feedback: string | null;
  created_at: string;
};
