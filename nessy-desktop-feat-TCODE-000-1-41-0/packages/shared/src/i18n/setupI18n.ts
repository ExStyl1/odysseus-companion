import i18n, { type i18n as I18nInstance, type InitOptions } from "i18next";
import { LOCALE_REGISTRY } from "./registry";
import { SUPPORTED_LANGUAGE_CODES } from "./languages";

// Build i18next resources from the locale registry.
const resources = Object.fromEntries(
  Object.entries(LOCALE_REGISTRY).map(([code, entry]) => [
    code,
    { translation: entry.messages },
  ]),
);

// Safe as a boolean guard because init is synchronous (initImmediate: false).
// If async init is ever needed, replace with a promise-based singleton.
let initialized = false;

/**
 * Initialize i18next with bundled translations.
 * Call once at app startup. Pass `plugins` to add framework integrations
 * (e.g. initReactI18next for React apps, LanguageDetector for browser apps).
 */
export function setupI18n(
  plugins: any[] = [],
): I18nInstance {
  if (initialized) return i18n;

  let instance = i18n;
  for (const plugin of plugins) {
    instance = instance.use(plugin);
  }

  instance.init({
    resources,
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGE_CODES],
    interpolation: { escapeValue: false },
    initImmediate: false, // synchronous init — resources are bundled inline
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "i18nextLng",
    },
  } as InitOptions);

  // F1.1238 — `{{scopes, permissionScopes}}` in the permission-policy notices.
  i18n.services.formatter?.add("permissionScopes", (value, lng) => translatePermissionScopes(value, lng));

  initialized = true;
  return i18n;
}

/**
 * F1.1238 (final sitting SIT2-c, 2026-10-01) — the permission-policy notices name settings
 * TIERS (`PermissionDslScope`: managed, global, workspace, project, plugin), which the host
 * interpolates as raw tokens joined with ", " (`SessionManager` symbol
 * `announcePermissionPolicyDiagnostics`), so the Russian warning read "в workspace". The
 * sentences format `scopes` with this function: each token is looked up as
 * `chat.permissionPolicy.scopeName.<token>` in the sentence's own language (Russian takes the
 * locative its "в" needs); anything that is not a bare tier word — the `scopeUnknown` text, a
 * tier added later — passes through unchanged. Done here rather than at the join so the
 * locale owns the grammar; an i18next instance without this formatter prints the raw value,
 * which is what every notice printed before.
 */
export function translatePermissionScopes(value: unknown, lng: string | undefined): string {
  return String(value)
    .split(", ")
    .map((token) => (/^[a-z]+$/.test(token)
      ? i18n.t(`chat.permissionPolicy.scopeName.${token}`, { lng, defaultValue: token })
      : token))
    .join(", ");
}

export { i18n };
