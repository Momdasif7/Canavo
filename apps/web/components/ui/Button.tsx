import { forwardRef } from "react";
import clsx from "clsx";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "outline" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  block?: boolean;
}

const variants: Record<Variant, string> = {
  primary: "bg-primary text-primary-fg hover:bg-primary-600 active:bg-primary-700 shadow-sm",
  secondary: "bg-secondary text-white hover:bg-secondary-600 active:bg-secondary-700 shadow-sm",
  outline: "border border-line bg-surface text-fg hover:bg-surface-2",
  ghost: "text-fg hover:bg-surface-2",
  danger: "bg-red-600 text-white hover:bg-red-700 active:bg-red-800",
};

const sizes: Record<Size, string> = {
  sm: "min-h-[40px] px-3 text-sm gap-1.5",
  md: "min-h-tap px-4 text-[15px] gap-2",
  lg: "min-h-[56px] px-6 text-lg gap-2.5",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, icon, block, className, children, disabled, type = "button", onClick, ...rest },
  ref,
) {
  // While loading the button stays focusable (natively disabling it threw keyboard focus to <body>,
  // so closing the dialog it opened could not return focus — QA ui-8) but swallows every click /
  // implicit form submit: double-click protection is unchanged.
  const busy = Boolean(loading) && !disabled;
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={(e) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={clsx(
        "inline-flex select-none items-center justify-center rounded-xl font-semibold transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-wait aria-disabled:opacity-70",
        variants[variant],
        sizes[size],
        block && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="h-5 w-5" /> : icon}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex min-h-tap min-w-tap items-center justify-center rounded-xl text-fg transition-colors hover:bg-surface-2",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
