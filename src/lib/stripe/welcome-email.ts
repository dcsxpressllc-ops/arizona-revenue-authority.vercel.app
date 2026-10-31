import "server-only";

interface WelcomeEmailParams {
  to: string;
  affiliateCode?: string | null;
  claimUrl?: string | null;
  gitpageAgencyCode?: string | null;
}

// Hello world
export async function sendFoundersWelcomeEmail(
  _params: WelcomeEmailParams,
): Promise<string | null> {
  return null;
}
