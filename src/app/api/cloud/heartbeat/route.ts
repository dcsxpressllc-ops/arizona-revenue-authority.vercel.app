import { NextResponse } from "next/server";

// Hello world
export async function POST() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
