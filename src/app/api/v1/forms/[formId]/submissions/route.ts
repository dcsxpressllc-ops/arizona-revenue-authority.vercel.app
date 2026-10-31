import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { withApiAuth } from "@/lib/api/auth";
import { apiError, apiOk } from "@/lib/api/responses";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { serializeContactForApi } from "@/lib/api/serializers/contacts";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import { GLOBAL_TERRITORY_ID } from "@/types";
import type { FormField } from "@/types/forms";

/**
 * POST /api/v1/forms/:formId/submissions
 * Body: { values: { [field_id]: string }, attribution?: {...} }
 *
 * For agencies with their own landing pages or form builder who want leads
 * to land here with the same automation as a hosted form. Needs a
 * `forms-ingest` or `admin` key. forms-ingest is write-only and safe in
 * client JS, which is why this is the only endpoint with open CORS.
 *
 * Checks the form is in the key's sub-account, maps values via
 * field.mapsTo, creates a mode-tagged contact + form_submitted activity,
 * fires automations, emits form.submitted, and returns contact + submission.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key, LeadStack-Version",
  "Access-Control-Max-Age": "86400",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

interface SubmitBody {
  values?: Record<string, string>;
}

function applyCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function mapValuesToContact(
  fields: FormField[],
  values: Record<string, string>,
): { name: string; email: string; phone: string; company: string } {
  const out = { name: "", email: "", phone: "", company: "" };
  for (const f of fields) {
    if (!f.mapsTo) continue;
    const v = (values[f.id] ?? "").toString().trim();
    if (!v) continue;
    if (f.mapsTo === "name" || f.mapsTo === "email" || f.mapsTo === "phone" || f.mapsTo === "company") {
      out[f.mapsTo] = v;
    }
  }
  return out;
}

export const POST = withApiAuth<{ formId: string }>(
  async ({ body, params, ctx }) => {
    const db = getAdminDb();
    const formSnap = await db.doc(`forms/${params.formId}`).get();
    if (!formSnap.exists) {
      return applyCors(
        apiError(ctx, "not_found", "form_not_found", "Form not found."),
      );
    }
    const form = formSnap.data()!;
    if (form.subAccountId !== ctx.subAccountId) {
      return applyCors(
        apiError(ctx, "not_found", "form_not_found", "Form not found."),
      );
    }

    const submitBody = (body ?? {}) as SubmitBody;
    const values = submitBody.values && typeof submitBody.values === "object"
      ? submitBody.values
      : {};

    const fields = (form.fields ?? []) as FormField[];
    const mapped = mapValuesToContact(fields, values);

    if (!mapped.name && !mapped.email && !mapped.phone) {
      return applyCors(
        apiError(
          ctx,
          "invalid_request",
          "no_identifying_field",
          "Submission must include at least one of name / email / phone.",
        ),
      );
    }

    // Mode-tagged so it stays on the key's live/test side. Same shape as the
    // dashboard form submit.
    const contactRef = db.collection("contacts").doc();
    await contactRef.set({
      name: mapped.name || mapped.email || mapped.phone,
      email: mapped.email,
      phone: mapped.phone,
      company: mapped.company,
      address: "",
      source: "website-form",
      tags: [],
      pipelineStage: null,
      territoryId: GLOBAL_TERRITORY_ID,
      attribution: null,
      emailOptedOut: false,
      smsOptedOut: false,
      countryCode: null,
      country: null,
      city: null,
      lat: null,
      lng: null,
      agencyId: ctx.agencyId,
      subAccountId: ctx.subAccountId,
      createdByUid: `apikey:${ctx.keyPrefix}`,
      mode: ctx.mode,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Raw submission for audit and the dashboard list.
    const submissionRef = await db
      .collection("forms")
      .doc(params.formId)
      .collection("submissions")
      .add({
        values,
        contactId: contactRef.id,
        mode: ctx.mode,
        agencyId: ctx.agencyId,
        subAccountId: ctx.subAccountId,
        source: "api",
        createdAt: FieldValue.serverTimestamp(),
      });

    // Live only: test submissions must never SMS or email a real person.
    if (ctx.mode === "live") {
      void fireWorkflowTrigger({
        agencyId: ctx.agencyId,
        subAccountId: ctx.subAccountId,
        type: "form.submitted",
        contactId: contactRef.id,
        context: { formId: params.formId },
      });
    }

    const created = await contactRef.get();
    const contactWire = serializeContactForApi(
      created.id,
      created.data()!,
      ctx.mode,
    );

    void emitWebhookEvent({
      subAccountId: ctx.subAccountId,
      agencyId: ctx.agencyId,
      mode: ctx.mode,
      type: "form.submitted",
      payload: {
        submission: {
          id: submissionRef.id,
          object: "form_submission",
          form_id: params.formId,
          contact: contactWire,
          values,
        },
      },
    });

    return applyCors(
      apiOk(
        ctx,
        {
          submission: {
            id: submissionRef.id,
            object: "form_submission",
            form_id: params.formId,
            contact: contactWire,
            values,
          },
        },
        { status: 201 },
      ),
    );
  },
  { requireScope: "forms-ingest" },
);
