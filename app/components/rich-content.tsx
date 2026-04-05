import DOMPurify from "dompurify";

type RichContentProps = {
  html: string;
  className?: string;
};

export function RichContent({ html, className }: RichContentProps) {
  const sanitizedHtml = DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "data-r2-key"],
  });

  return (
    <div
      className={["orca-rich-content", className].filter(Boolean).join(" ")}
      dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
    />
  );
}
