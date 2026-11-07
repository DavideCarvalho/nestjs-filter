import type { InjectionToken } from '@nestjs/common';
import { FILTER_MESSAGES, type FilterMessageKey, formatFilterMessage } from './messages.js';
import { loadOptionalPeer } from './optional-peer.js';

/** The part of `@nestjs/i18n`'s `I18nService` the filter library uses. */
export interface FilterTranslator {
  exists(key: string, locale?: string): boolean;
  translate(key: string, options?: { args?: Record<string, unknown> }): string;
}

/**
 * The injection token of `@nestjs/i18n`'s `I18nService` (the class itself)
 * when the package is installed, or a token nothing provides otherwise, so an
 * `@Optional()` injection of it resolves to `undefined`.
 */
export const I18N_SERVICE: InjectionToken =
  loadOptionalPeer<{ I18nService: InjectionToken }>('@nestjs/i18n')?.I18nService ??
  Symbol('nestjs-filter:no-i18n');

/**
 * The client-facing text for `key`: `filter.<key>` from `@nestjs/i18n` in the
 * current request's locale when the app's catalogs have it, the built-in
 * English otherwise. `exists()` is checked first because a missing key comes
 * back from `translate()` as the key itself (or `''`, or a throw, depending on
 * the app's `missingKey` policy).
 */
export function filterMessage(
  i18n: FilterTranslator | undefined,
  key: FilterMessageKey,
  args?: Record<string, unknown>,
): string {
  if (i18n) {
    const fullKey = `filter.${key}`;
    try {
      if (i18n.exists(fullKey)) return i18n.translate(fullKey, args ? { args } : {});
    } catch {
      // A translator failure must not turn a 400 into a 500: use the English.
    }
  }
  return formatFilterMessage(FILTER_MESSAGES[key], args);
}
