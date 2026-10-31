import type { WebsiteConfig } from "@/types/website";
import { isNicheKey, NICHE_META } from "@/lib/website/niches";
import { validatePremiumDetails } from "@/lib/website/premium";
import { isTemplateConfig, TEMPLATE_ID_RE } from "@/lib/website/templates";

/**
 * WebsiteConfig validation (server and client). Returns `{ fieldPath: message }`;
 * empty means valid. Follows gitpage's constraints:
 * - heading / heroStatement 1-80 chars; features / benefits 1-60
 * - niche must be a known key; local niche builds force the page set and need
 *   business_details
 * - vsl: video_link (http/s) required, page checks skipped (single page)
 * - local without niche: index.html required; services.html needs a services
 *   list or let_ai_do_services; contact.html needs name, street and city
 * - Custom palette needs three hex colours
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/i;
const HEX_TRIPLE_RE = /^#?[0-9a-f]{6}\s*,\s*#?[0-9a-f]{6}\s*,\s*#?[0-9a-f]{6}$/i;

export type ValidationErrors = Record<string, string>;

export function validateWebsiteConfig(config: WebsiteConfig): ValidationErrors {
  // Template builds only need the business details; the template supplies the rest.
  if (isTemplateConfig(config)) return validateTemplateConfig(config);

  const errors: ValidationErrors = {};

  if (!config.language?.trim()) errors.language = "Required.";
  if (!config.heading?.trim()) errors.heading = "Required.";
  else if (config.heading.length > 80)
    errors.heading = "Max 80 characters.";

  if (config.color_scheme !== "Standard" && config.color_scheme !== "Dark Mode")
    errors.color_scheme = "Pick a colour scheme.";

  if (!config.hero_statement?.trim()) errors.hero_statement = "Required.";
  else if (config.hero_statement.length > 80)
    errors.hero_statement = "Max 80 characters.";

  if (!config.features?.trim()) errors.features = "Required.";
  else if (config.features.length > 60)
    errors.features = "Max 60 characters (comma-separated 3 items).";

  if (!config.benefits?.trim()) errors.benefits = "Required.";
  else if (config.benefits.length > 60)
    errors.benefits = "Max 60 characters (comma-separated 3 items).";

  if (!config.contact_details?.trim())
    errors.contact_details = "Required.";
  else if (!EMAIL_RE.test(config.contact_details.trim()))
    errors.contact_details = "Must be a valid email address.";

  if (!config.cta_link?.trim()) errors.cta_link = "Required.";
  else if (!URL_RE.test(config.cta_link.trim()))
    errors.cta_link = "Must start with http:// or https://.";

  // Premium extras: lengths/shapes only.
  if (config.quality != null && config.quality !== "standard" && config.quality !== "premium") {
    errors.quality = "Must be standard or premium.";
  }
  if (config.hero_motion != null && !["still", "loop", "atmosphere"].includes(config.hero_motion)) {
    errors.hero_motion = "Must be still, loop or atmosphere.";
  }
  if (config.premium_details) {
    for (const [field, message] of Object.entries(validatePremiumDetails(config.premium_details))) {
      errors[`premium_details.${field}`] = message;
    }
  }

  // Older docs have no build_type.
  const buildType = config.build_type ?? "local";

  // null = no niche (generic build).
  if (config.niche != null && !isNicheKey(config.niche)) {
    errors.niche =
      "Niche must be one of: home_services, real_estate, gym_fitness, agency_consulting, ai_consulting, ai_automation. Leave blank for a generic build.";
  }
  const niche = isNicheKey(config.niche) ? config.niche : null;

  if (buildType === "vsl") {
    if (!config.video_link?.trim()) errors.video_link = "Required.";
    else if (!URL_RE.test(config.video_link.trim()))
      errors.video_link = "Must start with http:// or https:// (use the embed URL).";
    // VSL niche has no pages; nothing more to check.
  } else if (niche) {
    // Local + niche: forced page set, contact fields required. services_list is
    // optional (gitpage seeds a default). Stale page selections on old docs aren't
    // an error; the gitpage client overrides them.
    const biz = config.business_details;
    if (!biz) {
      errors["business_details"] =
        "Niche templates require business details (contact page is forced on).";
    } else {
      if (!biz.business_name.trim())
        errors["business_details.business_name"] = "Required.";
      // Remote-first niches don't need an address.
      if (!NICHE_META[niche].addressOptional) {
        if (!biz.business_street.trim())
          errors["business_details.business_street"] = "Required.";
        if (!biz.business_city.trim())
          errors["business_details.business_city"] = "Required.";
      }
    }
  } else {
    // Generic local. index.html is locked on in the UI; re-check anyway.
    if (!config.local_page_selections?.index)
      errors["local_page_selections.index"] =
        "Home page (index.html) is required.";

    if (config.local_page_selections?.services) {
      const svc = config.services_config;
      if (!svc) {
        errors["services_config"] =
          "Configure services or untick services.html.";
      } else if (!svc.let_ai_do_services && !svc.services_list.trim()) {
        errors["services_config.services_list"] =
          "List your services or let AI generate them.";
      }
    }

    if (config.local_page_selections?.contact) {
      const biz = config.business_details;
      if (!biz) {
        errors["business_details"] =
          "Add business details or untick contact.html.";
      } else {
        if (!biz.business_name.trim())
          errors["business_details.business_name"] = "Required.";
        if (!biz.business_street.trim())
          errors["business_details.business_street"] = "Required.";
        if (!biz.business_city.trim())
          errors["business_details.business_city"] = "Required.";
      }
    }
  }

  if (
    config.design_color_palette === "Custom" &&
    !HEX_TRIPLE_RE.test(config.custom_colors.trim())
  ) {
    errors.custom_colors =
      'Three hex colours separated by commas, e.g. "#5B4BFF,#EEF0FF,#00E5A8".';
  }

  return errors;
}

/** First error or null, for the form's single toast. */
export function firstValidationError(
  errors: ValidationErrors,
): string | null {
  const keys = Object.keys(errors);
  if (keys.length === 0) return null;
  return errors[keys[0]];
}

/** Template builds need the template plus the business details gitpage swaps in.
 *  gitpage also wants phone/address if the template shows them. */
function validateTemplateConfig(config: WebsiteConfig): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!TEMPLATE_ID_RE.test(String(config.template_id ?? "").trim())) errors.template_id = "Pick a template.";
  if (!config.contact_details?.trim()) errors.contact_details = "Required.";
  else if (!EMAIL_RE.test(config.contact_details.trim())) errors.contact_details = "Must be a valid email address.";
  if (config.cta_link?.trim() && !URL_RE.test(config.cta_link.trim())) errors.cta_link = "Must start with http:// or https://.";
  const biz = config.business_details;
  if (!biz) {
    errors["business_details"] = "Add the business details.";
  } else {
    if (!biz.business_name?.trim()) errors["business_details.business_name"] = "Required.";
    else if (biz.business_name.length > 120) errors["business_details.business_name"] = "Max 120 characters.";
  }
  return errors;
}
