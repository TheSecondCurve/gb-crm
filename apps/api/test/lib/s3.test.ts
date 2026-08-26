// lib/s3 SigV4 签名：对拍 AWS 官方文档已知答案向量（GET Object 示例，
// docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html），
// 防止签名实现回归（中间产物 canonicalRequest / stringToSign 一并对拍）。
import { describe, expect, it } from "vitest";

import { encodeS3KeyPath, signS3Request } from "../../src/lib/s3.js";

// AWS 官方示例固定凭证与时间
const ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const AMZ_DATE = "20130524T000000Z";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("signS3Request（AWS 官方已知答案向量）", () => {
  it("GET Object + Range 头 → 文档给出的 canonicalRequest / stringToSign / Signature", () => {
    const result = signS3Request({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      extraHeaders: { Range: "bytes=0-9" },
      payloadHash: EMPTY_SHA256,
      amzDate: AMZ_DATE,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      region: "us-east-1",
    });

    expect(result.canonicalRequest).toBe(
      [
        "GET",
        "/test.txt",
        "",
        "host:examplebucket.s3.amazonaws.com\n" +
          "range:bytes=0-9\n" +
          `x-amz-content-sha256:${EMPTY_SHA256}\n` +
          `x-amz-date:${AMZ_DATE}\n`,
        "host;range;x-amz-content-sha256;x-amz-date",
        EMPTY_SHA256,
      ].join("\n"),
    );

    // 文档给出的规范请求哈希
    expect(result.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        AMZ_DATE,
        "20130524/us-east-1/s3/aws4_request",
        "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
      ].join("\n"),
    );

    expect(result.authorization).toBe(
      "AWS4-HMAC-SHA256 " +
        `Credential=${ACCESS_KEY}/20130524/us-east-1/s3/aws4_request,` +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("region 缺省 → us-east-1；service 缺省 → s3", () => {
    const result = signS3Request({
      method: "DELETE",
      host: "s3.example.com",
      path: "/bucket/key",
      payloadHash: EMPTY_SHA256,
      amzDate: AMZ_DATE,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
    });
    expect(result.stringToSign.split("\n")[2]).toBe("20130524/us-east-1/s3/aws4_request");
  });
});

describe("encodeS3KeyPath", () => {
  it("按段编码，保留 /；bucket 原样", () => {
    expect(encodeS3KeyPath("my-bucket", "backups/gb-crm-latest.sqlite.gz")).toBe(
      "/my-bucket/backups/gb-crm-latest.sqlite.gz",
    );
    expect(encodeS3KeyPath("b", "目录/文 件.txt")).toBe(
      "/b/%E7%9B%AE%E5%BD%95/%E6%96%87%20%E4%BB%B6.txt",
    );
    expect(encodeS3KeyPath("b", "a!b'c(d)e.txt")).toBe("/b/a%21b%27c%28d%29e.txt");
  });
});
