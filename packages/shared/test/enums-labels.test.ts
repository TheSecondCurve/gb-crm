import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  accountStatusFromFeishu,
  accountStatusLabels,
  accountStatusSchema,
  accountTypeFromFeishu,
  accountTypeLabels,
  accountTypeSchema,
  channelStatusFromFeishu,
  channelStatusLabels,
  channelStatusSchema,
  channelTypeFromFeishu,
  channelTypeLabels,
  channelTypeSchema,
  customerTypeFromFeishu,
  customerTypeLabels,
  customerTypeSchema,
  employmentStatusFromFeishu,
  employmentStatusLabels,
  employmentStatusSchema,
  jobTitleFromFeishu,
  jobTitleLabels,
  jobTitleSchema,
  platformFromFeishu,
  platformLabels,
  platformSchema,
  productStatusFromFeishu,
  productStatusLabels,
  productStatusSchema,
  productTypeFromFeishu,
  productTypeLabels,
  productTypeSchema,
  systemRoleFromFeishu,
  systemRoleLabels,
  systemRoleSchema,
  tagFromFeishu,
  tagLabels,
  tagSchema,
} from "../src/index";

const ALL: [name: string, schema: z.ZodEnum<[string, ...string[]]>, labels: Record<string, string>, fromFeishu: Record<string, string>][] = [
  ["jobTitle", jobTitleSchema, jobTitleLabels, jobTitleFromFeishu],
  ["systemRole", systemRoleSchema, systemRoleLabels, systemRoleFromFeishu],
  ["employmentStatus", employmentStatusSchema, employmentStatusLabels, employmentStatusFromFeishu],
  ["accountStatus", accountStatusSchema, accountStatusLabels, accountStatusFromFeishu],
  ["platform", platformSchema, platformLabels, platformFromFeishu],
  ["channelType", channelTypeSchema, channelTypeLabels, channelTypeFromFeishu],
  ["accountType", accountTypeSchema, accountTypeLabels, accountTypeFromFeishu],
  ["channelStatus", channelStatusSchema, channelStatusLabels, channelStatusFromFeishu],
  ["productType", productTypeSchema, productTypeLabels, productTypeFromFeishu],
  ["productStatus", productStatusSchema, productStatusLabels, productStatusFromFeishu],
  ["customerType", customerTypeSchema, customerTypeLabels, customerTypeFromFeishu],
  ["tag", tagSchema, tagLabels, tagFromFeishu],
];

describe("枚举与 labels 完整性（Appendix A.5 全量）", () => {
  it("12 个枚举都在", () => {
    expect(ALL).toHaveLength(12);
  });

  for (const [name, schema, labels, fromFeishu] of ALL) {
    describe(name, () => {
      it("labels 的 key 集合与枚举 code 集合相等（双向）", () => {
        const codes = [...schema.options].sort();
        const keys = Object.keys(labels).sort();
        expect(keys).toEqual(codes);
        // 反向：每个 code 都能 parse
        for (const code of keys) {
          expect(schema.safeParse(code).success).toBe(true);
        }
      });

      it("反向映射含 A.5 全部行（label → code）", () => {
        for (const [code, label] of Object.entries(labels)) {
          expect(fromFeishu[label], `${name}: ${label}`).toBe(code);
        }
      });

      it("label 无空串且同枚举内无重复 label（否则反向映射会丢行）", () => {
        const values = Object.values(labels);
        for (const v of values) expect(v.length).toBeGreaterThan(0);
        expect(new Set(values).size).toBe(values.length);
      });
    });
  }

  it("tag：无前缀「1-10」「10-100」与带前缀形式都映射到 stage_*（A.5 末尾说明）", () => {
    expect(tagFromFeishu["1-10"]).toBe("stage_1_10");
    expect(tagFromFeishu["10-100"]).toBe("stage_10_100");
    expect(tagFromFeishu["业务阶段 1-10"]).toBe("stage_1_10");
    expect(tagFromFeishu["业务阶段 10-100"]).toBe("stage_10_100");
    expect(tagFromFeishu["业务阶段 0-1"]).toBe("stage_0_1");
  });
});
