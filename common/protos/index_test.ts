import { expect } from "chai";
import { verifyObjectMatchesProto, VerifyProtoErrorBehaviour } from "./index";

import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

suite("verifyObjectMatchesProto", () => {
  test("throws error when top-level object is an array", () => {
    expect(() => {
      verifyObjectMatchesProto(sqlanvil.Target, [] as any);
    }).to.throw(ReferenceError, "Expected a top-level object, but found an array");
  });

  test("throws error when null value provided for array field and SHOW_DOCS_LINK", () => {
    expect(() => {
      verifyObjectMatchesProto(
        sqlanvil.Table,
        { dependencyTargets: null } as any,
        VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
      );
    }).to.throw(ReferenceError, /Unexpected empty value for "dependencyTargets"/);
  });

  test("throws error on type mismatch with SUGGEST_REPORTING_TO_DATAFORM_TEAM", () => {
    expect(() => {
      verifyObjectMatchesProto(
        sqlanvil.Table,
        { actionDescriptor: 123 } as any,
        VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM
      );
    }).to.throw(
      ReferenceError,
      /Unexpected property "actionDescriptor" for ".*Table".*please report this to the sqlanvil team/
    );
  });

  test("throws error on default type mismatch", () => {
    expect(() => {
      verifyObjectMatchesProto(sqlanvil.Table, { actionDescriptor: 123 } as any);
    }).to.throw(
      ReferenceError,
      /Unexpected property "actionDescriptor", or property value type of "number" is incorrect/
    );
  });

  test("throws a clear error when a string field receives an object (dbt-style partitionBy)", () => {
    // Regression: an object-valued partitionBy used to pass verification (typeof matched on
    // both sides of the toObject round-trip) and crash much later at binary encode with
    // ERR_INVALID_ARG_TYPE. See the acuantia migrate test, 2026-07-24.
    expect(() => {
      verifyObjectMatchesProto(
        sqlanvil.ActionConfig.TableConfig,
        { partitionBy: { field: "d", dataType: "date", granularity: "month" } } as any,
        VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
      );
    }).to.throw(ReferenceError, /Invalid property value: partitionBy: string expected/);
  });

  test("accepts a valid config after the verify-result check", () => {
    const proto = verifyObjectMatchesProto(
      sqlanvil.ActionConfig.TableConfig,
      { partitionBy: "DATE_TRUNC(d, MONTH)" } as any,
      VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
    );
    expect(proto.partitionBy).to.equal("DATE_TRUNC(d, MONTH)");
  });

  test("stays lenient for enum names, coercible primitives, and map values", () => {
    // These all fail protobufjs verify but are faithfully handled by create() — they must
    // NOT throw (string enum names are the documented config syntax).
    expect(() =>
      verifyObjectMatchesProto(
        sqlanvil.ActionConfig.TableConfig,
        { iceberg: { fileFormat: "PARQUET", bucketName: "b", connection: "c" } } as any,
        VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
      )
    ).not.to.throw();
  });
});
