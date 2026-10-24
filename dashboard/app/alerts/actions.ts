"use server";

// Server action: runs on the server when a button in the triage table is pressed.
import { revalidatePath } from "next/cache";
import { command } from "@/lib/db";

const ALLOWED = new Set(["open", "review", "confirmed", "false_positive"]);

export async function setTriageStatus(formData: FormData) {
  const status = String(formData.get("status") ?? "");
  const trace = String(formData.get("trace") ?? "");
  const span = String(formData.get("span") ?? "");
  if (!ALLOWED.has(status) || !trace || !span) throw new Error("bad request");

  // status is not part of the table's sort key (see sql/migrations/001_pii_triage_sort_key.sql), so it can be updated
  await command(
    "ALTER TABLE pii_triage UPDATE status = {status:String} WHERE trace_id = {trace:String} AND span_id = {span:String} SETTINGS mutations_sync = 1",
    { status, trace, span },
  );
  revalidatePath("/alerts");
}
