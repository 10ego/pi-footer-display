import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFooterDisplay } from "./extension.js";

export * from "./cache.js";
export * from "./context.js";
export * from "./extension.js";
export * from "./format.js";
export * from "./git.js";
export * from "./github.js";
export * from "./paths.js";
export * from "./process.js";
export * from "./state.js";
export * from "./types.js";

/** Register the native footer status integration without starting session resources. */
export default function footerDisplayExtension(pi: ExtensionAPI): void {
  registerFooterDisplay(pi);
}
