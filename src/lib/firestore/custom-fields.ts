import {
  collection,
  onSnapshot,
  query,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getFirebaseDb } from "@/lib/firebase/client";
import type { CustomFieldDef, CustomFieldEntity } from "@/types/custom-fields";

/** One entity's custom-field defs, for the Settings manager and form inputs. Read-only for members; writes go through Admin routes. */
export function subscribeToCustomFields(
  subAccountId: string,
  entity: CustomFieldEntity,
  callback: (fields: CustomFieldDef[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(getFirebaseDb(), "subAccounts", subAccountId, "customFields"),
    where("entity", "==", entity),
  );
  return onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map(
        (d) => ({ id: d.id, ...(d.data() as Omit<CustomFieldDef, "id">) }),
      );
      list.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
      callback(list);
    },
    (err) => onError?.(err),
  );
}
