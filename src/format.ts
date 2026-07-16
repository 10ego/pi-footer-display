import type {
  FooterSessionState,
  RepositoryMetadata,
  ResolutionOutcome,
} from "./types.js";

export function formatAge(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

const MAX_REPOSITORY_LABEL = 64;
const MAX_REFERENCE_LABEL = 48;

/** Keep untrusted Git/path text single-line, control-free, and bounded. */
export function formatDisplaySegment(value: string, maxCodePoints: number): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const points = Array.from(clean);
  if (points.length === 0) return "?";
  if (points.length <= maxCodePoints) return clean;
  return `${points.slice(0, Math.max(1, maxCodePoints - 1)).join("")}…`;
}

function repositoryLabel(metadata: RepositoryMetadata): string {
  return formatDisplaySegment(
    metadata.github
      ? `${metadata.github.owner}/${metadata.github.repo}`
      : metadata.name,
    MAX_REPOSITORY_LABEL,
  );
}

function metadataParts(metadata: RepositoryMetadata): string[] {
  const parts = [repositoryLabel(metadata)];
  const reference = formatDisplaySegment(metadata.ref.name, MAX_REFERENCE_LABEL);
  parts.push(metadata.ref.detached ? `@${reference}` : reference);
  if (metadata.pullRequest) {
    parts.push(`${metadata.pullRequest.isDraft ? "draft " : ""}PR #${metadata.pullRequest.number}`);
  }
  if (metadata.degraded.length > 0) parts.push("!");
  return parts;
}

function outcomeParts(outcome: ResolutionOutcome): string[] {
  switch (outcome.kind) {
    case "resolved":
      return metadataParts(outcome.metadata);
    case "ambiguous":
      return [`repo? ${outcome.roots.length}`, "?"];
    case "unavailable":
      return ["repo —", "!"];
    case "stale":
      return outcome.previous ? [...metadataParts(outcome.previous), "~"] : ["repo —", "~"];
  }
}

/** Compact status text; markers are `?` ambiguous, `!` degraded, and `~` stale. */
export function formatFooter(state: FooterSessionState, now = Date.now()): string {
  const parts = outcomeParts(state.outcome);
  if (state.mode === "pinned") parts[0] = `📌 ${parts[0] ?? "repo —"}`;
  parts.push(formatAge(state.startedAt, now));
  return parts.join(" · ");
}
