import { useEffect, useRef, useState } from "react";
import { InputOtp } from "./input-otp";

type DeleteConfirmModalProps = {
  open: boolean;
  itemLabel: string;
  itemName: string;
  onConfirm: (pin: string) => void;
  onCancel: () => void;
  error: string | null;
  loading: boolean;
};

export function DeleteConfirmModal({
  open,
  itemLabel,
  itemName,
  onConfirm,
  onCancel,
  error,
  loading,
}: DeleteConfirmModalProps) {
  const [pin, setPin] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setPin("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === backdropRef.current) onCancel(); }}
    >
      <div className="mx-4 w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-100 text-rose-600 text-lg">
            ⚠
          </span>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Delete {itemLabel}</h2>
            <p className="mt-1 text-sm text-slate-600">
              <span className="font-medium text-slate-900">"{itemName}"</span> will be permanently
              deleted. This cannot be undone.
            </p>
          </div>
        </div>

        <form
          className="mt-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (pin.length >= 4) onConfirm(pin);
          }}
        >
          <p className="text-sm font-medium text-slate-700">
            Enter your parent PIN to confirm
          </p>
          <div className="mt-3 flex justify-center">
            <InputOtp length={6} value={pin} onChange={setPin} />
          </div>

          {error ? (
            <p className="mt-3 text-center text-sm font-medium text-rose-700">{error}</p>
          ) : null}

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
              disabled={pin.length < 4 || loading}
              className="flex-1 rounded-xl bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
            >
              {loading ? "Deleting…" : "Delete"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
