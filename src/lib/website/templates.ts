import type { WebsiteConfig } from "@/types/website";

/**
 * Agency templates: sites saved as templates on gitpage. A template build copies
 * one into a new site with this sub-account's details and LeadStack wiring. It's
 * stored as a normal local config plus `template_id`, so only the places that
 * must differ check isTemplateConfig().
 */

/** gitpage template ids are Mongo ObjectIds. */
export const TEMPLATE_ID_RE = /^[a-f0-9]{24}$/i;

export function isTemplateConfig(config: Pick<WebsiteConfig, "template_id"> | null | undefined): boolean {
  return typeof config?.template_id === "string" && config.template_id.length > 0;
}
