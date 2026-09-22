// e2e 种子常量（无副作用模块）：e2e-seed.ts 建库时用，Playwright 用例从这里 import。
// 单一来源防漂移——种子改名时测试编译/运行期即暴露，而不是跑出看不懂的失败。
// 注意：本文件严禁引入任何运行时依赖（argon2 / db / env），保证 Playwright 进程可安全 import。

export const E2E_ADMIN = { username: "admin", password: "admin-e2e-password" } as const;
export const E2E_ASSISTANT = { username: "assistant", password: "assistant-e2e-pass" } as const;
export const E2E_OPERATOR = { username: "operator", password: "operator-e2e-pass" } as const;

export const E2E_CUSTOMER_NICKNAME = "e2e种子客户";
export const E2E_CUSTOMER_NICKNAME_2 = "e2e种子客户二";
export const E2E_PRODUCT_NAME = "e2e种子产品";
export const E2E_DEAL_ORDER_NO = "E2E-ORD-001";
/** 金额 ¥1000、税后比例 1、负责人 operator——分成/发放链路的数据锚点 */
export const E2E_DEAL2_ORDER_NO = "E2E-ORD-002";
export const E2E_DEAL2_AMOUNT_YUAN = 1000;
export const E2E_DELIVERY_TYPE = "e2e圈子交付";
export const E2E_DELIVERABLE_CONTENT = "e2e拉群";

export const E2E_CHANNEL_NAME = "e2e种子渠道";
/** assistant 视角应看到「—」的密钥列锚点值 */
export const E2E_CHANNEL_ACCOUNT_ID = "e2e-account-001";

export const E2E_TAG_NAME = "e2e标签高净值";
export const E2E_MATERIAL_TAG_NAME = "e2e资料标签";
export const E2E_MATERIAL_TITLE = "e2e咨询纪要";

/** 分页用客户前缀 + 数量（30 条保证默认 25/页出现第 2 页） */
export const E2E_PAGINATION_PREFIX = "e2e分页客户";
export const E2E_PAGINATION_COUNT = 30;
