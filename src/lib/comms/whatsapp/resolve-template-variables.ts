import { resolveMergeTags, type MergeTagSubject } from "@/lib/automations/merge-tags";
import type { WhatsappTemplateVariable } from "@/types/whatsapp-templates";

/**
 * Maps template variables to the ordered array Twilio expects (index 0 is {{1}}).
 * A non-empty manualValues[position] always wins; otherwise merge_tag
 * variables resolve via the automation merge-tag resolver (same as email/SMS);
 * otherwise "". Used by both the send paths and the composer preview.
 */
export function resolveTemplateVariables(input: {
  variables: WhatsappTemplateVariable[];
  subject: MergeTagSubject;
  manualValues?: Record<number, string>;
}): string[] {
  const manual = input.manualValues ?? {};
  return [...input.variables]
    .sort((a, b) => a.position - b.position)
    .map((v) => {
      const override = manual[v.position];
      if (override !== undefined && override.trim() !== "") return override;
      if (v.source === "merge_tag" && v.mergeTag) {
        return resolveMergeTags(`{{${v.mergeTag}}}`, input.subject);
      }
      return override ?? "";
    });
}

/** Manual-source positions, i.e. the fields the composer must ask for. */
export function manualVariablePositions(
  variables: WhatsappTemplateVariable[],
): number[] {
  return variables
    .filter((v) => v.source === "manual")
    .map((v) => v.position)
    .sort((a, b) => a - b);
}
