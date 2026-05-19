import { z } from "zod";
import { GOAL_LEVELS, GOAL_STATUSES } from "../constants.js";

export const createGoalSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  level: z.enum(GOAL_LEVELS).optional().default("task"),
  status: z.enum(GOAL_STATUSES).optional().default("planned"),
  parentId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
  // fork_mangoclaw: manual sort_order (server defaults to next slot if omitted).
  sortOrder: z.number().int().optional(),
  // fork_mangoclaw: identifier + goal_number are auto-assigned by server on
  // create, but writable via PATCH for backfill of pre-existing rows. Once all
  // rows have an identifier, this should become server-readonly.
  identifier: z.string().optional().nullable(),
  goalNumber: z.number().int().optional().nullable(),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = createGoalSchema.partial();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;
