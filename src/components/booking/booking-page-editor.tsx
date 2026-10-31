"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { hasCardRail, hasPaypalRail } from "@/lib/payments/can-take-payment";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { collection, onSnapshot } from "firebase/firestore";
import {
  AlertTriangle,
  HelpCircle,
  Loader2,
  Save,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { getFirebaseDb } from "@/lib/firebase/client";
import { useAuth } from "@/hooks/use-auth";
import { useAgencyOwnerUid } from "@/hooks/use-agency-owner-uid";
import { useSubAccount } from "@/context/sub-account-context";
import type { SubAccountMemberDoc } from "@/types/tenancy";
import { TerritorySelectField } from "@/components/settings/territory-select-field";
import { WorkingHoursGrid } from "@/components/booking/working-hours-grid";
import { IntakeFieldBuilder } from "@/components/booking/intake-field-builder";
import { BookingHelpDialog } from "@/components/booking/booking-help-dialog";
import { TeamBookingHelpDialog } from "@/components/booking/team-booking-help-dialog";
import { ThemePresetPicker } from "@/components/checkout/theme-preset-picker";
import {
  defaultBookingPageFormData,
  detectTimezone,
} from "@/lib/booking/defaults";
import {
  DEFAULT_PAYMENT_HOLD_HOURS,
  type BookingLocationType,
  type BookingPage,
  type BookingPageFormData,
  type BookingPayment,
  type WorkingHour,
} from "@/types/booking";
import {
  BOOKING_LOCATION_OPTIONS,
  effectiveBookingLocation,
  locationNeedsValue,
} from "@/lib/booking/location";

/**
 * Create/edit form for a booking page: one long page in sections. POSTs to
 * /booking-pages when new, PATCHes /booking-pages/[slug] when editing.
 * Delete (edit mode) confirms inline.
 */

interface Props {
  mode: "new" | "edit";
  /** Edit mode only. */
  initial?: BookingPage;
}

const DURATIONS = [15, 30, 45, 60, 75, 90, 120] as const;
const BUFFERS = [0, 5, 10, 15, 30, 45, 60] as const;
const CURRENCIES = ["USD", "AUD", "EUR", "GBP", "CAD"] as const;

// Common zones first so nobody scrolls past Africa/* to find Australia/Sydney.
const COMMON_TIMEZONES = [
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Brisbane",
  "Australia/Perth",
  "Pacific/Auckland",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "UTC",
];

function allTimezones(): string[] {
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf;
    if (typeof supported === "function") return supported("timeZone");
  } catch {
    /* fall through */
  }
  return COMMON_TIMEZONES;
}

