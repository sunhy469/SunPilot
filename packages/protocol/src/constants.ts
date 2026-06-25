/**
 * Shared runtime constants.
 *
 * Centralizes values that were previously hardcoded across packages so they
 * can be updated in one place. R8 (code audit).
 */

/**
 * The canonical trusted external domain for the SunPilot product.
 *
 * Used as the default web/console URL (launcher) and as the trusted external
 * origin for CORS / origin checks (daemon).
 */
export const TRUSTED_DOMAIN = "tradeagent.asia";

/**
 * Default web console URL used when neither SUNPILOT_WEB_URL nor
 * SUNPILOT_CONSOLE_URL is set.
 */
export const DEFAULT_WEB_URL = `https://${TRUSTED_DOMAIN}`;

/**
 * Default set of external origins trusted by the daemon for browser requests.
 * Includes both the apex domain and the www variant.
 */
export const DEFAULT_EXTERNAL_ORIGINS: readonly string[] = [
  `https://${TRUSTED_DOMAIN}`,
  `https://www.${TRUSTED_DOMAIN}`,
];
