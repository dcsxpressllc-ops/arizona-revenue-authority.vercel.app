import Link from "next/link";
import { CUSTOM_BRAND } from "@/config/landing";

// Starting-point template only. Replace every [BRACKETED] value, delete the
// sections that don't apply to your business, have it reviewed, then remove the banner.
export default function PrivacyPage() {
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
        <strong>Template.</strong> This is a placeholder Privacy Policy. Replace
        it with your own (edit <code>src/app/(legal)/privacy/page.tsx</code>)
        before you go live or submit it to an SMS carrier, payment provider or
        app review.
      </div>

      <article className="prose dark:prose-invert mt-8 max-w-none">
        <h1>Privacy Policy</h1>
        <p className="text-sm text-muted-foreground">
          Last updated: [DATE]
        </p>

        <h2>1. Who We Are</h2>
        <p>
          {brand} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is operated by [LEGAL
          ENTITY NAME], [REGISTERED ADDRESS]. This Privacy Policy explains how
          we collect, use and protect personal information when you visit our
          website, contact us, or use our services.
        </p>

        <h2>2. Information We Collect</h2>
        <ul>
          <li>
            <strong>Information you give us:</strong> name, email address,
            phone number, business details, and anything you include in forms,
            messages, bookings or calls.
          </li>
          <li>
            <strong>Information collected automatically:</strong> IP address,
            browser and device type, pages viewed, and cookies or similar
            technologies.
          </li>
          <li>
            <strong>Payment information:</strong> processed by our payment
            provider. We do not store full card numbers.
          </li>
          <li>[ANY OTHER CATEGORIES SPECIFIC TO YOUR BUSINESS]</li>
        </ul>

        <h2>3. How We Use Information</h2>
        <p>
          We use personal information to provide and support our services,
          respond to enquiries, schedule appointments, send service and account
          messages, send marketing where you have agreed to receive it, process
          payments, improve our website, and meet our legal obligations.
        </p>

        <h2>4. Text Messaging (SMS)</h2>
        <p>
          [KEEP THIS SECTION IF YOU SEND TEXT MESSAGES.] If you provide your
          mobile number and agree to receive text messages, we use it to send
          the messages you agreed to. You can reply STOP at any time to opt out,
          or HELP for help.
        </p>
        <p>
          <strong>
            We do not sell, rent or share mobile phone numbers or SMS opt-in
            consent with third parties or affiliates for their marketing or
            promotional purposes.
          </strong>{" "}
          Mobile information is shared only with the messaging and telecom
          providers that deliver our messages. Text messaging originator opt-in
          data and consent will not be shared with any third parties.
        </p>

        <h2>5. Sharing and Service Providers</h2>
        <p>
          We do not sell your personal information. We share it only with
          service providers that help us run our business (such as hosting,
          email, messaging, scheduling and payment providers), who receive only
          what they need to perform their function, and where required by law.
          [LIST KEY PROVIDERS IF YOUR JURISDICTION REQUIRES IT.]
        </p>

        <h2>6. Data Retention</h2>
        <p>
          We keep personal information for as long as needed to provide our
          services and meet legal, accounting and dispute-resolution
          requirements, then delete or anonymise it. [YOUR RETENTION PERIOD.]
        </p>

        <h2>7. Your Rights</h2>
        <p>
          Depending on where you live, you may have the right to access,
          correct, delete or export your personal information, and to object to
          or restrict how we use it. You can unsubscribe from marketing emails
          using the link in any email. To make a request, contact us using the
          details below. [ADD ANY RIGHTS OR COMPLAINT BODIES REQUIRED IN YOUR
          JURISDICTION.]
        </p>

        <h2>8. Security</h2>
        <p>
          We use reasonable technical and organisational measures to protect
          personal information. No method of transmission or storage is
          completely secure.
        </p>

        <h2>9. Children</h2>
        <p>
          Our services are not directed to children under [AGE], and we do not
          knowingly collect their personal information.
        </p>

        <h2>10. Changes to This Policy</h2>
        <p>
          We may update this policy from time to time. We will post the updated
          version on this page with a new &ldquo;Last updated&rdquo; date.
        </p>

        <h2>11. Contact</h2>
        <p>
          Questions or requests about this policy: <a href={`mailto:${email}`}>{email}</a>,
          or write to [LEGAL ENTITY NAME], [POSTAL ADDRESS].
        </p>
      </article>
    </div>
  );
}
