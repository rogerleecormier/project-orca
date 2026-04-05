import { useEffect, useRef } from "react";

type RichTextEditorProps = {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
};

type FormatCommand =
  | "bold"
  | "italic"
  | "underline"
  | "insertUnorderedList"
  | "insertOrderedList"
  | "formatBlock";

function execFormat(command: FormatCommand, value?: string) {
  document.execCommand(command, false, value);
}

const TOOLBAR_BUTTONS: Array<{
  label: string;
  command: FormatCommand;
  value?: string;
  title: string;
}> = [
  { label: "B", command: "bold", title: "Bold" },
  { label: "I", command: "italic", title: "Italic" },
  { label: "U", command: "underline", title: "Underline" },
  { label: "H2", command: "formatBlock", value: "h2", title: "Heading" },
  { label: "H3", command: "formatBlock", value: "h3", title: "Subheading" },
  { label: "• List", command: "insertUnorderedList", title: "Bullet list" },
  { label: "1. List", command: "insertOrderedList", title: "Numbered list" },
];

export function RichTextEditor({ value, onChange, disabled, placeholder }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const isInternalChange = useRef(false);

  // Sync external value into the editor only when it differs (avoids cursor jump)
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (isInternalChange.current) {
      isInternalChange.current = false;
      return;
    }
    if (el.innerHTML !== value) {
      el.innerHTML = value;
    }
  }, [value]);

  const handleInput = () => {
    if (!editorRef.current) return;
    isInternalChange.current = true;
    onChange(editorRef.current.innerHTML);
  };

  return (
    <div className="rounded-xl border border-slate-300 bg-white">
      <div className="flex flex-wrap gap-1 border-b border-slate-200 p-2">
        {TOOLBAR_BUTTONS.map((btn) => (
          <button
            key={btn.title}
            type="button"
            title={btn.title}
            disabled={disabled}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus in editor
              execFormat(btn.command, btn.value);
              handleInput();
            }}
            className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {btn.label}
          </button>
        ))}
      </div>

      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={handleInput}
        data-placeholder={placeholder ?? "Write your essay prompt here..."}
        className={[
          "min-h-40 px-3 py-2 text-sm text-slate-800 outline-none",
          "prose prose-sm max-w-none",
          "[&:empty]:before:text-slate-400 [&:empty]:before:content-[attr(data-placeholder)]",
          disabled ? "opacity-60" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      />
    </div>
  );
}
