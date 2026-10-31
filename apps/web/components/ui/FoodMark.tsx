import clsx from "clsx";
import type { FoodType } from "@/lib/types";

const styles: Record<FoodType, { color: string; label: string }> = {
  VEG: { color: "border-veg text-veg", label: "Vegetarian" },
  NON_VEG: { color: "border-nonveg text-nonveg", label: "Non-vegetarian" },
  EGG: { color: "border-egg text-egg", label: "Contains egg" },
};

/** Standard Indian food-type mark: a coloured square with a filled dot (triangle for non-veg per FSSAI 2022). */
export function FoodMark({ type, size = 14, className }: { type: FoodType; size?: number; className?: string }) {
  const s = styles[type];
  return (
    <span
      role="img"
      aria-label={s.label}
      title={s.label}
      className={clsx("inline-flex shrink-0 items-center justify-center rounded-[3px] border-[1.5px] bg-white", s.color, className)}
      style={{ width: size, height: size }}
    >
      {type === "NON_VEG" ? (
        <svg viewBox="0 0 10 10" style={{ width: size * 0.55, height: size * 0.55 }} aria-hidden>
          <path d="M5 1 L9.5 9 H0.5 Z" fill="currentColor" />
        </svg>
      ) : (
        <span className="rounded-full bg-current" style={{ width: size * 0.5, height: size * 0.5 }} />
      )}
    </span>
  );
}
