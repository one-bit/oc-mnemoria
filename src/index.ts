/**
 * oc-mnemoria — OpenCode Plugin
 *
 * Main entry point. Exports only the plugin function so that OpenCode
 * can safely load the package as `"oc-mnemoria"` (or `"oc-mnemoria/plugin"`).
 */

export { default, default as OcMnemoria } from "./plugin.js";
