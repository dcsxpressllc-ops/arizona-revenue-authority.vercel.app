import "server-only";

import { renderToBuffer, renderToStream } from "@react-pdf/renderer";
import { InvoicePdfDocument } from "@/lib/quotes/pdf-document";
import type { Quote } from "@/types/quotes";

/** Quote/Invoice PDF as a Web ReadableStream for `new NextResponse(stream)`. */
interface RenderInput {
  quote: Quote;
  businessName: string;
  businessLogoUrl?: string | null;
  recipientName: string;
  /** See InvoicePdfDocument; defaults to the full operator certificate. */
  certificateDetail?: "full" | "recipient";
}

export async function renderQuotePdfStream({
  quote,
  businessName,
  businessLogoUrl,
  recipientName,
  certificateDetail,
}: RenderInput): Promise<ReadableStream<Uint8Array>> {
  const nodeStream = await renderToStream(
    <InvoicePdfDocument
      quote={quote}
      businessName={businessName}
      businessLogoUrl={businessLogoUrl}
      recipientName={recipientName}
      certificateDetail={certificateDetail}
    />,
  );
  // renderToStream gives a Node Readable; convert so NextResponse works on any runtime.
  const { Readable } = await import("node:stream");
  return Readable.toWeb(
    nodeStream as unknown as InstanceType<typeof Readable>,
  ) as ReadableStream<Uint8Array>;
}

/** Same document as a Buffer, for email attachments. */
export async function renderQuotePdfBuffer({
  quote,
  businessName,
  businessLogoUrl,
  recipientName,
  certificateDetail,
}: RenderInput): Promise<Buffer> {
  return renderToBuffer(
    <InvoicePdfDocument
      quote={quote}
      businessName={businessName}
      businessLogoUrl={businessLogoUrl}
      recipientName={recipientName}
      certificateDetail={certificateDetail}
    />,
  );
}

export function pdfFilename(quote: Pick<Quote, "kind" | "quoteNumber">): string {
  const safe = quote.quoteNumber.replace(/[^A-Za-z0-9_-]+/g, "_");
  return `${safe}.pdf`;
}
