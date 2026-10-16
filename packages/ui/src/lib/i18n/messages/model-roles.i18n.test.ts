import { describe, expect, test } from 'bun:test';
import { modelRolesI18n } from './model-roles.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'pt-BR', 'uk', 'ko', 'pl', 'zh-CN', 'zh-TW', 'tr'] as const;

const requiredKeys = [
  'settings.openchamber.modelRoles.title',
  'settings.openchamber.modelRoles.info',
  'settings.openchamber.modelRoles.appliesToNewSessions',
  'settings.openchamber.modelRoles.unset',
  'settings.openchamber.modelRoles.chooseModel',
  'settings.openchamber.modelRoles.searchPlaceholder',
] as const;

describe('model roles translations', () => {
  test('provides every required key in every supported locale', () => {
    const english = modelRolesI18n.en;
    for (const locale of locales) {
      for (const key of requiredKeys) {
        const value = modelRolesI18n[locale][key];
        expect(value).toBeTruthy();
        if (locale !== 'en') {
          expect(value).not.toBe(english[key]);
        }
      }
    }
  });

  test('keeps the role placeholder in the role-naming label', () => {
    for (const locale of locales) {
      expect(modelRolesI18n[locale]['settings.openchamber.modelRoles.chooseModel']).toContain('{role}');
    }
  });
});
