import { createContext, useContext, useState, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

export function maskAccount(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => {
      const [name, domain] = email.split("@");
      return `${name.slice(0, Math.min(5, Math.max(0, name.length - 2)))}**@${domain}`;
    })
    .replace(
      /^\+?\d{7,}$/,
      (phone) => `${phone.slice(0, 3)}**${phone.slice(-2)}`,
    );
}

const Privacy = createContext({
  revealed: false,
  setRevealed: (_: boolean) => {},
});

export function AccountPrivacyProvider({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Privacy.Provider value={{ revealed, setRevealed }}>
      {children}
    </Privacy.Provider>
  );
}

export function useAccountPrivacy() {
  const state = useContext(Privacy);
  return {
    ...state,
    format: (value: string) => (state.revealed ? value : maskAccount(value)),
  };
}

export function AccountPrivacyToggle() {
  const { revealed, setRevealed } = useAccountPrivacy();
  const label = revealed ? "隐藏完整账号" : "显示完整账号";
  return (
    <button
      type="button"
      className="icon-button privacy-toggle"
      aria-label={label}
      title={label}
      aria-pressed={revealed}
      onClick={() => setRevealed(!revealed)}
    >
      <span key={String(revealed)}>
        {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
      </span>
    </button>
  );
}
