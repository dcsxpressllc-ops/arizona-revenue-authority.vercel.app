import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminAuth, getAdminDb } from "@/lib/firebase/admin";
import { seedDefaultTemplates } from "@/lib/automations/seed-templates";
import { GLOBAL_TERRITORY_ID, type Role } from "@/types";
import { verifyInviteToken } from "@/lib/auth/invite-token";

interface SignupBody {
  email?: string;
  password?: string;
  displayName?: string;
  /** The `invite` param from the invite link (see lib/auth/invite-token). */
  inviteToken?: string;
}

type Decision =
  | { kind: "agencyOwner" }
  | {
      kind: "subAccountMember";
      adminUid: string;
      agencyId: string;
      subAccountId: string;
      subAccountRole: "admin" | "collaborator";
      inviteId: string;
      assignedTerritoryIds: string[];
      /** The caller presented this invite's link token. */
      tokenVerified: boolean;
    };

export async function POST(request: Request) {
  let body: SignupBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  const displayName = body.displayName?.trim() || email?.split("@")[0] || "";

  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 }
    );
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters." },
      { status: 400 }
    );
  }

  const db = getAdminDb();
  const auth = getAdminAuth();

  // 1. In a transaction: claim the agency-owner slot (no appConfig/main yet)
  // or consume a pending invite.
  let decision: Decision;
  try {
    decision = await db.runTransaction<Decision>(async (tx) => {
      const cfgSnap = await tx.get(db.doc("appConfig/main"));
      if (!cfgSnap.exists) {
        const bootstrap =
          process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
        if (bootstrap && bootstrap !== email) {
          throw new Error(
            "Only the configured bootstrap admin email may claim this agency."
          );
        }
        return { kind: "agencyOwner" };
      }
      const cfg = cfgSnap.data() ?? {};
      const adminUid = cfg.adminUid as string | undefined;
      if (!adminUid) {
        throw new Error("Workspace is misconfigured (missing adminUid).");
      }
      // Unrevoked, unaccepted invite for this email; it names the sub-account
      // and role to mint. `requiresToken` invites need the link token, or
      // anyone who knew the email could sign up first and take the role.
      // Invites without the flag still match on email alone.
      const tokenInviteId = verifyInviteToken(body.inviteToken);
      let inviteDoc: FirebaseFirestore.DocumentSnapshot;
      if (tokenInviteId) {
        const snap = await tx.get(db.doc(`invites/${tokenInviteId}`));
        const data = snap.data();
        if (
          !snap.exists ||
          !data ||
          data.email !== email ||
          data.acceptedByUid != null ||
          data.revokedAt != null
        ) {
          throw new Error(
            "This invite link is no longer valid. Ask the agency to re-invite you."
          );
        }
        inviteDoc = snap;
      } else {
        const inviteQuery = await tx.get(
          db
            .collection("invites")
            .where("email", "==", email)
            .where("acceptedByUid", "==", null)
            .where("revokedAt", "==", null)
        );
        if (inviteQuery.empty) {
          throw new Error(
            "This email is not invited. Ask the agency to invite you."
          );
        }
        const legacy = inviteQuery.docs.find(
          (d) => d.data().requiresToken !== true
        );
        if (!legacy) {
          throw new Error(
            "Open the invite link from your invitation email to create your account."
          );
        }
        inviteDoc = legacy;
      }
      const invite = inviteDoc.data() ?? {};
      const agencyId = invite.agencyId as string | undefined;
      const subAccountId = invite.subAccountId as string | null | undefined;
      const subAccountRole = invite.subAccountRole as
        | "admin"
        | "collaborator"
        | null
        | undefined;
      if (!agencyId || !subAccountId || !subAccountRole) {
        throw new Error(
          "Invite is missing tenancy fields. Ask the agency to re-invite you."
        );
      }
      // Pre-assigned territories (collaborators only). Empty defaults to Global.
      const rawTerritories = invite.assignedTerritoryIds;
      const assignedTerritoryIds =
        Array.isArray(rawTerritories) &&
        rawTerritories.length > 0 &&
        subAccountRole === "collaborator"
          ? rawTerritories.filter((x): x is string => typeof x === "string")
          : [GLOBAL_TERRITORY_ID];
      return {
        kind: "subAccountMember",
        adminUid,
        agencyId,
        subAccountId,
        subAccountRole,
        inviteId: inviteDoc.id,
        assignedTerritoryIds,
        tokenVerified: tokenInviteId !== null,
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signup not allowed.";
    return NextResponse.json({ error: message }, { status: 403 });
  }

  // 2. Create the Auth user after the gate so a rejection leaves no orphan.
  let userRecord;
  try {
    userRecord = await auth.createUser({
      email,
      password,
      displayName,
      // The token proves inbox access. claim-pending-invites relies on this
      // to attach other token-protected invites for the same email.
      emailVerified:
        decision.kind === "subAccountMember" && decision.tokenVerified,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "auth/email-already-exists") {
      return NextResponse.json(
        { error: "An account already exists for this email." },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Could not create account.",
      },
      { status: 500 }
    );
  }

  const uid = userRecord.uid;

  // 3. Claims plus the agency/sub-account/membership graph. On failure the
  // orphan auth user is deleted.
  try {
    if (decision.kind === "agencyOwner") {
      const agencyRef = db.collection("agencies").doc();
      const subAccountRef = db.collection("subAccounts").doc();
      const agencyId = agencyRef.id;
      const subAccountId = subAccountRef.id;
      const agencyName = `${displayName || email.split("@")[0]}'s Agency`;

      await auth.setCustomUserClaims(uid, {
        // Legacy claim, still read by some dashboard pages. Owner = admin.
        role: "admin" as Role,
        status: "active",
        agencyId,
        agencyRole: "owner",
      });

      const batch = db.batch();

      batch.set(db.doc(`users/${uid}`), {
        uid,
        email,
        displayName,
        photoURL: null,
        stripeCustomerId: null,
        subscriptionStatus: "inactive",
        subscriptionPriceId: null,
        role: "admin" as Role,
        status: "active",
        primaryAgencyId: agencyId,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      batch.set(agencyRef, {
        id: agencyId,
        name: agencyName,
        ownerUid: uid,
        stripeCustomerId: null,
        subscriptionStatus: "inactive",
        subscriptionPriceId: null,
        logoUrl: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      batch.set(agencyRef.collection("agencyMembers").doc(uid), {
        uid,
        agencyId,
        role: "owner",
        status: "active",
        email,
        displayName,
        addedAt: FieldValue.serverTimestamp(),
        addedByUid: uid,
      });

      batch.set(subAccountRef, {
        id: subAccountId,
        agencyId,
        accountNumber: 1000,
        name: "Main",
        slug: "main",
        status: "active",
        timezone: "UTC",
        createdByUid: uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        twilioConfig: null,
        resendConfig: null,
        emailDomainEnabledByAgency: false,
        outboundVoiceEnabledByAgency: false,
        whatsappEnabledByAgency: false,
        // Opt-out channels: these existed before agency gating, so default on.
        smsAgentEnabledByAgency: true,
        webChatEnabledByAgency: true,
        inboundVoiceEnabledByAgency: true,
        metaInboxEnabledByAgency: false,
        metaAgentEnabledByAgency: false,
        aiOutboundSmsEnabledByAgency: false,
        websiteEnabledByAgency: false,
        communityEnabledByAgency: false,
        getLeadsEnabledByAgency: false,
        missedCallTextBackEnabledByAgency: false,
        labsEnabledByAgency: false,
        paymentsEnabledByAgency: false,
        webinar1EnabledByAgency: false,
        webVoiceEnabledByAgency: false,
        sellOnlineEnabledByAgency: false,
        aiSuiteEnabledByAgency: false,
        metaConfig: null,
        stripeConnectionMeta: null,
        webinar1ConnectionMeta: null,
        bookingConfig: null,
        sendWindow: null,
        bookingLink: null,
        replyToEmail: null,
        automationsPaused: false,
      });

      // Seed the counter so the next sub-account gets 1001. Only
      // /api/agency/sub-accounts mutates it, inside a transaction.
      batch.set(agencyRef.collection("counters").doc("subAccount"), {
        next: 1001,
      });

      batch.set(subAccountRef.collection("subAccountMembers").doc(uid), {
        uid,
        subAccountId,
        agencyId,
        role: "admin",
        status: "active",
        email,
        displayName,
        addedAt: FieldValue.serverTimestamp(),
        addedByUid: uid,
        // Global, so scoping enabled later doesn't hide everything.
        assignedTerritoryIds: [GLOBAL_TERRITORY_ID],
      });

      // Per-user denormalized index, used by the sub-account switcher.
      batch.set(db.doc(`userMemberships/${uid}/agencies/${agencyId}`), {
        agencyId,
        role: "owner",
        name: agencyName,
      });
      batch.set(db.doc(`userMemberships/${uid}/subAccounts/${subAccountId}`), {
        subAccountId,
        agencyId,
        accountNumber: 1000,
        role: "admin",
        name: "Main",
        addedAt: FieldValue.serverTimestamp(),
      });

      batch.set(db.doc("appConfig/main"), {
        adminUid: uid,
        adminEmail: email,
        firstAgencyId: agencyId,
        firstAgencyOwnerUid: uid,
        bootstrapEmail: email,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Seed Welcome email + SMS templates so the owner has usable defaults.
      seedDefaultTemplates(db, (ref, data) => batch.set(ref, data), {
        agencyId,
        subAccountId,
        createdByUid: uid,
      });

      await batch.commit();

      return NextResponse.json({
        uid,
        role: "admin",
        agencyId,
        agencyRole: "owner",
        subAccountId,
        redirectTo: "/agency",
      });
    }

    // Invited sub-account member.
    const { agencyId, subAccountId, subAccountRole, inviteId } = decision;

    // Read the sub-account name once for the userMemberships index entry.
    const subSnap = await db.doc(`subAccounts/${subAccountId}`).get();
    const subName = (subSnap.data()?.name as string) ?? "Sub-account";

    await auth.setCustomUserClaims(uid, {
      // Legacy "role" claim only; real decisions read the membership doc.
      role: (subAccountRole === "admin" ? "admin" : "collaborator") as Role,
      status: "active",
      agencyId,
      agencyRole: null,
    });

    const batch = db.batch();

    batch.set(db.doc(`users/${uid}`), {
      uid,
      email,
      displayName,
      photoURL: null,
      stripeCustomerId: null,
      subscriptionStatus: "inactive",
      subscriptionPriceId: null,
      role: (subAccountRole === "admin" ? "admin" : "collaborator") as Role,
      status: "active",
      primaryAgencyId: agencyId,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    batch.set(db.doc(`subAccounts/${subAccountId}/subAccountMembers/${uid}`), {
      uid,
      subAccountId,
      agencyId,
      role: subAccountRole,
      status: "active",
      email,
      displayName,
      addedAt: FieldValue.serverTimestamp(),
      addedByUid: decision.adminUid,
      // Invite-time territories (collaborators only), else Global.
      assignedTerritoryIds: decision.assignedTerritoryIds,
    });

    batch.set(db.doc(`userMemberships/${uid}/subAccounts/${subAccountId}`), {
      subAccountId,
      agencyId,
      role: subAccountRole,
      name: subName,
      addedAt: FieldValue.serverTimestamp(),
    });

    batch.update(db.doc(`invites/${inviteId}`), {
      acceptedByUid: uid,
      acceptedAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();

    return NextResponse.json({
      uid,
      role: subAccountRole,
      agencyId,
      subAccountId,
      redirectTo: `/sa/${subAccountId}/dashboard`,
    });
  } catch (err) {
    await auth.deleteUser(uid).catch(() => undefined);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Could not finalize signup.",
      },
      { status: 500 }
    );
  }
}
