/**
 * @file shared/storage/openAdditiveDatabase.ts
 *
 * Opens an IndexedDB database whose schema only ever grows — stores and indexes
 * are added, never removed or reshaped — so that ANY build can open a profile
 * ANY other build has touched: an older build, a newer one, or one from a
 * parallel branch that counted its versions differently.
 *
 * A plain `open(name, version)` fails both ways across branches. Older code
 * gets a `VersionError` from a database a newer build upgraded, and the library
 * reads as empty. And two branches that each bump to the same number for
 * different stores never run an upgrade on each other's database, so one of
 * them is missing a store it assumes exists.
 *
 * So there are three cases, and only the first is the ordinary path:
 *  - on disk older, or absent → opened at `version`; `upgrade` runs, as always;
 *  - on disk same or newer, with everything this build needs → opened as it is;
 *  - on disk same or newer, missing something this build needs → opened one
 *    version higher, so the upgrade adds exactly what is missing.
 *
 * The contract that makes this safe: `upgrade` is presence-driven (it creates
 * only what is absent and never deletes), and no build changes the shape of a
 * store another build reads.
 */

export type AdditiveDatabaseSchema = {
  name: string;
  /** This build's schema version. */
  version: number;
  /** Presence-driven: creates only what is missing. Runs in the versionchange transaction. */
  upgrade: (database: IDBDatabase, transaction: IDBTransaction) => void;
  /** True when every store and index this build uses exists. */
  isSatisfied: (database: IDBDatabase) => boolean;
  /** When set, a blocked upgrade rejects with this error instead of waiting. */
  blockedError?: () => Error;
};

export async function openAdditiveDatabase(
  factory: IDBFactory,
  schema: AdditiveDatabaseSchema,
): Promise<IDBDatabase> {
  let database: IDBDatabase;
  try {
    database = await openAt(factory, schema, schema.version);
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== 'VersionError') throw error;
    // A newer build has been here. Opening without a version never upgrades
    // an existing database, so this reads it exactly as that build left it.
    database = await openAt(factory, schema, undefined);
  }
  if (schema.isSatisfied(database)) return database;

  // Same number, different schema: another branch counted this version for
  // other stores. Step past it so the presence-driven upgrade adds ours.
  const next = database.version + 1;
  database.close();
  const upgraded = await openAt(factory, schema, next);
  if (!schema.isSatisfied(upgraded)) {
    upgraded.close();
    throw new Error(`${schema.name} is missing stores this build needs, even after upgrading`);
  }
  return upgraded;
}

function openAt(factory: IDBFactory, schema: AdditiveDatabaseSchema, version: number | undefined): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version == null ? factory.open(schema.name) : factory.open(schema.name, version);
    request.onupgradeneeded = () => schema.upgrade(request.result, request.transaction!);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open ${schema.name}`));
    request.onblocked = () => {
      const error = schema.blockedError?.();
      if (error) reject(error);
    };
  });
}

/** For `isSatisfied`: every named store exists. */
export function hasStores(database: IDBDatabase, storeNames: readonly string[]): boolean {
  return storeNames.every((name) => database.objectStoreNames.contains(name));
}
