import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  accountStatusLabels,
  accountStatusSchema,
  accountTypeLabels,
  accountTypeSchema,
  channelStatusLabels,
  channelStatusSchema,
  channelTypeLabels,
  channelTypeSchema,
  customerTypeLabels,
  customerTypeSchema,
  dealStageLabels,
  dealStageSchema,
  deliverableDimensionLabels,
  deliverableDimensionSchema,
  employmentStatusLabels,
  employmentStatusSchema,
  jobTitleLabels,
  jobTitleSchema,
  materialKindLabels,
  materialKindSchema,
  platformLabels,
  platformSchema,
  productStatusLabels,
  productStatusSchema,
  productTypeLabels,
  productTypeSchema,
  socialPlatformLabels,
  socialPlatformSchema,
  systemRoleLabels,
  systemRoleSchema,
  tagScopeLabels,
  tagScopeSchema,
} from "../src/index";

const ALL: [name: string, schema: z.ZodEnum<[string, ...string[]]>, labels: Record<string, string>][] =
  [
    ["jobTitle", jobTitleSchema, jobTitleLabels],
    ["systemRole", systemRoleSchema, systemRoleLabels],
    ["employmentStatus", employmentStatusSchema, employmentStatusLabels],
    ["accountStatus", accountStatusSchema, accountStatusLabels],
    ["platform", platformSchema, platformLabels],
    ["channelType", channelTypeSchema, channelTypeLabels],
    ["accountType", accountTypeSchema, accountTypeLabels],
    ["channelStatus", channelStatusSchema, channelStatusLabels],
    ["productType", productTypeSchema, productTypeLabels],
    ["productStatus", productStatusSchema, productStatusLabels],
    ["customerType", customerTypeSchema, customerTypeLabels],
    ["socialPlatform", socialPlatformSchema, socialPlatformLabels],
    ["dealStage", dealStageSchema, dealStageLabels],
    ["deliverableDimension", deliverableDimensionSchema, deliverableDimensionLabels],
    ["tagScope", tagScopeSchema, tagScopeLabels],
    ["materialKind", materialKindSchema, materialKindLabels],
  ];

describe("枚举与 labels 完整性（Appendix A.5 全量）", () => {
  it("16 个枚举都在", () => {
    expect(ALL).toHaveLength(16);
  });

  for (const [name, schema, labels] of ALL) {
    describe(name, () => {
      it("labels 的 key 集合与枚举 code 集合相等（双向）", () => {
        const codes = [...schema.options].sort();
        const keys = Object.keys(labels).sort();
        expect(keys).toEqual(codes);
        for (const code of keys) {
          expect(schema.safeParse(code).success).toBe(true);
        }
      });

      it("label 无空串且同枚举内无重复 label", () => {
        const values = Object.values(labels);
        for (const v of values) expect(v.length).toBeGreaterThan(0);
        expect(new Set(values).size).toBe(values.length);
      });
    });
  }
});