export function BookingPageEditor({ mode, initial }: Props) {
  const router = useRouter();
  const { subAccountId, subAccount, saPath } = useSubAccount();
  const scopingOn = subAccount?.territoryScopingEnabled === true;
  // Either rail unlocks Payment (lib/payments/can-take-payment).
  const hasPaypal = hasPaypalRail(subAccount);
  const hasCard = hasCardRail(subAccount);
  const canTakePayment = hasPaypal || hasCard;

  const hydrated: BookingPageFormData = useMemo(() => {
    if (mode === "edit" && initial) {
      return {
        slug: initial.slug,
        name: initial.name,
        description: initial.description,
        status: initial.status,
        durationMinutes: initial.durationMinutes,
        bufferMinutes: initial.bufferMinutes,
        workingHours: initial.workingHours,
        timezone: initial.timezone,
        visibleDays: initial.visibleDays,
        minNoticeHours: initial.minNoticeHours,
        maxPerDay: initial.maxPerDay,
        intakeFields: initial.intakeFields,
        hosts: initial.hosts ?? [],
        allowHostSelection: initial.allowHostSelection ?? false,
        logoUrl: initial.logoUrl,
        accentColor: initial.accentColor,
        themePreset: initial.themePreset ?? null,
        meetingUrl: initial.meetingUrl ?? null,
        googleMeet: initial.googleMeet ?? false,
        // Older pages have no location; derive it so they don't open as "not set".
        location: effectiveBookingLocation(initial),
        confirmationMessage: initial.confirmationMessage,
        redirectUrl: initial.redirectUrl ?? null,
        redirectAppendParams: initial.redirectAppendParams ?? true,
        remindersEnabled: initial.remindersEnabled,
        smsRemindersEnabled: initial.smsRemindersEnabled ?? false,
        reminderOffsetsMinutes: initial.reminderOffsetsMinutes,
        payment: initial.payment,
        defaultTerritoryId: initial.defaultTerritoryId,
      };
    }
    return defaultBookingPageFormData(
      // Blank on new so it's typed explicitly; suggested from the name on blur.
      "",
      detectTimezone(),
    );
  }, [mode, initial]);

  const [form, setForm] = useState<BookingPageFormData>(hydrated);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [teamHelpOpen, setTeamHelpOpen] = useState(false);

  // Follow the doc if it refreshes mid-edit.
  useEffect(() => {
    if (mode === "edit") setForm(hydrated);
  }, [mode, hydrated]);

  function set<K extends keyof BookingPageFormData>(
    key: K,
    value: BookingPageFormData[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // No hosts selected = one shared schedule; any selected = team mode.
  const [members, setMembers] = useState<{ uid: string; name: string }[]>([]);
  useEffect(() => {
    if (!subAccountId) return;
    const unsub = onSnapshot(
      collection(getFirebaseDb(), `subAccounts/${subAccountId}/subAccountMembers`),
      (snap) => {
        setMembers(
          snap.docs
            .map((d) => d.data() as SubAccountMemberDoc)
            .filter((m) => m.status === "active")
            .map((m) => ({
              uid: m.uid,
              name: m.displayName || m.email || "Member",
            })),
        );
      },
      () => setMembers([]),
    );
    return () => unsub();
  }, [subAccountId]);

  // Per-member Google connection status so the picker shows who is
  // conflict-protected. Informational only.
  const [calendarStatus, setCalendarStatus] = useState<
    Map<string, "connected" | "error">
  >(new Map());
  useEffect(() => {
    if (!subAccountId) return;
    const unsub = onSnapshot(
      collection(
        getFirebaseDb(),
        `subAccounts/${subAccountId}/calendarConnections`,
      ),
      (snap) => {
        const next = new Map<string, "connected" | "error">();
        for (const d of snap.docs) {
          const c = d.data() as { uid?: string; status?: string };
          if (c.uid) {
            next.set(c.uid, c.status === "connected" ? "connected" : "error");
          }
        }
        setCalendarStatus(next);
      },
      () => setCalendarStatus(new Map()),
    );
    return () => unsub();
  }, [subAccountId]);

  // Hide the agency owner from the host picker for non-owners, or the platform
  // provider becomes bookable for a client's appointments. A host already saved
  // stays visible so a live page's availability doesn't change silently.
  // Fail-open: ownerUid is null while loading.
  const { agencyRole, user } = useAuth();
  const ownerUid = useAgencyOwnerUid();

  // Whose calendar gets the bookings (and Meet rooms): each assigned host in
  // team mode, else the member who created the page (mirrors
  // bookingCalendarOwnerUid on the server).
  const isTeamPage = (form.hosts ?? []).length > 0;
  const pageOwnerUid =
    mode === "edit" ? (initial?.createdByUid ?? null) : (user?.uid ?? null);
  const pageOwnerName =
    members.find((m) => m.uid === pageOwnerUid)?.name ?? "the page's creator";
  const meetCalendarsReady = isTeamPage
    ? (form.hosts ?? []).every((h) => calendarStatus.get(h.uid) === "connected")
    : !!pageOwnerUid && calendarStatus.get(pageOwnerUid) === "connected";
  const selectedHostUids = new Set((form.hosts ?? []).map((h) => h.uid));
  const selectableMembers = members.filter(
    (m) =>
      agencyRole === "owner" ||
      !ownerUid ||
      m.uid !== ownerUid ||
      selectedHostUids.has(m.uid),
  );

  function toggleHost(uid: string, name: string, checked: boolean) {
    const current = form.hosts ?? [];
    if (checked) {
      if (current.some((h) => h.uid === uid)) return;
      set("hosts", [...current, { uid, name }]);
    } else {
      const next = current.filter((h) => h.uid !== uid);
      set("hosts", next);
      // No hosts left means no team mode, so clear customer-picks too.
      if (next.length === 0 && form.allowHostSelection) {
        set("allowHostSelection", false);
      }
    }
  }

  // null or empty removes the override; the host inherits the page schedule.
  function setHostCustomHours(uid: string, hours: WorkingHour[] | null) {
    const current = form.hosts ?? [];
    set(
      "hosts",
      current.map((h) => {
        if (h.uid !== uid) return h;
        if (hours && hours.length > 0) return { ...h, workingHours: hours };
        const next = { ...h };
        delete next.workingHours;
        return next;
      }),
    );
  }

  // Enabling seeds from the page schedule so the operator edits, not starts empty.
  function toggleHostCustomHours(uid: string, enabled: boolean) {
    setHostCustomHours(uid, enabled ? form.workingHours : null);
  }

  function togglePayment(enabled: boolean) {
    if (!enabled) {
      set("payment", null);
      return;
    }
    const next: BookingPayment = form.payment ?? {
      amount: 50,
      currency: "USD",
      description: null,
      holdHours: DEFAULT_PAYMENT_HOLD_HOURS,
    };
    set("payment", next);
  }

  function setPayment<K extends keyof BookingPayment>(
    key: K,
    value: BookingPayment[K],
  ) {
    if (!form.payment) return;
    set("payment", { ...form.payment, [key]: value });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const url =
        mode === "new"
          ? `/api/sub-accounts/${subAccountId}/booking-pages`
          : `/api/sub-accounts/${subAccountId}/booking-pages/${form.slug}`;
      const method = mode === "new" ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        slug?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Could not save.");
      }
      toast.success(
        mode === "new" ? "Booking page created." : "Saved.",
      );
      if (mode === "new") {
        router.push(saPath(`/booking/${data.slug ?? form.slug}`));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (mode !== "edit") return;
    if (
      !confirm(
        `Delete "${form.name}"? The public link stops working immediately. Past bookings stay in the calendar.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/booking-pages/${form.slug}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        futureCount?: number;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Could not delete.");
      }
      toast.success("Deleted.");
      router.push(saPath("/booking"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete.");
    } finally {
      setDeleting(false);
    }
  }

  const timezoneList = useMemo(() => allTimezones(), []);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="flex items-center justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setHelpOpen(true)}
        >
          <HelpCircle className="mr-1 h-3.5 w-3.5" />
          How it works
        </Button>
      </div>

      <BookingHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
      <TeamBookingHelpDialog
        open={teamHelpOpen}
        onOpenChange={setTeamHelpOpen}
      />

      {/* Basics */}
      <Section
        title="Basics"
        description="What this page is, and the URL slug visitors see."
      >
        <Field label="Page name" htmlFor="name" required>
          <Input
            id="name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="30-minute consultation"
            maxLength={80}
            required
          />
        </Field>

        <Field
          label="URL slug"
          htmlFor="slug"
          required
          hint={
            mode === "edit"
              ? "Slug can't be changed after creation — public links would break."
              : "Lowercase letters, numbers, and hyphens. 1–48 chars."
          }
        >
          <Input
            id="slug"
            value={form.slug}
            onChange={(e) =>
              set("slug", e.target.value.toLowerCase().replace(/\s+/g, "-"))
            }
            onBlur={(e) => {
              if (mode === "new" && !e.target.value && form.name) {
                set(
                  "slug",
                  form.name
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "")
                    .slice(0, 48),
                );
              }
            }}
            placeholder="30-min-consult"
            maxLength={48}
            disabled={mode === "edit"}
            required
          />
        </Field>

        <Field
          label="Description"
          htmlFor="description"
          hint="Shown on the public page above the slot picker. Markdown supported."
        >
          <Textarea
            id="description"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Spend 30 minutes with our team to map out…"
          />
        </Field>

        <Field
          label="Where does this meeting happen?"
          htmlFor="locationType"
          required
          hint={
            form.location
              ? BOOKING_LOCATION_OPTIONS.find((o) => o.type === form.location?.type)?.hint
              : "Required to publish. Shown to bookers, the AI agents, confirmations, reminders and the calendar invite."
          }
        >
          <select
            id="locationType"
            value={form.location?.type ?? ""}
            onChange={(e) => {
              const next = e.target.value as BookingLocationType | "";
              if (!next) {
                // Also drop the link fields, or an older page would still read
                // as a video/Meet location through them.
                set("location", null);
                set("googleMeet", false);
                set("meetingUrl", null);
                return;
              }
              // Keep the typed address/number only when the new type uses the same kind.
              const keep =
                form.location &&
                locationNeedsValue(form.location.type) === locationNeedsValue(next)
                  ? form.location.value
                  : null;
              set("location", { type: next, value: keep });
              set("googleMeet", next === "google_meet");
            }}
            className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
          >
            <option value="">Choose…</option>
            {BOOKING_LOCATION_OPTIONS.map((o) => (
              <option key={o.type} value={o.type}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        {form.location?.type === "in_person" && (
          <Field label="Address" htmlFor="locationAddress" required>
            <Input
              id="locationAddress"
              value={form.location.value ?? ""}
              onChange={(e) =>
                set("location", { type: "in_person", value: e.target.value })
              }
              maxLength={300}
              placeholder="12 Smith St, Sydney NSW 2000"
            />
          </Field>
        )}

        {form.location?.type === "they_call" && (
          <Field label="Number to call" htmlFor="locationPhone" required>
            <Input
              id="locationPhone"
              type="tel"
              value={form.location.value ?? ""}
              onChange={(e) =>
                set("location", { type: "they_call", value: e.target.value })
              }
              maxLength={40}
              placeholder="+61 2 9000 0000"
            />
          </Field>
        )}

        {(form.location?.type === "video_link" ||
          form.location?.type === "google_meet") && (
          <Field
            label={
              form.location.type === "google_meet"
                ? "Fallback meeting URL (optional)"
                : "Meeting URL"
            }
            htmlFor="meetingUrl"
            required={form.location.type === "video_link"}
            hint={
              form.location.type === "google_meet"
                ? "Used when a Google Meet link can't be made for a booking."
                : "Zoom, Teams, Whereby or any video-call URL. Added to the confirmation email + the calendar invite so attendees can join with one click."
            }
          >
            <Input
              id="meetingUrl"
              type="url"
              value={form.meetingUrl ?? ""}
              onChange={(e) =>
                set(
                  "meetingUrl",
                  e.target.value.trim().length > 0 ? e.target.value.trim() : null,
                )
              }
              maxLength={1000}
              placeholder="https://zoom.us/j/1234567890"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}

        {form.location?.type === "google_meet" && (
          <p className="text-xs text-muted-foreground">
            A unique Meet link is made on{" "}
            {isTeamPage
              ? "the assigned host's Google Calendar"
              : `${pageOwnerName}'s Google Calendar`}{" "}
            and sent in the confirmation, reminders and calendar invite.
            {!meetCalendarsReady && (
              <span className="mt-1 block text-amber-700 dark:text-amber-400">
                {isTeamPage
                  ? "Not every host has connected Google Calendar yet; their bookings fall back to the meeting URL above."
                  : `${pageOwnerName} hasn't connected Google Calendar in this workspace yet, so bookings fall back to the meeting URL above.`}
              </span>
            )}
          </p>
        )}

        <Field
          label="Status"
          htmlFor="status"
          hint="Drafts are invisible to visitors. Publish when you're ready to share the link."
        >
          <select
            id="status"
            value={form.status}
            onChange={(e) =>
              set("status", e.target.value as "draft" | "published")
            }
            className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
          >
            <option value="draft">Draft (hidden)</option>
            <option value="published">Published (public)</option>
          </select>
        </Field>
      </Section>

      {/* Slot rules */}
      <Section
        title="Slot rules"
        description="How long meetings run, how far ahead visitors can book, and when you're available."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Duration" htmlFor="duration">
            <select
              id="duration"
              value={form.durationMinutes}
              onChange={(e) =>
                set("durationMinutes", Number(e.target.value))
              }
              className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
            >
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d} minutes
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Buffer between meetings"
            htmlFor="buffer"
            hint="Time to breathe between back-to-back bookings."
          >
            <select
              id="buffer"
              value={form.bufferMinutes}
              onChange={(e) => set("bufferMinutes", Number(e.target.value))}
              className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
            >
              {BUFFERS.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? "None" : `${d} minutes`}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Timezone" htmlFor="timezone">
          <select
            id="timezone"
            value={form.timezone}
            onChange={(e) => set("timezone", e.target.value)}
            className="flex h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
          >
            <optgroup label="Common">
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </optgroup>
            {timezoneList.length > COMMON_TIMEZONES.length && (
              <optgroup label="All">
                {timezoneList
                  .filter((tz) => !COMMON_TIMEZONES.includes(tz))
                  .map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
        </Field>

        <WorkingHoursGrid
          value={form.workingHours}
          onChange={(next) => set("workingHours", next)}
          disabled={saving}
        />

        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Visible days"
            htmlFor="visibleDays"
            hint="How far into the future visitors can book."
          >
            <Input
              id="visibleDays"
              type="number"
              min={1}
              max={90}
              value={form.visibleDays}
              onChange={(e) => set("visibleDays", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Min notice (hours)"
            htmlFor="minNotice"
            hint="Block bookings closer than this to now."
          >
            <Input
              id="minNotice"
              type="number"
              min={0}
              max={168}
              value={form.minNoticeHours}
              onChange={(e) =>
                set("minNoticeHours", Number(e.target.value))
              }
            />
          </Field>
          <Field
            label="Max per day"
            htmlFor="maxPerDay"
            hint="Cap on bookings per day. Leave blank for unlimited."
          >
            <Input
              id="maxPerDay"
              type="number"
              min={1}
              max={100}
              value={form.maxPerDay ?? ""}
              onChange={(e) =>
                set(
                  "maxPerDay",
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
              placeholder="Unlimited"
            />
          </Field>
        </div>
      </Section>

      {/* Hosts / team */}
      <Section
        title="Hosts / team"
        description="Add team members to run this page as a shared team calendar. Leave empty for a single shared schedule."
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setTeamHelpOpen(true)}
          >
            <HelpCircle className="mr-1 h-3.5 w-3.5" />
            How it works
          </Button>
        }
      >
        {selectableMembers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No active members to add yet. Invite teammates under Settings →
            Members, then assign them here to enable team booking.
          </p>
        ) : (
          <div className="space-y-2">
            {selectableMembers.map((m) => {
              const host = (form.hosts ?? []).find((h) => h.uid === m.uid);
              const checked = !!host;
              const hasCustomHours =
                !!host?.workingHours && host.workingHours.length > 0;
              return (
                <div key={m.uid} className="rounded-lg border bg-background">
                  <label className="flex cursor-pointer items-center gap-3 p-3">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) =>
                        toggleHost(m.uid, m.name, e.target.checked)
                      }
                      disabled={saving}
                      className="h-4 w-4 cursor-pointer"
                    />
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                      <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{m.name}</span>
                    </span>
                    {calendarStatus.get(m.uid) === "connected" ? (
                      <span
                        className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400"
                        title="Their Google Calendar busy times block this page's slots."
                      >
                        Calendar connected
                      </span>
                    ) : calendarStatus.get(m.uid) === "error" ? (
                      <span
                        className="shrink-0 rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400"
                        title="Their Google Calendar connection needs a reconnect (Settings → Calendar sync)."
                      >
                        Reconnect needed
                      </span>
                    ) : (
                      <span
                        className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                        title="No Google Calendar connected — only their internal bookings block slots (Settings → Calendar sync)."
                      >
                        No calendar
                      </span>
                    )}
                  </label>
                  {checked && (
                    <div className="space-y-2 border-t px-3 py-2.5">
                      <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
                        <input
                          type="checkbox"
                          checked={hasCustomHours}
                          onChange={(e) =>
                            toggleHostCustomHours(m.uid, e.target.checked)
                          }
                          disabled={saving}
                          className="h-3.5 w-3.5 cursor-pointer"
                        />
                        Custom hours for this host
                      </label>
                      {hasCustomHours ? (
                        <WorkingHoursGrid
                          value={host!.workingHours!}
                          onChange={(next) => setHostCustomHours(m.uid, next)}
                          disabled={saving}
                        />
                      ) : (
                        <p className="text-[11px] text-muted-foreground">
                          Uses the page working hours above.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {(form.hosts ?? []).length > 0 && (
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3">
            <input
              type="checkbox"
              checked={form.allowHostSelection ?? false}
              onChange={(e) => set("allowHostSelection", e.target.checked)}
              disabled={saving}
              className="mt-0.5 h-4 w-4 cursor-pointer"
            />
            <div>
              <p className="text-sm font-medium">
                Let customers pick a specific person
              </p>
              <p className="text-xs text-muted-foreground">
                Adds an &ldquo;Anyone available&rdquo; / named-host dropdown on
                the public page, and lets voice callers ask for someone by
                name. Off = customers can&apos;t choose; bookings auto-assign to
                the least-busy host.
              </p>
            </div>
          </label>
        )}

        <p className="text-[11px] text-muted-foreground">
          {(form.hosts ?? []).length > 0
            ? form.allowHostSelection
              ? "Team mode: customers can pick a specific person (or “anyone available”). A booking for a chosen host is only offered inside that host's hours; “anyone” auto-assigns to the least-busy free host."
              : "Team mode: a time stays open while any selected host is free, and each booking is auto-assigned to the least-busy host (the customer doesn't pick)."
            : "Single shared schedule: everyone shares one calendar — a time closes once any one booking lands (today's behavior)."}
        </p>
      </Section>

      {/* Intake form */}
      <Section
        title="Intake form"
        description="Optional extra questions on the booking form."
      >
        <IntakeFieldBuilder
          value={form.intakeFields}
          onChange={(next) => set("intakeFields", next)}
          disabled={saving}
        />
      </Section>

      {/* Confirmation + reminders */}
      <Section
        title="Confirmation + reminders"
        description="What visitors see after booking, plus automated reminders."
      >
        <Field
          label="Confirmation message"
          htmlFor="confirmation"
          hint="Markdown. Shown on the thank-you page and in the confirmation email."
        >
          <Textarea
            id="confirmation"
            value={form.confirmationMessage}
            onChange={(e) => set("confirmationMessage", e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Looking forward to chatting! Add the calendar invite to your calendar to lock it in."
          />
        </Field>
        <Field
          label="Redirect URL (optional)"
          htmlFor="redirectUrl"
          hint="After a confirmed booking, send visitors here (e.g. a thank-you or upsell page). We briefly show the confirmation, then redirect — appending ?booking_id & email for tracking. Paid booking pages never redirect. Leave blank to stay on the confirmation screen."
        >
          <Input
            id="redirectUrl"
            type="url"
            inputMode="url"
            value={form.redirectUrl ?? ""}
            onChange={(e) =>
              set(
                "redirectUrl",
                e.target.value.trim().length > 0 ? e.target.value.trim() : null,
              )
            }
            maxLength={1000}
            placeholder="https://yourdomain.com/thank-you"
          />
        </Field>
        {form.redirectUrl && (
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3">
            <input
              type="checkbox"
              checked={form.redirectAppendParams ?? true}
              onChange={(e) => set("redirectAppendParams", e.target.checked)}
              className="mt-0.5 h-4 w-4 cursor-pointer"
            />
            <div>
              <p className="text-sm font-medium">
                Append booking details to the redirect URL
              </p>
              <p className="text-xs text-muted-foreground">
                Adds <code>?booking_id</code> and <code>email</code> so your
                thank-you page can fire conversion pixels and de-dup
                bookings. Turn off to send visitors to the bare URL — the
                booker&apos;s email won&apos;t appear in the destination&apos;s
                address bar, referrer, or logs.
              </p>
            </div>
          </label>
        )}
        <ReminderSettings
          remindersEnabled={form.remindersEnabled}
          smsRemindersEnabled={form.smsRemindersEnabled === true}
          offsets={form.reminderOffsetsMinutes}
          onRemindersEnabled={(v) => set("remindersEnabled", v)}
          onSmsRemindersEnabled={(v) => set("smsRemindersEnabled", v)}
          onOffsets={(v) => set("reminderOffsetsMinutes", v)}
        />
      </Section>

      {/* Payment, shown when any rail is connected (card or paypal.me) */}
      <Section
        title="Payment"
        description={
          canTakePayment
            ? hasCard
              ? "Require a deposit before the slot is confirmed. Card payments confirm the booking automatically; PayPal deposits you mark paid manually once the funds land."
              : "Require a PayPal.me deposit before the slot is confirmed. You mark each booking paid manually once the funds land."
            : "Connect Stripe or a PayPal.me username under Settings → Payments to require deposits."
        }
      >
        {!canTakePayment && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Deposits need a payment method. Connect Stripe (card) or a
              PayPal.me username under Settings → Payments and this section
              enables.
            </span>
          </div>
        )}
        <label
          className={`flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 ${
            !canTakePayment ? "opacity-50" : ""
          }`}
        >
          <input
            type="checkbox"
            checked={!!form.payment}
            onChange={(e) => togglePayment(e.target.checked)}
            disabled={!canTakePayment}
            className="mt-0.5 h-4 w-4 cursor-pointer"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              Require deposit to confirm the booking
            </p>
            <p className="text-xs text-muted-foreground">
              The slot is held in &ldquo;awaiting payment&rdquo; until you
              mark it paid. Unpaid holds auto-cancel after the window
              below.
            </p>
          </div>
        </label>

        {form.payment && (
          <div className="ml-7 space-y-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_auto_auto]">
              <Field label="Amount" htmlFor="payment-amount">
                <Input
                  id="payment-amount"
                  type="number"
                  min={0.01}
                  step="0.01"
                  value={form.payment.amount}
                  onChange={(e) =>
                    setPayment("amount", Number(e.target.value))
                  }
                  required
                />
              </Field>
              <Field label="Currency" htmlFor="payment-currency">
                <select
                  id="payment-currency"
                  value={form.payment.currency}
                  onChange={(e) => setPayment("currency", e.target.value)}
                  className="flex h-9 w-24 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 text-foreground dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Hold window (hours)"
                htmlFor="payment-hold"
                hint="Auto-cancel if unpaid"
              >
                <Input
                  id="payment-hold"
                  type="number"
                  min={1}
                  max={168}
                  className="w-24"
                  value={form.payment.holdHours}
                  onChange={(e) =>
                    setPayment("holdHours", Number(e.target.value))
                  }
                />
              </Field>
            </div>
            <Field
              label="Description (optional)"
              htmlFor="payment-description"
              hint="Shown to the visitor next to the Pay button."
            >
              <Input
                id="payment-description"
                value={form.payment.description ?? ""}
                onChange={(e) =>
                  setPayment(
                    "description",
                    e.target.value.length > 0 ? e.target.value : null,
                  )
                }
                placeholder="Consultation deposit"
                maxLength={120}
              />
            </Field>
          </div>
        )}
      </Section>

      {/* Territory, gated on subAccount.territoryScopingEnabled */}
      {scopingOn && (
        <Section
          title="Territory"
          description="Auto-tag contacts who book this page into a specific territory. Defaults to Global (visible to every rep)."
        >
          <TerritorySelectField
            id="defaultTerritoryId"
            label="Default territory for new leads"
            value={form.defaultTerritoryId}
            onChange={(next) => set("defaultTerritoryId", next)}
            disabled={saving}
          />
        </Section>
      )}

      {/* Visual */}
      <Section
        title="Visual"
        description="Override the sub-account's branding for this page. Leave blank to inherit."
      >
        <div className="space-y-1.5">
          <span className="text-sm font-medium">Style</span>
          <ThemePresetPicker
            value={form.themePreset ?? null}
            onChange={(next) => set("themePreset", next)}
            allowNone
            noneBlurb="The standard booking look, with your accent color below."
          />
          <p className="text-xs text-muted-foreground">
            Same presets as checkout pages. An accent color set below still
            overrides the preset&apos;s accent.
          </p>
        </div>
        <Field
          label="Logo URL"
          htmlFor="logoUrl"
          hint="Public HTTPS URL. Falls back to the sub-account logo."
        >
          <Input
            id="logoUrl"
            value={form.logoUrl ?? ""}
            onChange={(e) =>
              set("logoUrl", e.target.value.length > 0 ? e.target.value : null)
            }
            placeholder="https://…"
            type="url"
          />
        </Field>
        <Field
          label="Accent color"
          htmlFor="accentColor"
          hint="Hex like #5B5BD6."
        >
          <Input
            id="accentColor"
            value={form.accentColor ?? ""}
            onChange={(e) =>
              set(
                "accentColor",
                e.target.value.length > 0 ? e.target.value : null,
              )
            }
            placeholder="#5B5BD6"
            className="w-32"
          />
        </Field>
      </Section>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        {mode === "edit" ? (
          <Button
            type="button"
            variant="ghost"
            onClick={handleDelete}
            disabled={deleting || saving}
            className="text-destructive hover:bg-destructive/5 hover:text-destructive"
          >
            {deleting ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-1 h-4 w-4" />
            )}
            Delete page
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push(saPath("/booking"))}
            disabled={saving || deleting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={saving || deleting}>
            {saving ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1 h-4 w-4" />
            )}
            {mode === "new" ? "Create page" : "Save changes"}
          </Button>
        </div>
      </div>
    </form>
  );
}

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  /** Rendered top-right of the section header. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-2xl border bg-card p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  required,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {required && <span className="ml-1 text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

// Max 4 matches validateReminderOffsets on the server.
const MAX_REMINDERS = 4;
const REMINDER_PRESETS: { minutes: number; label: string }[] = [
  { minutes: 10080, label: "1 week" },
  { minutes: 2880, label: "2 days" },
  { minutes: 1440, label: "24 hours" },
  { minutes: 120, label: "2 hours" },
  { minutes: 60, label: "1 hour" },
  { minutes: 30, label: "30 min" },
  { minutes: 15, label: "15 min" },
];

function offsetLabel(minutes: number): string {
  const preset = REMINDER_PRESETS.find((p) => p.minutes === minutes);
  if (preset) return preset.label;
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} min`;
}

function ReminderSettings({
  remindersEnabled,
  smsRemindersEnabled,
  offsets,
  onRemindersEnabled,
  onSmsRemindersEnabled,
  onOffsets,
}: {
  remindersEnabled: boolean;
  smsRemindersEnabled: boolean;
  offsets: number[];
  onRemindersEnabled: (v: boolean) => void;
  onSmsRemindersEnabled: (v: boolean) => void;
  onOffsets: (v: number[]) => void;
}) {
  const anyChannel = remindersEnabled || smsRemindersEnabled;
  // Saved offsets that aren't presets (older pages, API edits) stay toggleable.
  const choices = [
    ...REMINDER_PRESETS.map((p) => p.minutes),
    ...offsets.filter((o) => !REMINDER_PRESETS.some((p) => p.minutes === o)),
  ].sort((a, b) => b - a);

  function toggle(minutes: number) {
    if (offsets.includes(minutes)) {
      onOffsets(offsets.filter((o) => o !== minutes));
    } else if (offsets.length < MAX_REMINDERS) {
      onOffsets([...offsets, minutes].sort((a, b) => b - a));
    } else {
      toast.error(`Up to ${MAX_REMINDERS} reminders per booking.`);
    }
  }

  return (
    <div className="space-y-3">
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3">
        <input
          type="checkbox"
          checked={remindersEnabled}
          onChange={(e) => onRemindersEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer"
        />
        <div>
          <p className="text-sm font-medium">Email reminders</p>
          <p className="text-xs text-muted-foreground">
            An email at each reminder time below. Skipped when a booking is
            cancelled or still awaiting payment.
          </p>
        </div>
      </label>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3">
        <input
          type="checkbox"
          checked={smsRemindersEnabled}
          onChange={(e) => onSmsRemindersEnabled(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer"
        />
        <div>
          <p className="text-sm font-medium">Text confirmation and reminders</p>
          <p className="text-xs text-muted-foreground">
            A text when the booking is confirmed, plus one at each reminder
            time. Sent from this workspace&apos;s SMS number (Settings →
            Messaging → SMS), or the shared sender if your agency allows it;
            each text is billed by Twilio. Contacts with no phone number or
            who replied STOP are skipped. Bookings made by phone with the AI
            voice agent don&apos;t get texts.
          </p>
        </div>
      </label>
      {anyChannel && (
        <div className="space-y-2 rounded-lg border bg-background p-3">
          <p className="text-sm font-medium">Reminder times</p>
          <div className="flex flex-wrap gap-1.5">
            {choices.map((minutes) => {
              const on = offsets.includes(minutes);
              return (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => toggle(minutes)}
                  aria-pressed={on}
                  className={
                    on
                      ? "rounded-full border border-primary bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                      : "rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                  }
                >
                  {offsetLabel(minutes)} before
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {offsets.length === 0
              ? "Pick at least one time, or no reminders are sent."
              : `Up to ${MAX_REMINDERS}. Times already passed when someone books (e.g. 24 hours for a same-day booking) are skipped.`}
          </p>
        </div>
      )}
    </div>
  );
}
