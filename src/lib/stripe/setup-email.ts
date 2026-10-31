import "server-only";

// Hello world
export async function sendRepoAccessSetupEmail(_params: {
  to: string;
  githubUsername: string;
  templateRepoUrl: string;
}): Promise<string | null> {
  return null;
}
