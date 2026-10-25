import type { ChangeEvent, ReactNode } from "react";

export function Slider({
  label,
  display,
  value,
  min,
  max,
  step,
  disabled,
  className,
  onChange,
  onCommit,
}: {
  label?: string;
  display?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  className?: string;
  onChange(value: number): void;
  onCommit?(value: number): void;
}) {
  const clamped = Math.min(max, Math.max(min, value));
  const handle = (event: ChangeEvent<HTMLInputElement>) => onChange(Number(event.target.value));
  return (
    <div className="control-group">
      {label !== undefined || display !== undefined ? (
        <div className="field-row">
          {label !== undefined ? <span className="field-label">{label}</span> : <span />}
          {display !== undefined ? <span className="field-value">{display}</span> : null}
        </div>
      ) : null}
      <input
        type="range"
        className={className}
        min={min}
        max={max}
        step={step ?? (max - min) / 100}
        value={clamped}
        disabled={disabled}
        aria-label={label}
        onChange={handle}
        onPointerUp={onCommit ? () => onCommit(clamped) : undefined}
        onKeyUp={onCommit ? () => onCommit(clamped) : undefined}
      />
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? "switch on" : "switch"}
      onClick={() => onChange(!checked)}
    />
  );
}

export function ToggleRow({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <div className="field-row">
      <div style={{ minWidth: 0 }}>
        <div className="field-label">{label}</div>
        {help ? <div className="field-help">{help}</div> : null}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

/** An unavailable chip stays in place, dimmed, so the panel does not resize. */
export function Chip({
  label,
  on,
  available = true,
  onClick,
}: {
  label: string;
  on: boolean;
  available?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={on && available ? "chip on" : "chip"}
      disabled={!available}
      aria-pressed={on}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  value: T;
  onChange(next: T): void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={option.value === value ? "selected" : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PillToggle({
  label,
  on,
  onClick,
}: {
  label: string;
  on: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className={on ? "pill-toggle on" : "pill-toggle"}
      aria-pressed={on}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function LabelledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="labelled-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function PanelSection({ children }: { children: ReactNode }) {
  return <div className="panel-section">{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="panel-empty">{children}</div>;
}
