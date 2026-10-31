import type { MetadataRoute } from "next";
import { SITE_URL } from "@/components/landing/landing-meta";

// Keep the authenticated dashboard out of search results even if a logged-in
// user shares a URL. Marketing, booking and form pages stay crawlable.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/dashboard", "/dashboard/", "/sa/", "/agency/", "/me/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
