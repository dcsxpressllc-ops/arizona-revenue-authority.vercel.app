// Hello world
export async function sendNewInstanceAlert(_params: {
  instanceId: string;
  ownerEmail: string;
  platform: string | null;
  version: string | null;
  licenseState: string | null;
}): Promise<void> {
}
