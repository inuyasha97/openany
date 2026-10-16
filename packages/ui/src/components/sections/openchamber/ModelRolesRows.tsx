import React from 'react';
import { z } from 'zod';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { dropdownMenuItemClass } from '@/components/ui/dropdown-menu.styles';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import {
  SettingsControlGroup,
  SettingsFieldRow,
  SETTINGS_FIELDS_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useConfigStore } from '@/stores/useConfigStore';
import { cn } from '@/lib/utils';
import type { Model, Provider } from '@/lib/opencode/model';

/**
 * OMP's `modelRoles` table, one row per role.
 *
 * A role names the model OMP resolves a kind of work to (`smol` for the small
 * model, `plan` for planning runs, and so on). The value is written into the
 * user's `config.yml`, so an unset role is a real state rather than a default
 * this page gets to invent: the route answers `null` for it and the row says so.
 *
 * OMP reads its config when a session's process starts, so a change here shows
 * up in the sessions started after it — the note above the rows says that
 * instead of leaving the user to wonder why an open chat ignores it.
 *
 * The model catalog is the one the Default Model picker offers; the rows render
 * their own panel (the app's shared popover surface, not a portal menu) because
 * a settings row here owns its open state per role.
 */
const MODEL_ROLES_PATH = '/api/config/model-roles';

const modelRolesResponseSchema = z.object({
  roles: z.array(z.object({ name: z.string().min(1), value: z.string().nullable() })),
  known: z.array(z.string()),
});

type ModelRole = z.infer<typeof modelRolesResponseSchema>['roles'][number];

/**
 * The request the rows go through. Injecting it keeps the component testable
 * without mocking a module.
 */
export type ModelRolesFetch = (input: string, init?: RequestInit) => Promise<Response>;

type ModelRoleOption = {
  /** What OMP stores: `provider/model`. */
  value: string;
  label: string;
  /** Provider id and model name, lower-cased once for the search filter. */
  search: string;
};

const buildModelOptions = (providers: readonly (Provider & { models: Model[] })[]): ModelRoleOption[] =>
  providers.flatMap((provider) => (provider.models ?? []).map((model) => ({
    value: `${provider.id}/${model.id}`,
    label: model.name.trim() !== '' ? model.name : model.id,
    search: `${provider.id}/${model.id} ${model.name}`.toLowerCase(),
  })));

/** The stored table, or `null` when the route could not answer it. */
const readStoredRoles = async (fetchImpl: ModelRolesFetch): Promise<ModelRole[] | null> => {
  const response = await fetchImpl(MODEL_ROLES_PATH, { headers: { Accept: 'application/json' } });
  if (!response.ok) return null;
  const parsed = modelRolesResponseSchema.safeParse(await response.json());
  return parsed.success ? parsed.data.roles : null;
};

interface ModelRolePickerProps {
  role: string;
  options: readonly ModelRoleOption[];
  query: string;
  onQueryChange: (query: string) => void;
  /** `null` clears the role, which is a choice like any other. */
  onSelect: (value: string | null) => void;
}

