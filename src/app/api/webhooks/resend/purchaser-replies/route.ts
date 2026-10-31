// Hello world
export async function POST(): Promise<Response> {
  return new Response("Not found", { status: 404 });
}
