import { z } from "zod";

import type { CourseRequest } from "./types";

const categorySchema = z.enum([
  "restaurant",
  "cafe_dessert",
  "travel_attraction",
  "accommodation",
  "culture_exhibition",
  "activity_experience",
  "shopping_product",
  "beauty_wellness",
]);

const timeRangeSchema = z.string().regex(
  /^([01]\d|2[0-3]):[0-5]\d\s*-\s*([01]\d|2[0-3]):[0-5]\d$/,
  "HH:mm-HH:mm 형식이어야 합니다.",
);

const candidatePlaceSchema = z.strictObject({
  placeId: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  source: z.enum(["saved", "external"]),
  category: categorySchema.nullable(),
  subcategory: z.string().max(100).nullable().optional(),
  location: z
    .strictObject({
      name: z.string().max(200).nullable().optional(),
      address: z.string().max(300).nullable().optional(),
      nearestStation: z.string().max(100).nullable().optional(),
      regionTags: z.array(z.string().max(100)).max(20).optional(),
      coords: z
        .strictObject({
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
        })
        .nullable()
        .optional(),
    })
    .optional(),
  price: z
    .strictObject({
      amounts: z.array(z.number().int().min(0)).max(20).optional(),
      perPerson: z.number().int().min(0).nullable().optional(),
      priceLevel: z.string().max(40).nullable().optional(),
      discount: z.string().max(200).nullable().optional(),
    })
    .optional(),
  features: z.array(z.string().max(100)).max(50).optional(),
  normalizedHashtags: z.array(z.string().max(100)).max(50).optional(),
  occasions: z.array(z.string().max(100)).max(30).optional(),
  benefits: z.array(z.string().max(200)).max(30).optional(),
  recommendedAudiences: z
    .array(z.union([z.string().max(100), z.strictObject({ id: z.string().max(100) })]))
    .max(30)
    .optional(),
  constraints: z.record(z.string(), z.string().nullable()).optional(),
  openingHours: z.string().max(200).nullable().optional(),
  cautions: z.array(z.string().max(300)).max(30).optional(),
  sponsored: z.boolean().optional(),
  similarUserSignal: z
    .strictObject({
      likeRate: z.number().min(0).max(1).optional(),
      cohortRank: z.number().int().min(1).optional(),
    })
    .optional(),
  sourceEvidence: z
    .array(z.strictObject({ source: z.string().min(1), text: z.string().min(1) }))
    .max(30)
    .optional(),
});

export const courseRequestSchema = z
  .strictObject({
    user: z.strictObject({
      mbti: z.string().regex(/^[EI][SN][TF][JP]$/),
      tasteVectorConfidence: z.enum(["high", "medium", "low"]).optional(),
      savedVideoCount: z.number().int().min(0).optional(),
      tasteVector: z.strictObject({
        categories: z.partialRecord(categorySchema, z.number().min(0).max(1)).optional(),
        features: z.record(z.string(), z.number().min(0).max(1)).optional(),
        audiences: z.array(z.string().max(100)).max(30).optional(),
        evidence: z
          .array(
            z.strictObject({
              tag: z.string().min(1).max(100),
              sourceVideoId: z.string().min(1).max(200),
              count: z.number().int().min(1),
            }),
          )
          .max(100)
          .optional(),
      }),
      constraints: z
        .strictObject({
          region: z.string().min(1).max(100).optional(),
          startStation: z.string().min(1).max(100).optional(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 합니다."),
          timeRange: timeRangeSchema,
          participantCount: z.number().int().min(1).max(20),
          budgetPerPerson: z.number().int().min(0).optional(),
          budgetToleranceRate: z.number().min(0).max(0.5).optional(),
          maxDurationMin: z.number().int().min(60).max(720).optional(),
          maxLegMinutes: z.number().int().min(1).max(120).optional(),
          maxWalkMinutes: z.number().int().min(0).max(120).optional(),
          pinnedPlaceIds: z.array(z.string().min(1)).max(4).optional(),
          forbiddenPlaceIds: z.array(z.string().min(1)).max(100).optional(),
          hard: z
            .strictObject({
              vegetarian: z.boolean().optional(),
              noSpicy: z.boolean().optional(),
              limitedWalking: z.boolean().optional(),
              withChildren: z.boolean().optional(),
              withPet: z.boolean().optional(),
              needsParking: z.boolean().optional(),
              allowTaxi: z.boolean().optional(),
            })
            .optional(),
        })
        .refine((value) => value.region || value.startStation, {
          message: "region 또는 startStation 중 하나는 필요합니다.",
          path: ["region"],
        }),
    }),
    similarUsers: z
      .strictObject({
        cohortSize: z.number().int().min(0),
        similarity: z.number().min(0).max(1),
      })
      .optional(),
    candidatePlaces: z.array(candidatePlaceSchema).min(5).max(100),
  })
  .superRefine((request, context) => {
    const ids = new Set<string>();
    for (const [index, place] of request.candidatePlaces.entries()) {
      if (ids.has(place.placeId)) {
        context.addIssue({
          code: "custom",
          message: "placeId는 중복될 수 없습니다.",
          path: ["candidatePlaces", index, "placeId"],
        });
      }
      ids.add(place.placeId);
    }

    for (const [index, placeId] of (request.user.constraints.pinnedPlaceIds ?? []).entries()) {
      if (!ids.has(placeId)) {
        context.addIssue({
          code: "custom",
          message: "고정 장소는 candidatePlaces에 있어야 합니다.",
          path: ["user", "constraints", "pinnedPlaceIds", index],
        });
      }
    }
  });

export function parseCourseRequest(value: unknown): CourseRequest {
  return courseRequestSchema.parse(value) as CourseRequest;
}