const ModelRolePicker: React.FC<ModelRolePickerProps> = ({ role, options, query, onQueryChange, onSelect }) => {
  const { t } = useI18n();
  const matches = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle === '' ? options : options.filter((option) => option.search.includes(needle));
  }, [options, query]);

  return (
    <div
      data-slot="model-role-picker"
      className="oc-glass-popover oc-glass-floating absolute top-full right-0 z-50 mt-1 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-1 rounded-xl p-1"
    >
      <Input
        autoFocus
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={t('settings.openchamber.modelRoles.searchPlaceholder')}
        aria-label={t('settings.openchamber.modelRoles.chooseModel', { role })}
        className="h-8"
      />
      <div className="max-h-72 overflow-y-auto">
        <button
          type="button"
          className={cn(dropdownMenuItemClass, 'w-full')}
          onClick={() => onSelect(null)}
        >
          <Icon name="close" aria-hidden="true" />
          <span className="truncate">{t('settings.openchamber.modelRoles.unset')}</span>
        </button>
        {matches.map((option) => (
          <button
            key={option.value}
            type="button"
            className={cn(dropdownMenuItemClass, 'w-full')}
            onClick={() => onSelect(option.value)}
          >
            <span className="min-w-0 flex-1 truncate text-left">{option.label}</span>
            <span className="shrink-0 typography-micro text-muted-foreground">{option.value}</span>
          </button>
        ))}
        {matches.length === 0 ? (
          <div className="px-2 py-1 typography-meta text-muted-foreground">
            {t('settings.agents.modelSelector.state.noModelsFound')}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const ModelRolesRows: React.FC<{ fetchImpl?: ModelRolesFetch }> = ({ fetchImpl = runtimeFetch }) => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const [roles, setRoles] = React.useState<ModelRole[] | null>(null);
  const [openRole, setOpenRole] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  // The panel is anchored inside its row, so an unrelated click closes it.
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    readStoredRoles(fetchImpl)
      .then((stored) => {
        if (!cancelled && stored) setRoles(stored);
      })
      .catch((error) => console.warn('[model-roles] failed to read', error));
    return () => {
      cancelled = true;
    };
  }, [fetchImpl]);

  React.useEffect(() => {
    if (openRole === null) return;
    const close = () => {
      setOpenRole(null);
      setQuery('');
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && !containerRef.current?.contains(target)) close();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [openRole]);

  const options = React.useMemo(() => buildModelOptions(providers), [providers]);

  const choose = React.useCallback(async (role: string, value: string | null) => {
    setOpenRole(null);
    setQuery('');
    const previous = roles;
    // The row shows the choice at once; a failed write puts the read value back.
    setRoles((current) => current?.map((row) => (row.name === role ? { ...row, value } : row)) ?? current);
    reportSettingsSaveState('saving');
    try {
      const response = await fetchImpl(MODEL_ROLES_PATH, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ role, value }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = modelRolesResponseSchema.pick({ roles: true }).safeParse(await response.json().catch(() => null));
      // The route answers the resulting table, which is the truth to show.
      if (parsed.success) setRoles(parsed.data.roles);
      reportSettingsSaveState('saved');
    } catch (error) {
      console.warn('[model-roles] failed to save', error);
      reportSettingsSaveState('error');
      setRoles(previous);
    }
  }, [fetchImpl, roles]);

  if (roles === null) {
    return null;
  }

  return (
    <SettingsControlGroup
      settingsItem="sessions.model-roles"
      title={t('settings.openchamber.modelRoles.title')}
      description={t('settings.openchamber.modelRoles.appliesToNewSessions')}
      info={t('settings.openchamber.modelRoles.info')}
      className="pt-6"
      contentClassName={SETTINGS_FIELDS_STACK_CLASS}
    >
      <div ref={containerRef} className={SETTINGS_FIELDS_STACK_CLASS}>
        {roles.map((role) => {
          const isOpen = openRole === role.name;
          return (
            <SettingsFieldRow
              key={role.name}
              settingsItem={`sessions.model-role.${role.name}`}
              label={role.name}
            >
              <div className="relative min-w-0">
                <Button
                  type="button"
                  variant="outline"
                  className={cn(dropdownTriggerVariants({ size: 'default' }), 'max-w-72 min-w-0')}
                  aria-haspopup="listbox"
                  aria-expanded={isOpen}
                  aria-label={t('settings.openchamber.modelRoles.chooseModel', { role: role.name })}
                  onClick={() => {
                    setOpenRole(isOpen ? null : role.name);
                    setQuery('');
                  }}
                >
                  <span className={cn('truncate', role.value === null && 'text-muted-foreground')}>
                    {role.value ?? t('settings.openchamber.modelRoles.unset')}
                  </span>
                  <Icon name="arrow-down-s" className="size-3.5 shrink-0" aria-hidden="true" />
                </Button>
                {isOpen ? (
                  <ModelRolePicker
                    role={role.name}
                    options={options}
                    query={query}
                    onQueryChange={setQuery}
                    onSelect={(value) => {
                      void choose(role.name, value);
                    }}
                  />
                ) : null}
              </div>
            </SettingsFieldRow>
          );
        })}
      </div>
    </SettingsControlGroup>
  );
};
