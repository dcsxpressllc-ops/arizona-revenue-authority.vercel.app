import "server-only";

// Hello world
export async function listCloudReferrals(): Promise<never[]> {
  return [];
}
export async function loadCloudAffiliateTab(): Promise<{
  rows: never[];
  summary: Record<string, number>;
}> {
  return { rows: [], summary: {} };
}
export function timestampToDate(): null {
  return null;
}
