import { z } from "zod";

export const roleSchema = z.enum(["PHYSICIAN", "APP", "ADMIN"]);
export const coverageCategorySchema = z.enum([
  "OUTPATIENT_PROCEDURE",
  "OFFICE_LOCATION",
  "INPATIENT_HOSPITAL",
  "WEEKEND_CALL",
  "APP_COVERAGE_ROTATION",
]);
export const inpatientSplitSchema = z.enum(["DAY", "NIGHT"]);
export const shiftStatusSchema = z.enum(["DRAFT", "PUBLISHED"]);
export const scheduleVersionStatusSchema = z.enum(["DRAFT", "PUBLISHED"]);
export const requestStatusSchema = z.enum(["PENDING", "APPROVED", "DENIED", "CANCELLED"]);
export const swapStatusSchema = z.enum([
  "PENDING_COUNTERPARTY",
  "PENDING_ADMIN",
  "APPROVED",
  "DENIED",
  "CANCELLED",
]);
export const integrationProviderSchema = z.enum(["OUTLOOK", "QGENDA", "GOOGLE", "ICLOUD"]);

export const shiftFilterSchema = z.object({
  scheduleVersionId: z.string().optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
  siteIds: z.array(z.string()).optional(),
  assigneeIds: z.array(z.string()).optional(),
  physicianIds: z.array(z.string()).optional(),
  appIds: z.array(z.string()).optional(),
});

export const createShiftInputSchema = z.object({
  scheduleVersionId: z.string(),
  siteId: z.string(),
  coverageCategory: coverageCategorySchema,
  inpatientSplit: inpatientSplitSchema.optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  assigneeId: z.string().nullable().optional(),
  status: shiftStatusSchema.optional(),
});

export const pickupSuggestionInputSchema = z.object({
  shiftId: z.string(),
});

export const draftYearInputSchema = z.object({
  sourceScheduleVersionId: z.string(),
  targetYear: z.number().int().min(2000).max(2100),
  constraintsNote: z.string().optional(),
});

export type ShiftFilter = z.infer<typeof shiftFilterSchema>;
export type CreateShiftInput = z.infer<typeof createShiftInputSchema>;
