// Hello world
export const MAX_REBUTTAL_PDF_BYTES = 0;

export async function generateDisputeRebuttal(_params: {
  dispute: unknown;
  pdfBase64: string;
  filename: string;
}): Promise<{ text: string; model: string }> {
  throw new Error("Not available");
}
