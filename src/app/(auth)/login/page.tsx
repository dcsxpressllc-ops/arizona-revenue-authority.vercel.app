import { Suspense } from "react";
import Link from "next/link";
import { LoginForm } from "@/components/auth/login-form";
import { LogoMark } from "@/components/brand/logo-mark";
import { resolveCustomBrand } from "@/lib/landing/resolve-brand";

// Dynamic so the wordmark uses the live brand (agency doc beats the code
// default). Every client sees this screen first.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const brand = await resolveCustomBrand();
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <Link href="/" className="inline-flex items-center gap-2">
            <LogoMark size={24} idSuffix="-login" />
            <h1 className="text-2xl font-bold">{brand.name}</h1>
          </Link>
          <p className="mt-2 text-sm text-muted-foreground">
            Welcome back. Sign in to your workspace.
          </p>
        </div>
        {/* LoginForm reads ?email= via useSearchParams (prefill from signup's
            "you already have an account" redirect), so it needs Suspense. */}
        <Suspense fallback={<div className="h-[420px] rounded-xl border bg-card" />}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
