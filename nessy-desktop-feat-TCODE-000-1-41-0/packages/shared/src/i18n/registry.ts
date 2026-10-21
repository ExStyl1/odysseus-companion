/**
 * Canonical locale registry — single source of truth for all supported locales.
 *
 * To add a new locale:
 * 1. Create the locale JSON file in ./locales/
 * 2. Import the messages and date-fns locale below
 * 3. Add one entry to LOCALE_REGISTRY
 *
 * Everything else (SUPPORTED_LANGUAGE_CODES, LANGUAGES, i18n resources,
 * date locale lookup) is derived automatically. No other file needs to change.
 */

import type { Locale } from "date-fns";

// ─── Translation resources ───────────────────────────────────────────────────
import enMessages from "./locales/en.json";
import ruMessages from "./locales/ru.json";

// ─── date-fns locales ────────────────────────────────────────────────────────
import { enUS } from "date-fns/locale/en-US";
import { ru as ruDateLocale } from "date-fns/locale/ru";

// ─── Registry ────────────────────────────────────────────────────────────────

interface LocaleEntry {
  nativeName: string;
  messages: Record<string, string>;
  dateLocale: Locale;
}

export const LOCALE_REGISTRY = {
  en: { nativeName: "English", messages: enMessages, dateLocale: enUS },
  ru: { nativeName: "Русский", messages: ruMessages, dateLocale: ruDateLocale },
} satisfies Record<string, LocaleEntry>;

export type LanguageCode = keyof typeof LOCALE_REGISTRY;
