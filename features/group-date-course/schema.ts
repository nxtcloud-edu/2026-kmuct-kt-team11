import { z } from 'zod';

const timeRange = z.string().regex(
  /^([01]\d|2[0-3]):[0-5]\d\s*-\s*([01]\d|2[0-3]):[0-5]\d$/,
  'HH:mm-HH:mm 형식이어야 합니다.',
);

export const groupCourseInputSchema = z
  .strictObject({
    member_ids: z.array(z.string().uuid()).min(1).max(8),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다.'),
    time_range: timeRange,
    region: z.string().trim().min(1).max(100).optional(),
    start_station: z.string().trim().min(1).max(100).optional(),
    budget_per_person: z.number().int().min(0).max(10_000_000).optional(),
    hard_constraints: z
      .strictObject({
        vegetarian: z.boolean().optional(),
        no_spicy: z.boolean().optional(),
        limited_walking: z.boolean().optional(),
        with_children: z.boolean().optional(),
        with_pet: z.boolean().optional(),
        needs_parking: z.boolean().optional(),
        allow_taxi: z.boolean().optional(),
      })
      .optional(),
    pinned_place_ids: z.array(z.string().uuid()).max(4).optional(),
    forbidden_place_ids: z.array(z.string().uuid()).max(100).optional(),
  })
  .refine((value) => value.region || value.start_station, {
    message: 'region 또는 start_station 중 하나는 필요합니다.',
    path: ['region'],
  });

export function parseGroupCourseInput(value: unknown) {
  const body = groupCourseInputSchema.parse(value);
  return {
    memberIds: [...new Set(body.member_ids)],
    date: body.date,
    timeRange: body.time_range,
    region: body.region,
    startStation: body.start_station,
    budgetPerPerson: body.budget_per_person,
    hardConstraints: body.hard_constraints
      ? {
          vegetarian: body.hard_constraints.vegetarian,
          noSpicy: body.hard_constraints.no_spicy,
          limitedWalking: body.hard_constraints.limited_walking,
          withChildren: body.hard_constraints.with_children,
          withPet: body.hard_constraints.with_pet,
          needsParking: body.hard_constraints.needs_parking,
          allowTaxi: body.hard_constraints.allow_taxi,
        }
      : undefined,
    pinnedPlaceIds: body.pinned_place_ids,
    forbiddenPlaceIds: body.forbidden_place_ids,
  };
}
