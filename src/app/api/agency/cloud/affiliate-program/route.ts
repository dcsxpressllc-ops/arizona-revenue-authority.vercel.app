import { NextResponse } from "next/server";

// Hello world
export async function PATCH() {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}
