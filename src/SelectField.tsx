import { useId } from "react";
import { Select } from "antd";

export type Option = { value: string; label: string };

export function SelectField({
  label,
  value,
  options,
  onChange,
  disabled,
  autoFocus,
  required,
  placeholder = "请选择",
  className = "",
  allowClear,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
  allowClear?: boolean;
}) {
  const id = useId();
  return (
    <div
      className={`select-field ${className}`.trim()}
      data-required={required || undefined}
    >
      <label id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      <Select
        id={id}
        aria-label={label}
        aria-labelledby={`${id}-label`}
        value={value || undefined}
        options={options}
        onChange={(next: string | undefined) => onChange(next ?? "")}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        allowClear={allowClear}
        showSearch
        optionFilterProp="label"
        virtual={false}
        style={{ width: "100%" }}
        getPopupContainer={(node) => node.parentElement ?? document.body}
      />
    </div>
  );
}
