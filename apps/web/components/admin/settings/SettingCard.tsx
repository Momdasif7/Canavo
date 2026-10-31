"use client";

import { useEffect, useState } from "react";
import { ArrowCounterClockwise, FloppyDisk } from "@phosphor-icons/react";
import { SETTING_SCHEMAS, type SettingKey } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useToast } from "@/components/providers/ToastProvider";
import type { SettingValue } from "@/components/admin/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

/** Value type of a setting key, straight from its zod schema. */
export type SettingOf<K extends SettingKey> = (typeof SETTING_SCHEMAS)[K]["_output"];

export interface EditorProps<K extends SettingKey> {
  value: SettingOf<K>;
  onChange: (v: SettingOf<K>) => void;
  readOnly: boolean;
}

/**
 * Loads one setting for a scope, hands a draft to `render`, validates with the
 * shared zod schema and saves with PUT /admin/settings/:scope/:key.
 */
export function SettingCard<K extends SettingKey>({
  settingKey,
  scope,
  title,
  description,
  readOnly,
  defaults,
  notice,
  render,
}: {
  settingKey: K;
  scope: string;
  title: string;
  description?: React.ReactNode;
  readOnly: boolean;
  defaults: SettingOf<K> | undefined;
  notice?: React.ReactNode;
  render: (p: EditorProps<K>) => React.ReactNode;
}) {
  const toast = useToast();
  const remote = useApiQuery<SettingValue<SettingOf<K>>>(`setting:${scope}:${settingKey}`, () =>
    api.get<SettingValue<SettingOf<K>>>(`/admin/settings/${encodeURIComponent(scope)}/${settingKey}`, { outletId: null }),
  );
  const [draft, setDraft] = useState<SettingOf<K> | undefined>(undefined);
  /** Bumped to remount editors that keep internal row state (load, reset). */
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (remote.data) {
      setDraft(remote.data.value);
      setVersion((v) => v + 1);
      setError(null);
    }
  }, [remote.data]);

  const dirty = remote.data !== undefined && draft !== undefined && JSON.stringify(draft) !== JSON.stringify(remote.data.value);

  const save = async () => {
    if (draft === undefined) return;
    const parsed = SETTING_SCHEMAS[settingKey].safeParse(draft);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(`${issue.path.length ? `${issue.path.join(" › ")}: ` : ""}${issue.message}`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await api.put<SettingValue<SettingOf<K>>>(`/admin/settings/${encodeURIComponent(scope)}/${settingKey}`, { value: parsed.data }, { outletId: null });
      remote.setData({ ...saved, isDefault: false });
      toast(`${title} saved`, "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (defaults === undefined) return;
    setDraft(structuredClone(defaults));
    setVersion((v) => v + 1);
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {title}
            {remote.data?.isDefault && <Badge>Default</Badge>}
            {dirty && <Badge tone="warning">Unsaved</Badge>}
          </span>
        }
        subtitle={
          <>
            {description}
            {remote.data?.updatedAt && <span className="mt-0.5 block text-xs">Last changed {formatDateTime(remote.data.updatedAt)}</span>}
          </>
        }
        action={
          !readOnly && (
            <div className="flex shrink-0 gap-2">
              {defaults !== undefined && (
                <Button variant="ghost" size="sm" icon={<ArrowCounterClockwise size={18} />} onClick={reset} disabled={saving} title="Load default values (not saved until you press Save)">
                  <span className="hidden sm:inline">Defaults</span>
                </Button>
              )}
              <Button size="sm" icon={<FloppyDisk size={18} />} onClick={save} loading={saving} disabled={!dirty}>
                Save
              </Button>
            </div>
          )
        }
      />
      <div className="space-y-4 p-5">
        {notice}
        {error && <Alert>{error}</Alert>}
        {remote.loading && draft === undefined ? (
          <LoadingState />
        ) : remote.error && draft === undefined ? (
          <ErrorState message={remote.error} onRetry={remote.reload} />
        ) : draft !== undefined ? (
          <fieldset disabled={readOnly} key={version} className="min-w-0">
            {render({ value: draft, onChange: setDraft, readOnly })}
          </fieldset>
        ) : null}
      </div>
    </Card>
  );
}
