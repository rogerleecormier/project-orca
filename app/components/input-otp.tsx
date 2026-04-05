import { useEffect, useRef } from "react";

type InputOtpProps = {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  masked?: boolean;
};

export function InputOtp({ length = 6, value, onChange, masked = true }: InputOtpProps) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    refs.current = refs.current.slice(0, length);
  }, [length]);

  const normalized = value.slice(0, length).padEnd(length, " ");

  return (
    <div className="flex items-center gap-2">
      {Array.from({ length }).map((_, index) => {
        const char = normalized[index] === " " ? "" : normalized[index];

        return (
          <input
            key={index}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type={masked ? "password" : "text"}
            autoComplete="off"
            value={char}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            className="h-11 w-11 rounded-xl border border-slate-300 bg-white text-center text-lg font-semibold text-slate-900 outline-none ring-0 transition focus:border-cyan-500"
            onChange={(event) => {
              const next = event.target.value.replace(/\D/g, "").slice(-1);
              const chars = normalized.split("").map((c) => (c === " " ? "" : c));
              chars[index] = next;
              onChange(chars.join("").slice(0, length));
              if (next && index < length - 1) {
                refs.current[index + 1]?.focus();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && !char && index > 0) {
                refs.current[index - 1]?.focus();
              }
            }}
          />
        );
      })}
    </div>
  );
}
