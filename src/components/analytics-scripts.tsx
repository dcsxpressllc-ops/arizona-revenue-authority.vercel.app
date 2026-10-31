"use client";

import { useEffect } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";

/**
 * Site-wide analytics and support widget loaders. Each tag is opt-in via its
 * env var. Skipped on /embed/* so the chat iframe doesn't load Crisp inside
 * itself or fire stray PageViews. ?chat=1 (used in transactional emails)
 * auto-opens Crisp.
 */
export function AnalyticsScripts() {
  const pathname = usePathname();
  // /cloud/* carries the setup wizard's claim token in ?t=, and Pixel/GTM send
  // full URLs, so never load trackers there. (A stub page in buyer clones.)
  const isEmbed =
    (pathname?.startsWith("/embed/") || pathname?.startsWith("/cloud/")) ??
    false;
  // Funnel and checkout pages belong to a client's business; Crisp is the
  // agency's support channel, so it stays off. Pixel/GTM still load, like /f.
  const isClientPublic =
    (pathname?.startsWith("/fn/") || pathname?.startsWith("/co/")) ?? false;

  // The Crisp loader resets window.$crisp = [] on boot, so an early push gets
  // lost. Poll until the queue exists, capped at 5s in case Crisp never loads.
  useEffect(() => {
    if (isEmbed || isClientPublic) return;
    if (!process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID) return;
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("chat") !== "1") return;

    let elapsed = 0;
    const interval = window.setInterval(() => {
      elapsed += 100;
      if (window.$crisp) {
        window.$crisp.push(["do", "chat:open"]);
        window.clearInterval(interval);
      } else if (elapsed >= 5000) {
        window.clearInterval(interval);
      }
    }, 100);
    return () => window.clearInterval(interval);
  }, [isEmbed, isClientPublic]);

  if (isEmbed) return null;

  // /thank-you has the purchase claim token in ?t= and gtag reports
  // page_location, so send the bare path.
  const gtagConfig = pathname?.startsWith("/thank-you")
    ? `{page_location: window.location.origin + window.location.pathname}`
    : `{}`;

  return (
    <>
      {process.env.NEXT_PUBLIC_GOOGLE_TAG_ID && (
        <>
          <Script
            id="gtag-src"
            strategy="afterInteractive"
            src={`https://www.googletagmanager.com/gtag/js?id=${process.env.NEXT_PUBLIC_GOOGLE_TAG_ID}`}
          />
          <Script id="gtag-init" strategy="afterInteractive">
            {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${process.env.NEXT_PUBLIC_GOOGLE_TAG_ID}',${gtagConfig});`}
          </Script>
        </>
      )}
      {process.env.NEXT_PUBLIC_GTM_ID && (
        <Script id="gtm-script" strategy="afterInteractive">
          {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${process.env.NEXT_PUBLIC_GTM_ID}');`}
        </Script>
      )}
      {process.env.NEXT_PUBLIC_META_PIXEL_ID && (
        <Script id="meta-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${process.env.NEXT_PUBLIC_META_PIXEL_ID}');fbq('track','PageView');`}
        </Script>
      )}
      {process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID && !isClientPublic && (
        <Script id="crisp-widget" strategy="afterInteractive">
          {`window.$crisp=[];window.CRISP_WEBSITE_ID="${process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID}";(function(){d=document;s=d.createElement("script");s.src="https://client.crisp.chat/l.js";s.async=1;d.getElementsByTagName("head")[0].appendChild(s);})();`}
        </Script>
      )}
    </>
  );
}
