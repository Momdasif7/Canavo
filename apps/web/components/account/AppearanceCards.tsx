"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Check, Desktop, Moon, Sun } from "@phosphor-icons/react";
import { ACCENT_PRESETS, DEFAULT_ACCENT, normalizeBrand, type Brand, type CornerStyle, type Density, type TextSize } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { useSession } from "@/components/providers/SessionProvider";
import { useTheme } from "@/components/providers/ThemeProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Preset swatches plus a custom colour (picker + hex box). */
function AccentPicker({ value, onChange, label }: { value: string; onChange: (hex: string) => void; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const isPreset = ACCENT_PRESETS.some((p) => p.hex === value.toUpperCase());
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {ACCENT_PRESETS.map((p) => {
          const on = p.hex === value.toUpperCase();
          return (
            <button
              key={p.hex}
              type="button"
              role="radio"
              aria-checked={on}
              title={p.name}
              aria-label={p.name}
              onClick={() => onChange(p.hex)}
              className={clsx(
                "flex h-10 w-10 items-center justify-center rounded-full text-white ring-offset-2 ring-offset-surface transition-transform hover:scale-110",
                on && "ring-2 ring-fg",
              )}
              style={{ background: p.hex }}
            >
              {on && <Check size={18} weight="bold" />}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-h-tap cursor-pointer items-center gap-2 text-sm font-semibold">
          <input
            type="color"
            value={HEX.test(value) ? value.toLowerCase() : DEFAULT_ACCENT.toLowerCase()}
            onChange={(e) => onChange(e.target.value.toUpperCase())}
            className={clsx("h-10 w-12 cursor-pointer rounded-lg border border-line bg-surface p-1", !isPreset && "ring-2 ring-fg ring-offset-2 ring-offset-surface")}
            aria-label="Pick a custom colour"
          />
          Custom
        </label>
        <Input
          aria-label="Hex colour"
          wrapperClassName="w-32"
          value={text}
          maxLength={7}
          onChange={(e) => {
            const v = e.target.value.trim();
            setText(v);
            const hex = v.startsWith("#") ? v : `#${v}`;
            if (HEX.test(hex)) onChange(hex.toUpperCase());
          }}
          error={text && !HEX.test(text.startsWith("#") ? text : `#${text}`) ? "Use #RRGGBB" : null}
        />
      </div>
    </div>
  );
}

/** Every signed-in user: their own look, saved to their account (follows them to other devices). */
export function MyAppearanceCard() {
  const { prefs, brand, setPrefs } = useTheme();
  const { me } = useSession();
  return (
    <Card>
      <CardHeader title="My appearance" subtitle="Only for you — saved to your account, so it follows you to any device you log in on." />
      <div className="space-y-5 p-5">
        <Row label="Theme">
          <Segmented
            value={prefs.appearance}
            onChange={(v) => setPrefs({ appearance: v })}
            options={[
              { value: "light", label: <Labelled icon={<Sun size={18} />}>Light</Labelled> },
              { value: "dark", label: <Labelled icon={<Moon size={18} />}>Dark</Labelled> },
              { value: "system", label: <Labelled icon={<Desktop size={18} />}>Same as device</Labelled> },
            ]}
          />
        </Row>
        <Row label="Text size">
          <Segmented<TextSize>
            value={prefs.textSize}
            onChange={(v) => setPrefs({ textSize: v })}
            options={[
              { value: "small", label: "Small" },
              { value: "normal", label: "Normal" },
              { value: "large", label: "Large" },
            ]}
          />
        </Row>
        <Row label="Layout" hint="Compact fits more rows on screen; comfortable has bigger touch targets.">
          <Segmented<Density>
            value={prefs.density}
            onChange={(v) => setPrefs({ density: v })}
            options={[
              { value: "comfortable", label: "Comfortable" },
              { value: "compact", label: "Compact" },
            ]}
          />
        </Row>
        <div className="space-y-3 border-t border-line pt-4">
          <Toggle
            label="Use my own accent colour"
            description={
              prefs.accent
                ? "Buttons and highlights use your colour instead of the business brand."
                : `Using ${me?.business ? `${me.business.name}'s` : "the"} brand colour.`
            }
            checked={Boolean(prefs.accent)}
            onChange={(on) => setPrefs({ accent: on ? (brand.accent === DEFAULT_ACCENT ? ACCENT_PRESETS[1].hex : DEFAULT_ACCENT) : null })}
          />
          {prefs.accent && <AccentPicker label="My accent colour" value={prefs.accent} onChange={(hex) => setPrefs({ accent: hex })} />}
        </div>
      </div>
    </Card>
  );
}

/**
 * The business brand: the owner (outlet:manage) picks the accent colour and corner style for everyone
 * in the business, with a live preview; everyone else sees what was chosen.
 */
export function BusinessBrandCard() {
  const toast = useToast();
  const { me, can, refreshMe } = useSession();
  const { prefs, setBrand } = useTheme();
  const saved = normalizeBrand(me?.brand);
  const [draft, setDraft] = useState<Brand>(saved);
  const [saving, setSaving] = useState(false);
  const editable = can("outlet:manage") && !me?.support;
  const dirty = draft.accent !== saved.accent || draft.corners !== saved.corners;

  // Leaving the page without saving drops the preview.
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(() => () => setBrand(savedRef.current), [setBrand]);

  if (!me?.business) return null;

  const preview = (b: Brand) => {
    setDraft(b);
    setBrand(b);
  };
  const save = async () => {
    setSaving(true);
    try {
      await api.put("/admin/brand", draft, { outletId: null });
      await refreshMe();
      toast("Brand saved for everyone in the business", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  if (!editable) {
    return (
      <Card>
        <CardHeader title="Business brand" subtitle={`Brand colour and corner style are set by ${me.business.name}.`} />
        <div className="flex items-center gap-3 p-5">
          <span className="h-10 w-10 shrink-0 rounded-full border border-line" style={{ background: saved.accent }} aria-hidden />
          <div className="text-sm">
            <p className="font-semibold">
              {ACCENT_PRESETS.find((p) => p.hex === saved.accent)?.name ?? saved.accent} · {saved.corners === "square" ? "Square" : "Rounded"} corners
            </p>
            <p className="text-muted">{prefs.accent ? "You're using your own accent colour (see above)." : "Want a different colour just for you? Turn on “Use my own accent colour”."}</p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Business brand"
        subtitle="Accent colour and corner style for everyone in your business. The preview applies on screen as you choose; Save to apply it for all staff."
      />
      <div className="space-y-5 p-5">
        {prefs.accent && (
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-sm text-muted">
            You use your own accent colour, so the brand colour won&apos;t show on your screen. Turn it off above to preview the brand.
          </p>
        )}
        <Row label="Brand colour">
          <AccentPicker label="Brand colour" value={draft.accent} onChange={(hex) => preview({ ...draft, accent: hex })} />
        </Row>
        <Row label="Corners">
          <Segmented<CornerStyle>
            value={draft.corners}
            onChange={(v) => preview({ ...draft, corners: v })}
            options={[
              { value: "rounded", label: "Rounded" },
              { value: "square", label: "Square" },
            ]}
          />
        </Row>
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <Button onClick={save} loading={saving} disabled={!dirty}>
            Save brand
          </Button>
          <Button variant="outline" disabled={!dirty || saving} onClick={() => preview(saved)}>
            Undo changes
          </Button>
          <Button variant="ghost" disabled={saving || (draft.accent === DEFAULT_ACCENT && draft.corners === "rounded")} onClick={() => preview(normalizeBrand({}))}>
            CANAVO default
          </Button>
        </div>
      </div>
    </Card>
  );
}

/** Live preview built from the real components, so colour, text size, density and corners all show. */
export function AppearancePreview() {
  const [tab, setTab] = useState<"dine" | "takeaway">("dine");
  return (
    <Card>
      <CardHeader title="Preview" subtitle="How screens look with your current choices" />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Charge ₹540</Button>
          <Button variant="outline">Hold</Button>
          <span className="inline-flex items-center rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-semibold text-primary">Preparing</span>
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "dine", label: "Dine-in" },
            { value: "takeaway", label: "Takeaway" },
          ]}
        />
        <Input label="Customer phone" placeholder="98xxxxxx10" />
        <div className="overflow-hidden rounded-xl border border-line">
          <Table>
            <THead>
              <tr>
                <Th>Item</Th>
                <Th className="text-right">Amount</Th>
              </tr>
            </THead>
            <tbody>
              <Tr>
                <Td>Masala dosa × 2</Td>
                <Td className="tabular text-right">₹240</Td>
              </Tr>
              <Tr>
                <Td>Filter coffee × 3</Td>
                <Td className="tabular text-right">₹300</Td>
              </Tr>
            </tbody>
          </Table>
        </div>
        <p className="text-sm">
          <span className="font-semibold text-primary underline-offset-2 hover:underline">A link in your accent colour</span>
        </p>
      </div>
    </Card>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[140px_1fr] sm:items-start">
      <div className="pt-2.5">
        <p className="text-sm font-semibold">{label}</p>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const Labelled = ({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) => (
  <span className="inline-flex items-center gap-1.5">
    {icon}
    {children}
  </span>
);
