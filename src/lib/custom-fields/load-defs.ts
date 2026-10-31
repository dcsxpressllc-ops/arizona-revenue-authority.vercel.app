import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import type { CustomFieldDef, CustomFieldEntity } from "@/types/custom-fields";

/** Server-side defs for one entity, used to validate incoming value maps. */
export async function loadCustomFieldDefs(
  subAccountId: string,
  entity: CustomFieldEntity,
): Promise<CustomFieldDef[]> {
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/customFields`)
    .where("entity", "==", entity)
    .get();
  return snap.docs.map(
    (d) => ({ id: d.id, ...(d.data() as Omit<CustomFieldDef, "id">) }),
  );
}
