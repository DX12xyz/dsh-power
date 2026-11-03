/**
 * Module 3 of 3 — human entry (host side).
 *
 * The human entry is rendered by the client half (`client.js`) on BOTH the web
 * and Desktop builds: the same sidebar DOM (`div[class*="_settingsArea"]`) is
 * present in either shell, so the「DSH电源」button and its three-mode menu work in
 * both. The Desktop official tray keeps its own entries unchanged; the plugin
 * neither creates a tray item nor patches the Electron app.
 */
export function registerHumanEntry(ctx, api) {
  api.log(`human entry: rendered by the client half (${api.platform === 'desktop' ? 'desktop' : 'web'} sidebar)`);
}
