import "server-only";

import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let _app: App | null = null;

function getAdminApp(): App {
  if (!_app) {
    if (getApps().length > 0) {
      _app = getApps()[0];
    } else {
      _app = initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(
            /\\n/g,
            "\n"
          ),
        }),
      });
    }
  }
  return _app;
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}

export function getAdminDb(): Firestore {
  const db = getFirestore(getAdminApp());
  // ignoreUndefinedProperties drops undefined values instead of throwing, so a
  // stray `x ?? undefined` doesn't crash the request. settings() only works once
  // per instance, before any other call; dev hot reload keeps the instance, so
  // swallow "already initialized".
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    // Already configured on a prior import; nothing to do.
  }
  return db;
}
