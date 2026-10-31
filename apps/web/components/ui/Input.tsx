import { forwardRef, useId } from "react";
import clsx from "clsx";

const fieldBase =
  "w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] text-fg placeholder:text-muted/70 " +
  "focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60";

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-sm font-semibold text-fg">
          {label}
        </label>
      )}
      {children}
      {error ? <p className="text-sm font-medium text-red-600">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  prefix?: React.ReactNode;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, prefix, className, wrapperClassName, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const input = (
    <div className="relative">
      {prefix && <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-muted">{prefix}</span>}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={!!error}
        className={clsx(fieldBase, "min-h-tap", prefix && "pl-9", error && "border-red-500", className)}
        {...rest}
      />
    </div>
  );
  if (!label && !hint && !error) return wrapperClassName ? <div className={wrapperClassName}>{input}</div> : input;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={inputId} className={wrapperClassName}>
      {input}
    </Field>
  );
});

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: string | null;
  wrapperClassName?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, className, wrapperClassName, id, children, ...rest },
  ref,
) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const select = (
    <select ref={ref} id={selectId} className={clsx(fieldBase, "min-h-tap pr-8", className)} {...rest}>
      {children}
    </select>
  );
  if (!label && !hint && !error) return wrapperClassName ? <div className={wrapperClassName}>{select}</div> : select;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={selectId} className={wrapperClassName}>
      {select}
    </Field>
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: React.ReactNode; error?: string | null }
>(function Textarea({ label, error, className, id, ...rest }, ref) {
  const autoId = useId();
  const tid = id ?? autoId;
  return (
    <Field label={label} error={error} htmlFor={tid}>
      <textarea ref={ref} id={tid} className={clsx(fieldBase, "min-h-[80px] py-2.5", className)} {...rest} />
    </Field>
  );
});

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={clsx("flex min-h-tap cursor-pointer items-center justify-between gap-4", disabled && "cursor-not-allowed opacity-60")}>
      {(label || description) && (
        <span>
          <span className="block text-sm font-semibold text-fg">{label}</span>
          {description && <span className="block text-xs text-muted">{description}</span>}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative inline-block h-7 w-12 shrink-0 rounded-full p-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
          checked ? "bg-secondary" : "bg-line",
        )}
      >
        <span
          className={clsx(
            // Pinned to the left edge: buttons centre their content, so without left-0 the knob starts mid-track.
            "pointer-events-none absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-5" : "translate-x-0",
          )}
        />
      </button>
    </label>
  );
}
