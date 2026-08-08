export type ConfirmationRequestResult = "accepted" | "delivery-failed";

/**
 * Coordinates a confirmation request. The caller supplies the database and
 * delivery operations so this state transition can be tested without a live
 * D1 or email provider.
 */
export async function requestSubscriberConfirmation(input: {
  isConfirmed: () => Promise<boolean>;
  hasPending: () => Promise<boolean>;
  insert: () => Promise<boolean>;
  deliver: () => Promise<boolean>;
  remove: () => Promise<void>;
}): Promise<ConfirmationRequestResult> {
  if (await input.isConfirmed()) return "accepted";
  if (await input.hasPending()) return "accepted";
  if (!await input.insert()) return "accepted";
  try {
    if (!await input.deliver()) throw new Error("delivery rejected");
    return "accepted";
  } catch {
    await input.remove();
    return "delivery-failed";
  }
}

export type ConfirmationApplyResult = "invalid" | "preview" | "confirmed" | "replayed";

/** GET is preview-only; POST is the only operation that mutates subscription state. */
export async function applySubscriberConfirmation(input: {
  method: string;
  lookup: () => Promise<boolean>;
  insert: () => Promise<boolean>;
  remove: () => Promise<void>;
}): Promise<ConfirmationApplyResult> {
  if (!await input.lookup()) return "invalid";
  if (input.method === "GET") return "preview";
  const inserted = await input.insert();
  await input.remove();
  return inserted ? "confirmed" : "replayed";
}
