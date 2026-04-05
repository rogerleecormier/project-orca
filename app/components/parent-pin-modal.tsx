import { useEffect, useRef, useState } from "react";
import { InputOtp } from "./input-otp";

type ParentPinModalProps = {
  open: boolean;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
  error: string | null;
  loading: boolean;
  pinLength?: number | null;
};

export function ParentPinModal({
  open,
  onSubmit,
  onCancel,
  error,
  loading,
  pinLength = null,
}: ParentPinModalProps) {
  const [pin, setPin] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);
  const effectiveLength = pinLength ?? 6;
  const canSubmit = pin.length === effectiveLength;

  useEffect(() => {
    if (open) {
      setPin("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === backdropRef.current) {
          onCancel();
        }
      }}
    >
      <div className="mx-4 w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-slate-900">Parent PIN Required</h2>
        <p className="mt-1 text-sm text-slate-600">
          Enter your parent PIN to switch to student view.
        </p>

        <form
          className="mt-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) {
              onSubmit(pin);
            }
          }}
        >
          <div className="flex justify-center">
            <InputOtp length={effectiveLength} value={pin} onChange={setPin} />
          </div>

          {error ? <p className="mt-3 text-center text-sm font-medium text-rose-700">{error}</p> : null}

          <div className="mt-5 flex gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={loading}
              className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit || loading}
              className="flex-1 rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-60"
            >
              {loading ? "Verifying..." : "Continue"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
