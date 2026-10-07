import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import {
  selectCatalogLoadedForDirectory,
  selectProvidersForDirectory,
  useConfigStore,
} from '@/stores/useConfigStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { ClassificationProvidersPage } from '@/components/sections/classification/ClassificationProvidersPage';

/**
 * Settings → Providers: the provider/model catalog OMP serves.
 *
 * The runtime owns which providers and models exist; OpenChamber only reads the
 * catalog `useConfigStore` loads from it. Neither provider sign-in nor model
 * enablement is configured here (sign-in returns over a separate RPC path), so
 * the page has no affordance that would write the runtime's config.
 */
export const ProvidersPage: React.FC = () => {
  const { t } = useI18n();
  // Settings browses whichever project its own selector points at; the app
  // stays where it is.
  const settingsDirectory = useSettingsDirectory();
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, settingsDirectory));
  const providersLoaded = useConfigStore((state) =>
    selectCatalogLoadedForDirectory(state, 'models', settingsDirectory));
  // The app only loads providers for the project it is on; Settings has to ask
  // for the one it is looking at.
  const loadProviders = useConfigStore((state) => state.loadProviders);

  React.useEffect(() => {
    if (!settingsDirectory) return;
    void loadProviders({ directory: settingsDirectory, source: 'settings:providers' });
  }, [loadProviders, settingsDirectory]);

  const refresh = React.useCallback(() => {
    void loadProviders({ directory: settingsDirectory, source: 'settings:providers' });
  }, [loadProviders, settingsDirectory]);

  // Classification providers answer OpenChamber's own Jev decisions, not the
  // runtime's catalog, so they keep their own sub-page.
  const [showClassification, setShowClassification] = React.useState(false);
  const [focusProviderId, setFocusProviderId] = React.useState<string | null>(null);
  const classificationRequested = useUIStore((state) => state.settingsProvidersClassificationRequested);
  const setClassificationRequested = useUIStore((state) => state.setSettingsProvidersClassificationRequested);
  React.useEffect(() => {
    if (!classificationRequested) return;
    setShowClassification(true);
    setClassificationRequested(false);
  }, [classificationRequested, setClassificationRequested]);

  // A classification source that needs a key links to the provider holding it;
  // the catalog answers by bringing that provider into view.
  React.useEffect(() => {
    if (!focusProviderId) return;
    const target = document.querySelector<HTMLElement>(
      `[data-provider-id="${CSS.escape(focusProviderId)}"]`,
    );
    if (!target) {
      setFocusProviderId(null);
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.setAttribute('data-settings-search-highlight', 'true');
    const timer = window.setTimeout(() => {
      target.removeAttribute('data-settings-search-highlight');
      setFocusProviderId(null);
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [focusProviderId, providers]);

  if (showClassification) {
    return (
      <ClassificationProvidersPage
        titleLeading={(
          <SettingsBackButton
            label={t('settings.providers.page.back')}
            onClick={() => setShowClassification(false)}
          />
        )}
        onOpenProvider={(providerId) => {
          setShowClassification(false);
          setFocusProviderId(providerId);
        }}
      />
    );
  }

  const modelCount = providers.reduce(
    (total, provider) => total + (provider.models?.length ?? 0),
    0,
  );

  return (
    <SettingsPageLayout
      title={t('settings.page.providers.title')}
      headerEnd={<SettingsProjectSelector className="w-full min-w-0 @xl:w-56" />}
    >
      <SettingsSection
        title={t('settings.providers.page.models.title')}
        titleAccessory={
          <span className="typography-micro text-muted-foreground font-normal">
            ({modelCount})
          </span>
        }
        headerAction={(
          <Button variant="outline" size="xs" className="!font-normal" onClick={refresh}>
            <Icon name="refresh" className="size-3.5" />
            {t('walkthrough.action.refresh')}
          </Button>
        )}
        divider={false}
        settingsItem="providers.models"
      >
        {providers.length === 0 ? (
          <p className="py-6 typography-meta text-muted-foreground">
            {providersLoaded
              ? t('settings.providers.grid.empty')
              : t('settings.providers.page.state.loading')}
          </p>
        ) : (
          <div className="space-y-4">
            {providers.map((provider) => {
              const models = provider.models ?? [];
              return (
                <div
                  key={provider.id}
                  data-provider-id={provider.id}
                  className="rounded-xl border border-[var(--interactive-border)] p-4"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <ProviderLogo providerId={provider.id} className="size-5 shrink-0" />
                    <span className="typography-ui-label font-medium text-foreground truncate">
                      {provider.name || provider.id}
                    </span>
                    <span className="typography-micro font-mono text-muted-foreground truncate">
                      {provider.id}
                    </span>
                  </div>

                  {models.length > 0 ? (
                    <div className="mt-2 divide-y divide-[var(--surface-subtle)]">
                      {models.map((model) => (
                        <div key={model.id} className="flex min-w-0 items-center gap-3 py-1.5">
                          <span className="typography-meta font-medium text-foreground truncate flex-1 min-w-0">
                            {model.name || model.id}
                          </span>
                          <span className="typography-micro font-mono text-muted-foreground truncate">
                            {model.id}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
