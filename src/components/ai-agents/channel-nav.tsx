"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSubAccount } from "@/context/sub-account-context";
import {
  VISIBLE_AI_CHANNELS,
  buildChannelHref,
  monitorsTabVisible,
} from "@/components/ai-agents/channels";
import { cn } from "@/lib/utils";

/** Rendered once in the layout. Inbound channels are violet, outbound orange after a divider. */
export function ChannelNav() {
  const pathname = usePathname();
  const { subAccountId, subAccount } = useSubAccount();
  const baseHref = `/sa/${subAccountId}/ai-agents`;
  const tabs = VISIBLE_AI_CHANNELS.filter((c) =>
    monitorsTabVisible(c, subAccount),
  );

  return (
    <div className="flex items-center overflow-x-auto border-b">
      {tabs.map((channel, i) => {
        const href = buildChannelHref(subAccountId, channel);
        const isActive =
          channel.id === "overview"
            ? pathname === baseHref
            : pathname.startsWith(href);
        const Icon = channel.icon;
        const outbound = channel.group === "outbound";
        const monitor = channel.group === "monitor";
        const prev = tabs[i - 1];
        const showDivider = prev && prev.group !== channel.group;

        return (
          <Fragment key={channel.id}>
            {showDivider && (
              <span
                aria-hidden
                className="mx-1 h-5 w-px shrink-0 bg-border"
              />
            )}
            <Link
              href={href}
              className={cn(
                "flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm transition-colors",
                isActive
                  ? cn(
                      "font-medium text-foreground",
                      outbound
                        ? "border-orange-500"
                        : monitor
                          ? "border-emerald-500"
                          : "border-violet-500",
                    )
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon
                className={cn(
                  "h-3.5 w-3.5",
                  outbound
                    ? "text-orange-500/80"
                    : monitor
                      ? "text-emerald-500/80"
                      : "text-violet-500/70",
                )}
              />
              {channel.label}
              {channel.beta && (
                <span className="rounded-sm bg-violet-500/10 px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide text-violet-600 dark:text-violet-400">
                  beta
                </span>
              )}
            </Link>
          </Fragment>
        );
      })}
    </div>
  );
}
