import { useEffect, useRef, useState } from "react";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import mammoth from "mammoth";

type RichTextEditorProps = {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
  documentName?: string;
  onUploadImage?: (file: File) => Promise<{ key: string }>;
};

type ToolbarIconProps = {
  className?: string;
};

function IconBold({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M7 5h6a4 4 0 1 1 0 8H7zM7 13h7a4 4 0 1 1 0 8H7z" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function IconItalic({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M14 4h6M10 20h6M14 4l-4 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconUnderline({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M8 4v7a4 4 0 0 0 8 0V4M6 20h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconHeadingTwo({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M4 5v14M10 5v14M4 12h6M15 8a3 3 0 0 1 6 0c0 3-3 3-6 6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconHeadingThree({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M3 5v14M9 5v14M3 12h6M16 8h5l-3 4m3 0h-5m5 0-3 4h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconBulletList({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="5" cy="7" r="1.5" fill="currentColor" />
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="5" cy="17" r="1.5" fill="currentColor" />
      <path d="M9 7h10M9 12h10M9 17h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconNumberList({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M3.5 7h2V5.5H4M4 10h1.5M3.5 15.5h2L3.5 18h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 7h10M10 12h10M10 17h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconIndent({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M10 7h10M10 12h10M10 17h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m4 12 4 3V9z" fill="currentColor" />
    </svg>
  );
}

function IconOutdent({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M10 7h10M10 12h10M10 17h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m8 12-4 3V9z" fill="currentColor" />
    </svg>
  );
}

