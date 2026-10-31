"use client";

import Link from "next/link";
import {
  Building2,
  CircleDot,
  ExternalLink,
  Mail,
  Phone,
  Tag,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSubAccount } from "@/context/sub-account-context";
import { SourceBadge } from "@/components/contacts/source-badge";
import { ContactDeals } from "@/components/contacts/contact-deals";
import { ContactTasks } from "@/components/contacts/contact-tasks";
import { ActivityTimeline } from "@/components/contacts/activity-timeline";
import { AddNoteInput } from "@/components/contacts/add-note-input";
import type { Contact } from "@/types/contacts";

/**
 * Contact context beside the thread: a compact summary plus the same
 * self-loading components the profile uses, so only the contact is passed in.
 * Editing stays on the full profile to avoid a second territory-aware save path.
 */
export function ConversationContactPanel({
  contact,
  onClose,
}: {
  contact: Contact;
  onClose: () => void;
}) {
  const { saPath } = useSubAccount();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <h2 className="text-sm font-semibold">Details</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            render={<Link href={saPath(`/contacts/${contact.id}`)} />}
          >
            <ExternalLink className="mr-1 h-3.5 w-3.5" />
            Full profile
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Hide details"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <div className="space-y-3">
          <h3 className="truncate text-base font-semibold">
            {contact.name || "Unnamed contact"}
          </h3>
          <dl className="space-y-2.5 rounded-xl border bg-background p-3 text-sm">
            {contact.email && (
              <Row icon={<Mail className="h-3.5 w-3.5" />} label="Email">
                <a
                  href={`mailto:${contact.email}`}
                  className="break-all text-foreground hover:text-primary hover:underline"
                >
                  {contact.email}
                </a>
              </Row>
            )}
            {contact.phone && (
              <Row icon={<Phone className="h-3.5 w-3.5" />} label="Phone">
                <a
                  href={`tel:${contact.phone}`}
                  className="text-foreground hover:text-primary hover:underline"
                >
                  {contact.phone}
                </a>
              </Row>
            )}
            {contact.company && (
              <Row icon={<Building2 className="h-3.5 w-3.5" />} label="Company">
                <span className="text-foreground">{contact.company}</span>
              </Row>
            )}
            <Row icon={<CircleDot className="h-3.5 w-3.5" />} label="Source">
              <SourceBadge source={contact.source} />
            </Row>
            <Row icon={<Tag className="h-3.5 w-3.5" />} label="Tags">
              {contact.tags && contact.tags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {contact.tags.map((tag) => (
                    <Badge key={tag} variant="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">No tags</span>
              )}
            </Row>
          </dl>
        </div>

        <ContactDeals contact={contact} />
        <ContactTasks contact={contact} />

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Activity</h3>
          <AddNoteInput contactId={contact.id} />
          <ActivityTimeline contactId={contact.id} />
        </div>
      </div>
    </div>
  );
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </dt>
        <dd className="min-w-0">{children}</dd>
      </div>
    </div>
  );
}
