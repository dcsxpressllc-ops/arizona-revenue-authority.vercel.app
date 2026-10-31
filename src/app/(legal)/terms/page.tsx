import Link from "next/link";
import { CUSTOM_BRAND } from "@/config/landing";

// Starting-point template only. Replace every [BRACKETED] value, delete the
// sections that don't apply to your business, have it reviewed, then remove the banner.
export default function TermsPage() {
  const brand = CUSTOM_BRAND.name;
  const email = CUSTOM_BRAND.supportEmail;
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <Link
        href="/"
        className="text-sm text-muted-foreground hover:text-primary"
      >
        &larr; Back to home
      </Link>

      <div className="mt-8 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm">
        <strong>Template.</strong> These are placeholder Terms of Service.
        Replace them with your own (edit{" "}
        <code>src/app/(legal)/terms/page.tsx</code>) before you go live or
        submit them to an SMS carrier, payment provider or app review.
      </div>

      <article className="prose dark:prose-invert mt-8 max-w-none">
        <h1>Terms of Service</h1>
        <p className="text-sm text-muted-foreground">
          Last updated: [DATE]
        </p>

        <h2>1. Agreement</h2>
        <p>
          These Terms govern your use of the website and services provided by{" "}
          {brand}, operated by [LEGAL ENTITY NAME], [REGISTERED ADDRESS]
          (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By using our website or services
          you agree to these Terms. If you do not agree, do not use them.
        </p>

        <h2>2. Our Services</h2>
        <p>[DESCRIBE WHAT YOU PROVIDE AND TO WHOM.]</p>

        <h2>3. Accounts</h2>
        <p>
          If you have an account, you are responsible for keeping your login
          details secure and for activity under your account. Tell us promptly
          if you suspect unauthorised access.
        </p>

        <h2>4. Acceptable Use</h2>
        <p>
          You must not use our services to break the law, send spam or messages
          without the recipient&rsquo;s consent, infringe anyone&rsquo;s rights,
          upload harmful code, or interfere with the services or other users.
        </p>

        <h2>5. Fees, Payment and Refunds</h2>
        <p>[YOUR PRICING, BILLING, CANCELLATION AND REFUND TERMS.]</p>

        <h2>6. Text Messaging (SMS) Terms</h2>
        <p>
          [KEEP THIS SECTION IF YOU SEND TEXT MESSAGES.] By providing your
          mobile number and opting in, you agree to receive text messages from{" "}
          {brand} about [MESSAGE TYPES, e.g. appointment reminders, replies to
          your enquiries, account notifications and promotional offers].
        </p>
        <ul>
          <li>Message frequency varies.</li>
          <li>Message and data rates may apply.</li>
          <li>Reply STOP to opt out at any time. Reply HELP for help.</li>
          <li>
            Consent to receive text messages is not a condition of any
            purchase.
          </li>
          <li>
            Carriers are not liable for delayed or undelivered messages.
          </li>
          <li>
            For help, contact <a href={`mailto:${email}`}>{email}</a>. See our{" "}
            <Link href="/privacy">Privacy Policy</Link> for how we handle your
            mobile information.
          </li>
        </ul>

        <h2>7. Your Content</h2>
        <p>
          You keep ownership of information you submit to us. You give us
          permission to use it only as needed to provide our services and as
          described in our <Link href="/privacy">Privacy Policy</Link>.
        </p>

        <h2>8. Third-Party Services</h2>
        <p>
          Our services may rely on or link to third-party services. Their own
          terms apply, and we are not responsible for them.
        </p>

        <h2>9. Disclaimer</h2>
        <p>
          Our services are provided &ldquo;as is&rdquo; and &ldquo;as
          available&rdquo; to the extent permitted by law. Nothing in these
          Terms excludes rights you have under consumer law that cannot be
          excluded.
        </p>

        <h2>10. Limitation of Liability</h2>
        <p>
          To the extent permitted by law, we are not liable for indirect or
          consequential loss, and our total liability is limited to [YOUR
          LIABILITY CAP].
        </p>

        <h2>11. Termination</h2>
        <p>
          We may suspend or end your access if you breach these Terms. You may
          stop using our services at any time.
        </p>

        <h2>12. Governing Law</h2>
        <p>These Terms are governed by the laws of [JURISDICTION].</p>

        <h2>13. Changes to These Terms</h2>
        <p>
          We may update these Terms from time to time. We will post the updated
          version on this page with a new &ldquo;Last updated&rdquo; date.
        </p>

        <h2>14. Contact</h2>
        <p>
          Questions about these Terms: <a href={`mailto:${email}`}>{email}</a>,
          or write to [LEGAL ENTITY NAME], [POSTAL ADDRESS].
        </p>
      </article>
    </div>
  );
}
