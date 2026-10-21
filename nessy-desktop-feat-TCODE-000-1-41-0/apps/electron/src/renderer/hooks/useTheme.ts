/**
 * Source: v0.15.1:apps/electron/src/renderer/hooks/useTheme.ts (UB13.4 take, div 0).
 * The `appTheme` option is gone: theme.json overrides load in the provider
 * (getAppTheme/onAppThemeChange -> resolveTheme(preset, overrides)) and are injected even on the
 * default theme; callers read the resolved theme instead of merging per hook call.
 */
import {
  DEFAULT_THEME,
  type ThemeOverrides,
  type ThemeFile,
  type ShikiThemeConfig,
} from '@config/theme'
import { useTheme as useThemeContext } from '@/context/ThemeContext'

interface UseThemeResult {
  /** Effective theme: preset merged with ~/.nessy-agent/theme.json overrides */
  theme: ThemeOverrides
  defaultTheme: ThemeOverrides
  shikiTheme: string
  shikiConfig: ShikiThemeConfig
  presetTheme: ThemeFile | null
  isDark: boolean
  /** Whether the theme is in scenic mode (background image with glass panels) */
  isScenic: boolean
}

/**
 * Hook to access theme state from ThemeContext.
 *
 * Theme loading (presets and theme.json overrides) and DOM manipulation happen in
 * ThemeProvider (singleton). This hook just reads the already-resolved values.
 *
 * @example
 * ```tsx
 * const { isDark, shikiTheme } = useTheme()
 * ```
 */
export function useTheme(): UseThemeResult {
  const context = useThemeContext()

  return {
    theme: context.resolvedTheme,
    defaultTheme: DEFAULT_THEME,
    shikiTheme: context.shikiTheme,
    shikiConfig: context.shikiConfig,
    presetTheme: context.presetTheme,
    isDark: context.isDark,
    isScenic: context.isScenic,
  }
}
