declare module "html-to-docx" {
  type HtmlToDocxOptions = {
    table?: {
      row?: {
        cantSplit?: boolean;
      };
    };
    footer?: boolean;
    pageNumber?: boolean;
  };

  export default function htmlToDocx(
    html: string,
    headerHtml?: string | null,
    options?: HtmlToDocxOptions,
    footerHtml?: string | null,
  ): Promise<Blob>;
}