function IconQuote({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M7 9h4v6H5v-4a4 4 0 0 1 4-4Zm10 0h4v6h-6v-4a4 4 0 0 1 4-4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function IconImage({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="9" cy="10" r="1.6" fill="currentColor" />
      <path d="m5 17 4-4 3 3 3-3 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconImport({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M12 17V11m0 0-3 3m3-3 3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconDocx({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8.5 16l2-3 2 3m2-3 2 3m-4 0 4-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconPdf({ className = "h-4 w-4" }: ToolbarIconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Zm0 0v6h6M8 17v-5h2.5a1.5 1.5 0 0 1 0 3H8m5-3v5m0-2h2a1.5 1.5 0 0 0 0-3h-2Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function slugifyDocumentName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "document";
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("FILE_READ_FAILED"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function buildExportHtml(bodyHtml: string) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Assignment Export</title>
    <style>
      body { font-family: Georgia, 'Times New Roman', serif; color: #1e293b; line-height: 1.65; margin: 40px; }
      h1, h2, h3 { color: #0f172a; margin: 1.2em 0 0.4em; }
      p { margin: 0.8em 0; }
      ul, ol { margin: 0.9em 0 0.9em 1.5em; padding-left: 1.25em; }
      li { margin: 0.3em 0; }
      blockquote { margin: 1.25em 0; padding-left: 1em; border-left: 4px solid #93c5fd; color: #334155; }
      img { max-width: 100%; height: auto; display: block; margin: 1em 0; border-radius: 12px; }
      a { color: #0f766e; text-decoration: underline; }
      pre { background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px; overflow-x: auto; }
    </style>
  </head>
  <body>${bodyHtml}</body>
</html>`;
}

export function RichTextEditor({
  value,
  onChange,
  disabled,
  placeholder,
  documentName,
  onUploadImage,
}: RichTextEditorProps) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const docxInputRef = useRef<HTMLInputElement>(null);
  const skipNextExternalSync = useRef(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [2, 3],
        },
      }),
      Underline,
      Link.configure({
        openOnClick: true,
        autolink: true,
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? "Write here...",
      }),
    ],
    content: value || "<p></p>",
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor: activeEditor }) => {
      skipNextExternalSync.current = true;
      onChange(activeEditor.getHTML());
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor) return;
    if (skipNextExternalSync.current) {
      skipNextExternalSync.current = false;
      return;
    }
    if (editor.getHTML() !== value) {
      editor.commands.setContent(value || "<p></p>", { emitUpdate: false });
    }
  }, [editor, value]);

  const insertImageFromFile = async (file: File) => {
    if (!editor) return;

    setBusyAction("Uploading image...");
    try {
      const dataUrl = await fileToDataUrl(file);
      let uploadedKey: string | undefined;

      if (onUploadImage) {
        const uploaded = await onUploadImage(file);
        uploadedKey = uploaded.key;
      }

      editor
        .chain()
        .focus()
        .setImage({
          src: dataUrl,
          alt: file.name,
          title: file.name,
          ...(uploadedKey ? { "data-r2-key": uploadedKey } : {}),
        })
        .run();
    } finally {
      setBusyAction(null);
    }
  };

  const importDocx = async (file: File) => {
    if (!editor) return;

    setBusyAction("Importing DOCX...");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.convertToHtml({ arrayBuffer });
      editor.chain().focus().setContent(result.value || "<p></p>").run();
    } finally {
      setBusyAction(null);
    }
  };

  const exportDocx = async () => {
    if (!editor) return;

    setBusyAction("Preparing DOCX...");
    try {
      const htmlToDocxModule = await import("html-to-docx");
      const htmlToDocx = htmlToDocxModule.default;
      const html = buildExportHtml(editor.getHTML());
      const blob = await htmlToDocx(html, null, {
        table: { row: { cantSplit: true } },
        footer: false,
        pageNumber: false,
      });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${slugifyDocumentName(documentName ?? "assignment")}.docx`;
      anchor.click();
      URL.revokeObjectURL(href);
    } finally {
      setBusyAction(null);
    }
  };

  const exportPdf = async () => {
    if (!editor) return;

    setBusyAction("Preparing PDF...");
    try {
      const html2pdfModule = await import("html2pdf.js");
      const html2pdf = (html2pdfModule.default ?? html2pdfModule) as {
        (): {
          from: (element: HTMLElement) => {
            set: (options: Record<string, unknown>) => {
              save: () => Promise<void>;
            };
          };
        };
      };

      const container = document.createElement("div");
      container.innerHTML = buildExportHtml(editor.getHTML());
      container.style.position = "fixed";
      container.style.left = "-10000px";
      container.style.top = "0";
      container.style.width = "800px";
      document.body.appendChild(container);

      try {
        await html2pdf()
          .from(container)
          .set({
            filename: `${slugifyDocumentName(documentName ?? "assignment")}.pdf`,
            margin: [0.5, 0.5, 0.5, 0.5],
            image: { type: "jpeg", quality: 0.98 },
            html2canvas: { scale: 2, useCORS: true },
            jsPDF: { unit: "in", format: "letter", orientation: "portrait" },
          })
          .save();
      } finally {
        document.body.removeChild(container);
      }
    } finally {
      setBusyAction(null);
    }
  };

  if (!editor) {
    return null;
  }

  const toolbarButtonClass = (active = false) =>
    [
      "inline-flex h-8 w-8 items-center justify-center rounded-lg border text-xs font-medium transition",
      active
        ? "border-cyan-400 bg-cyan-50 text-cyan-800"
        : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100",
      "disabled:cursor-not-allowed disabled:opacity-50",
    ].join(" ");

  const isWorking = Boolean(disabled || busyAction);

  return (
    <div className="rounded-xl border border-slate-300 bg-white shadow-sm">
      <div className="flex flex-wrap gap-1 border-b border-slate-200 p-2">
        <button
          type="button"
          title="Bold"
          aria-label="Bold"
          disabled={isWorking}
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={toolbarButtonClass(editor.isActive("bold"))}
        >
          <IconBold />
        </button>
        <button
          type="button"
          title="Italic"
          aria-label="Italic"
          disabled={isWorking}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={toolbarButtonClass(editor.isActive("italic"))}
        >
          <IconItalic />
        </button>
        <button
          type="button"
          title="Underline"
          aria-label="Underline"
          disabled={isWorking}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={toolbarButtonClass(editor.isActive("underline"))}
        >
          <IconUnderline />
        </button>
        <button
          type="button"
          title="Heading 2"
          aria-label="Heading 2"
          disabled={isWorking}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={toolbarButtonClass(editor.isActive("heading", { level: 2 }))}
        >
          <IconHeadingTwo />
        </button>
        <button
          type="button"
          title="Heading 3"
          aria-label="Heading 3"
          disabled={isWorking}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          className={toolbarButtonClass(editor.isActive("heading", { level: 3 }))}
        >
          <IconHeadingThree />
        </button>
        <button
          type="button"
          title="Bullet list"
          aria-label="Bullet list"
          disabled={isWorking}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={toolbarButtonClass(editor.isActive("bulletList"))}
        >
          <IconBulletList />
        </button>
        <button
          type="button"
          title="Numbered list"
          aria-label="Numbered list"
          disabled={isWorking}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={toolbarButtonClass(editor.isActive("orderedList"))}
        >
          <IconNumberList />
        </button>
        <button
          type="button"
          title="Indent"
          aria-label="Indent"
          disabled={isWorking}
          onClick={() => editor.chain().focus().sinkListItem("listItem").run()}
          className={toolbarButtonClass(false)}
        >
          <IconIndent />
        </button>
        <button
          type="button"
          title="Outdent"
          aria-label="Outdent"
          disabled={isWorking}
          onClick={() => editor.chain().focus().liftListItem("listItem").run()}
          className={toolbarButtonClass(false)}
        >
          <IconOutdent />
        </button>
        <button
          type="button"
          title="Block quote"
          aria-label="Block quote"
          disabled={isWorking}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={toolbarButtonClass(editor.isActive("blockquote"))}
        >
          <IconQuote />
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void insertImageFromFile(file);
            event.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          title="Insert image"
          aria-label="Insert image"
          disabled={isWorking}
          onClick={() => imageInputRef.current?.click()}
          className={toolbarButtonClass(false)}
        >
          <IconImage />
        </button>
        <input
          ref={docxInputRef}
          type="file"
          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void importDocx(file);
            event.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          title="Import DOCX"
          aria-label="Import DOCX"
          disabled={isWorking}
          onClick={() => docxInputRef.current?.click()}
          className={toolbarButtonClass(false)}
        >
          <IconImport />
        </button>
        <button
          type="button"
          title="Save DOCX"
          aria-label="Save DOCX"
          disabled={isWorking}
          onClick={() => void exportDocx()}
          className={toolbarButtonClass(false)}
        >
          <IconDocx />
        </button>
        <button
          type="button"
          title="Save PDF"
          aria-label="Save PDF"
          disabled={isWorking}
          onClick={() => void exportPdf()}
          className={toolbarButtonClass(false)}
        >
          <IconPdf />
        </button>
        {busyAction ? (
          <span className="ml-auto inline-flex items-center px-2 text-xs font-medium text-slate-500">
            {busyAction}
          </span>
        ) : null}
      </div>

      <EditorContent
        editor={editor}
        data-placeholder={placeholder ?? "Write here..."}
        className={[
          "min-h-44 px-4 py-3 text-sm text-slate-800 outline-none",
          "[&_.ProseMirror]:min-h-36 [&_.ProseMirror]:outline-none",
          "[&_.ProseMirror_h2]:mb-3 [&_.ProseMirror_h2]:mt-5 [&_.ProseMirror_h2]:text-2xl [&_.ProseMirror_h2]:font-semibold",
          "[&_.ProseMirror_h3]:mb-2 [&_.ProseMirror_h3]:mt-4 [&_.ProseMirror_h3]:text-lg [&_.ProseMirror_h3]:font-semibold",
          "[&_.ProseMirror_p]:my-3",
          "[&_.ProseMirror_ul]:my-3 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-7",
          "[&_.ProseMirror_ol]:my-3 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-7",
          "[&_.ProseMirror_li]:my-1",
          "[&_.ProseMirror_blockquote]:my-4 [&_.ProseMirror_blockquote]:border-l-4 [&_.ProseMirror_blockquote]:border-cyan-200 [&_.ProseMirror_blockquote]:pl-4 [&_.ProseMirror_blockquote]:italic [&_.ProseMirror_blockquote]:text-slate-600",
          "[&_.ProseMirror_img]:my-4 [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_img]:rounded-xl",
          "[&_.ProseMirror_a]:text-cyan-700 [&_.ProseMirror_a]:underline",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:pointer-events-none",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:float-left",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:h-0",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:text-slate-400",
          "[&_.ProseMirror_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
          disabled ? "opacity-60" : "",
        ].join(" ")}
      />
    </div>
  );
}
