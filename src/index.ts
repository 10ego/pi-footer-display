import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export * from "./cache.js";
export * from "./context.js";
export * from "./format.js";
export * from "./git.js";
export * from "./github.js";
export * from "./paths.js";
export * from "./process.js";
export * from "./state.js";
export * from "./types.js";

/** Native status integration is intentionally deferred to the integration milestone. */
export default function footerDisplayExtension(_pi: ExtensionAPI): void {}
