import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getOmpRuntimeClient } from '@/lib/agent/registry';
import type { OmpLoginProvider } from '@/lib/agent/omp-runtime';
import { useI18n } from '@/lib/i18n';
import {
  selectCatalogLoadedForDirectory,
  selectProvidersForDirectory,
  useConfigStore,
} from '@/stores/useConfigStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { ClassificationProvidersPage } from '@/components/sections/classification/ClassificationProvidersPage';

/** The browser step of a login, shown until the provider reports it authenticated. */
type LoginPrompt = {
  providerId: string;
  url: string;
  launchUrl?: string;
  instructions?: string;
};

const LOGIN_POLL_INTERVAL_MS = 2_000;
/** 90 polls at 2s: OMP's own login budget is 10 minutes. */
const LOGIN_POLL_ATTEMPTS = 90;

/**
 * Settings → Providers: the providers the runtime serves and their sign-in state.
 *
 * The model catalog comes from `useConfigStore`, which reads it from the
 * runtime. Sign-in is a separate RPC path: `listLoginProviders()` says which
 * OAuth providers exist and whether they are authenticated, and `login()` opens
 * one. A login answers as soon as OMP has a browser URL to show and keeps
 * running afterwards, so completion is read back from `listLoginProviders()`.
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

  const [loginProviders, setLoginProviders] = React.useState<OmpLoginProvider[]>([]);
  const [loginPrompt, setLoginPrompt] = React.useState<LoginPrompt | null>(null);
  const [signingInProvider, setSigningInProvider] = React.useState<string | null>(null);
  // Bumped on unmount so an in-flight poll loop stops touching state.
  const loginPollToken = React.useRef(0);

  const refreshLoginProviders = React.useCallback(async () => {
    try {
      const providers = await getOmpRuntimeClient().listLoginProviders();
      setLoginProviders(providers.filter((provider) => provider.available));
    } catch {
      // A runtime that cannot answer has nothing to sign in to; the catalog
      // section below reports its own failure.
      setLoginProviders([]);
    }
  }, []);

  React.useEffect(() => {
    void refreshLoginProviders();
  }, [refreshLoginProviders]);

  React.useEffect(() => () => {
    loginPollToken.current += 1;
  }, []);

  const waitForLogin = React.useCallback(async (providerId: string) => {
    const token = loginPollToken.current;
    for (let attempt = 0; attempt < LOGIN_POLL_ATTEMPTS; attempt += 1) {
      const { promise: waited, resolve: wake } = Promise.withResolvers<void>();
      window.setTimeout(wake, LOGIN_POLL_INTERVAL_MS);
      await waited;
      if (loginPollToken.current !== token) return;
      const providers = await getOmpRuntimeClient().listLoginProviders().catch(() => null);
      if (!providers || loginPollToken.current !== token) continue;
      setLoginProviders(providers.filter((provider) => provider.available));
      if (providers.some((provider) => provider.id === providerId && provider.authenticated)) {
        setLoginPrompt(null);
        setSigningInProvider(null);
        return;
      }
    }
    if (loginPollToken.current === token) setSigningInProvider(null);
  }, []);

  const startLogin = React.useCallback(async (providerId: string) => {
    setSigningInProvider(providerId);
    setLoginPrompt(null);
    try {
      const result = await getOmpRuntimeClient().login(providerId);
      if (!result.url) {
        // The flow finished without a browser step.
        setSigningInProvider(null);
        await refreshLoginProviders();
        return;
      }
      setLoginPrompt({ providerId, url: result.url, launchUrl: result.launchUrl, instructions: result.instructions });
      window.open(result.launchUrl ?? result.url, '_blank', 'noopener,noreferrer');
      void waitForLogin(providerId);
    } catch (error) {
      setSigningInProvider(null);
      toast.error(error instanceof Error ? error.message : t('settings.providers.login.failed'));
    }
  }, [refreshLoginProviders, waitForLogin, t]);

  const copyLoginUrl = React.useCallback(async () => {
    if (!loginPrompt) return;
    const copied = await copyTextToClipboard(loginPrompt.launchUrl ?? loginPrompt.url);
    if (!copied.ok) toast.error(copied.error);
  }, [loginPrompt]);

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
      {loginProviders.length > 0 || loginPrompt ? (
        <SettingsSection
          title={t('settings.providers.login.title')}
          divider={false}
          settingsItem="providers.login"
        >
          {loginProviders.length > 0 ? (
            <div className="space-y-2">
              {loginProviders.map((provider) => (
                <div
                  key={provider.id}
                  data-login-provider-id={provider.id}
                  className="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--interactive-border)] p-3"
                >
                  <ProviderLogo providerId={provider.id} className="size-5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="typography-ui-label font-medium text-foreground truncate">
                      {provider.name || provider.id}
                    </div>
                    <div className="typography-micro text-muted-foreground truncate">
                      {provider.authenticated
                        ? t('settings.providers.card.status.connected')
                        : t('settings.providers.card.status.signInNeeded')}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    className="!font-normal"
                    disabled={signingInProvider !== null}
                    onClick={() => void startLogin(provider.id)}
                  >
                    {t('settings.providers.login.action')}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {loginPrompt ? (
            <div className="mt-3 space-y-2 rounded-xl border border-[var(--interactive-border)] p-3" data-login-url>
              {loginPrompt.instructions ? (
                <p className="typography-meta text-muted-foreground">{loginPrompt.instructions}</p>
              ) : null}
              <div className="flex min-w-0 items-center gap-2">
                <a
                  href={loginPrompt.url}
                  target="_blank"
                  rel="noreferrer"
                  className="typography-micro min-w-0 flex-1 truncate font-mono text-primary underline-offset-4 hover:underline"
                >
                  {loginPrompt.url}
                </a>
                <Button
                  variant="outline"
                  size="xs"
                  className="!font-normal"
                  onClick={() => window.open(loginPrompt.launchUrl ?? loginPrompt.url, '_blank', 'noopener,noreferrer')}
                >
                  {t('settings.providers.login.openUrl')}
                </Button>
                <Button variant="outline" size="xs" className="!font-normal" onClick={() => void copyLoginUrl()}>
                  {t('settings.providers.login.copyUrl')}
                </Button>
              </div>
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

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
