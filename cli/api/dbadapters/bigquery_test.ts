import { BigQuery, Dataset, Table, TableField, TableMetadata } from "@google-cloud/bigquery";
import { expect } from "chai";
import { EventEmitter } from "events";
import { AuthClient, gaxios, Impersonated } from "google-auth-library";
import { anything, instance, mock, verify, when } from "ts-mockito";

import {
  BigQueryDbAdapter,
  bigQueryClientOptions,
  createAuthClient,
  createBigQueryClientProvider,
  createImpersonatedClient,
  DeferredAuthClient,
} from "sa/cli/api/dbadapters/bigquery";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

const TARGET_SERVICE_ACCOUNT = "target-sa@target-project.iam.gserviceaccount.com";
const TEST_POLICY_TAG = "projects/test-project/locations/us/taxonomies/1/policyTags/2";
const OTHER_POLICY_TAG = "projects/test-project/locations/us/taxonomies/1/policyTags/3";

async function setMetadataAndCaptureSchema(
  initialFields: TableField[],
  columns: sqlanvil.IColumnDescriptor[],
): Promise<TableField[]> {
  const mockBigQuery = mock<BigQuery>();
  const mockDataset = mock<Dataset>();
  const mockTable = mock<Table>();
  let capturedSchema: TableField[] = [];

  when(mockBigQuery.dataset("sch")).thenReturn(instance(mockDataset));
  when(mockDataset.table("tab")).thenReturn(instance(mockTable));
  when(mockTable.getMetadata()).thenResolve([{ schema: { fields: initialFields } }, undefined]);
  when(mockTable.setMetadata(anything())).thenCall(async (metadata: TableMetadata) => {
    capturedSchema = metadata.schema?.fields ?? (metadata.schema as TableField[]);
    return [{}, undefined];
  });

  const adapter = new BigQueryDbAdapter(
    sqlanvil.BigQuery.create({ projectId: "p", location: "US" }),
    {
      concurrencyLimit: 1,
      clientProvider: () => instance(mockBigQuery),
    },
  );

  await adapter.setMetadata(
    sqlanvil.ExecutionAction.create({
      target: { database: "db", schema: "sch", name: "tab" },
      actionDescriptor: { columns },
    }),
  );

  return capturedSchema;
}

/** A source AuthClient that records its requests and answers them with an impersonated token. */
class FakeSourceClient extends AuthClient {
  public readonly requests: gaxios.GaxiosOptions[] = [];

  public async getAccessToken() {
    return { token: "source-token" };
  }

  public async getRequestHeaders() {
    return new Headers({ authorization: "Bearer source-token" });
  }

  public async request<T>(options: gaxios.GaxiosOptions): gaxios.GaxiosPromise<T> {
    this.requests.push(options);
    return {
      data: { accessToken: "impersonated-token", expireTime: "2099-01-01T00:00:00Z" },
    } as any;
  }
}

suite("BigQueryDbAdapter", () => {
  test("tables() returns empty list when dataset does not exist yet", async () => {
    const mockBigQuery = mock<any>();
    const mockDataset = mock<Dataset>();

    const adapter = new BigQueryDbAdapter(
      sqlanvil.BigQuery.create({ projectId: "project1", location: "US" }),
      { clientProvider: () => instance(mockBigQuery) },
    );

    when(mockBigQuery.dataset("missing_schema")).thenReturn(instance(mockDataset));
    when(mockDataset.getTables(anything())).thenReturn(
      Promise.reject({ errors: [{ reason: "notFound" }] }),
    );

    expect(await adapter.tables("project1", "missing_schema")).to.deep.equal([]);
  });

  test("tables() rethrows errors other than notFound", async () => {
    const mockBigQuery = mock<any>();
    const mockDataset = mock<Dataset>();

    const adapter = new BigQueryDbAdapter(
      sqlanvil.BigQuery.create({ projectId: "project1", location: "US" }),
      { clientProvider: () => instance(mockBigQuery) },
    );

    when(mockBigQuery.dataset("restricted_schema")).thenReturn(instance(mockDataset));
    when(mockDataset.getTables(anything())).thenReturn(
      Promise.reject(new Error("Access Denied: Dataset project1:restricted_schema")),
    );

    let caughtError: Error | undefined;
    try {
      await adapter.tables("project1", "restricted_schema");
    } catch (e) {
      caughtError = e;
    }
    expect(caughtError?.message).to.equal("Access Denied: Dataset project1:restricted_schema");
  });

  test("tables() with schema filters correctly", async () => {
    const mockBigQuery = mock<any>();
    const mockDataset = mock<Dataset>();
    const mockTable = mock<Table>();

    const tableName = "table1";
    const schemaName = "schema1";
    const projectId = "project1";

    const credentials = sqlanvil.BigQuery.create({ projectId, location: "US" });
    const adapter = new BigQueryDbAdapter(credentials, {
      clientProvider: () => instance(mockBigQuery),
    });

    when(mockBigQuery.dataset(schemaName)).thenReturn(instance(mockDataset));
    // getTables returns an array where the first element is an array of tables.
    // Each table object needs an 'id' property.
    when(mockDataset.getTables(anything())).thenReturn(
      Promise.resolve([[{ id: tableName }]] as any),
    );
    when(mockDataset.table(tableName)).thenReturn(instance(mockTable));
    when(mockTable.getMetadata()).thenReturn(
      Promise.resolve([
        {
          type: "TABLE",
          tableReference: { projectId, datasetId: schemaName, tableId: tableName },
          schema: {
            fields: [
              { name: "col1", type: "STRING", mode: "NULLABLE" },
              { name: "bn", type: "BIGNUMERIC" },
              { name: "n", type: "NUMERIC" },
              { name: "j", type: "JSON" },
              { name: "iv", type: "INTERVAL" },
            ],
          },
          lastModifiedTime: "123456789",
        },
      ] as any),
    );

    const result = await adapter.tables(projectId, schemaName);

    expect(result.length).to.equal(1);
    expect(result[0].target.database).to.equal(projectId);
    expect(result[0].target.schema).to.equal(schemaName);
    expect(result[0].target.name).to.equal(tableName);
    expect(result[0].fields.map((field) => [field.name, field.primitive])).deep.equals([
      ["col1", sqlanvil.Field.Primitive.STRING],
      ["bn", sqlanvil.Field.Primitive.BIGNUMERIC],
      ["n", sqlanvil.Field.Primitive.NUMERIC],
      ["j", sqlanvil.Field.Primitive.JSON],
      ["iv", sqlanvil.Field.Primitive.INTERVAL],
    ]);
  });

  test("tables() without schema lists all datasets and tables", async () => {
    const mockBigQuery = mock<any>();
    const mockDataset = mock<Dataset>();
    const mockTable = mock<Table>();
    const schemaName = "schema1";
    const tableName = "table1";
    const projectId = "project";

    const credentials = sqlanvil.BigQuery.create({ projectId, location: "US" });
    const adapter = new BigQueryDbAdapter(credentials, {
      clientProvider: () => instance(mockBigQuery),
    });

    when(mockBigQuery.dataset(schemaName)).thenReturn(instance(mockDataset));
    when(mockDataset.getTables(anything())).thenReturn(
      Promise.resolve([[{ id: tableName }]] as any),
    );
    when(mockDataset.table(tableName)).thenReturn(instance(mockTable));
    when(mockTable.getMetadata()).thenReturn(
      Promise.resolve([
        {
          type: "TABLE",
          tableReference: { projectId, datasetId: schemaName, tableId: tableName },
          schema: { fields: [{ name: "col1", type: "STRING" }] },
          lastModifiedTime: "123456789",
        },
      ] as any),
    );

    when(mockBigQuery.getDatasets(anything())).thenReturn(
      Promise.resolve([[{ id: schemaName }]] as any),
    );

    const result = await adapter.tables(projectId);

    expect(result.length).to.equal(1);
    expect(result[0].target.database).to.equal(projectId);
    expect(result[0].target.schema).to.equal(schemaName);
    expect(result[0].target.name).to.equal(tableName);
  });

  suite("bigQueryClientOptions auth modes", () => {
    test("accessToken → OAuth2Client authClient (keyless), no JSON credentials", () => {
      const credentials = sqlanvil.BigQuery.create({
        projectId: "p",
        location: "US",
        accessToken: "ya29.test-token",
      });
      const opts = bigQueryClientOptions(credentials, "p") as any;
      expect(opts.projectId).to.equal("p");
      expect(opts.location).to.equal("US");
      expect(opts.authClient).to.be.ok;
      expect(opts.authClient.credentials.access_token).to.equal("ya29.test-token");
      expect(opts.credentials).to.be.undefined;
    });

    test("JSON key → parsed credentials, no authClient", () => {
      const key = JSON.stringify({
        client_email: "sa@proj.iam.gserviceaccount.com",
        private_key: "K",
      });
      const credentials = sqlanvil.BigQuery.create({
        projectId: "p",
        location: "EU",
        credentials: key,
      });
      const opts = bigQueryClientOptions(credentials, "p") as any;
      expect(opts.authClient).to.be.undefined;
      expect(opts.credentials.client_email).to.equal("sa@proj.iam.gserviceaccount.com");
    });

    test("neither → ADC fallback (no authClient, no credentials)", () => {
      const credentials = sqlanvil.BigQuery.create({ projectId: "p", location: "US" });
      const opts = bigQueryClientOptions(credentials, "p") as any;
      expect(opts.authClient).to.be.undefined;
      expect(opts.credentials).to.be.undefined;
    });

    test("accessToken takes precedence over a JSON key", () => {
      const key = JSON.stringify({
        client_email: "sa@proj.iam.gserviceaccount.com",
        private_key: "K",
      });
      const credentials = sqlanvil.BigQuery.create({
        projectId: "p",
        location: "US",
        credentials: key,
        accessToken: "ya29.override",
      });
      const opts = bigQueryClientOptions(credentials, "p") as any;
      expect(opts.authClient).to.be.ok;
      expect(opts.authClient.credentials.access_token).to.equal("ya29.override");
      expect(opts.credentials).to.be.undefined;
    });

    test("impersonateServiceAccount → Impersonated authClient over ADC, no JSON credentials", () => {
      const credentials = sqlanvil.BigQuery.create({
        projectId: "p",
        location: "US",
        impersonateServiceAccount: TARGET_SERVICE_ACCOUNT,
      });
      const opts = bigQueryClientOptions(credentials, "p", createAuthClient(credentials));
      expect(opts.authClient).to.be.instanceOf(Impersonated);
      expect((opts.authClient as Impersonated).getTargetPrincipal()).to.equal(
        TARGET_SERVICE_ACCOUNT,
      );
      expect(Boolean(opts.credentials)).to.equal(false);
    });

    test("createAuthClient is undefined without impersonateServiceAccount", () => {
      const credentials = sqlanvil.BigQuery.create({ projectId: "p", location: "US" });
      expect(createAuthClient(credentials)).to.equal(undefined);
      const opts = bigQueryClientOptions(credentials, "p", createAuthClient(credentials));
      expect(opts.authClient).to.be.undefined;
      expect(opts.credentials).to.be.undefined;
    });

    test("accessToken takes precedence over impersonateServiceAccount", () => {
      const credentials = sqlanvil.BigQuery.create({
        projectId: "p",
        location: "US",
        accessToken: "ya29.minted",
        impersonateServiceAccount: TARGET_SERVICE_ACCOUNT,
      });
      expect(createAuthClient(credentials)).to.equal(undefined);
      const opts = bigQueryClientOptions(credentials, "p", createAuthClient(credentials)) as any;
      expect(opts.authClient).to.not.be.instanceOf(Impersonated);
      expect(opts.authClient.credentials.access_token).to.equal("ya29.minted");
    });
  });

  test("leaves the location undefined when it is not set, so BigQuery auto-selects it", () => {
    // Unset proto3 string fields read as "", which BigQuery rejects as a job location.
    const credentials = sqlanvil.BigQuery.create({ projectId: "default-project" });
    expect(credentials.location).to.equal("");
    expect(bigQueryClientOptions(credentials, "default-project").location).to.equal(undefined);
    expect(createBigQueryClientProvider(credentials)().location).to.equal(undefined);
  });

  test("createBigQueryClientProvider creates and caches one client per project", () => {
    const clientProvider = createBigQueryClientProvider(
      sqlanvil.BigQuery.create({ projectId: "default-project", location: "EU" }),
    );
    const defaultClient = clientProvider();
    expect(defaultClient.projectId).to.equal("default-project");
    expect(defaultClient.location).to.equal("EU");
    expect(clientProvider()).to.equal(defaultClient);
    expect(clientProvider("other-project").projectId).to.equal("other-project");
  });

  test("createBigQueryClientProvider shares one impersonated auth client between projects", async () => {
    const clientProvider = createBigQueryClientProvider(
      sqlanvil.BigQuery.create({
        projectId: "default-project",
        location: "US",
        impersonateServiceAccount: TARGET_SERVICE_ACCOUNT,
      }),
    );
    const defaultAuthClient = await clientProvider().authClient.getClient();
    expect(defaultAuthClient).to.be.instanceOf(Impersonated);
    expect((defaultAuthClient as Impersonated).getTargetPrincipal()).to.equal(
      TARGET_SERVICE_ACCOUNT,
    );
    expect(await clientProvider("other-project").authClient.getClient()).to.equal(
      defaultAuthClient,
    );
  });

  test("impersonated client exchanges the lazily resolved source credentials for a token", async () => {
    const sourceClient = new FakeSourceClient();
    let sourceResolved = false;
    const impersonatedClient = createImpersonatedClient(
      TARGET_SERVICE_ACCOUNT,
      new DeferredAuthClient(async () => {
        sourceResolved = true;
        return sourceClient;
      }),
    );
    expect(sourceResolved).to.equal(false);

    const { token } = await impersonatedClient.getAccessToken();

    expect(token).to.equal("impersonated-token");
    expect(sourceResolved).to.equal(true);
    expect(sourceClient.requests.length).to.equal(1);
    expect(sourceClient.requests[0]).to.deep.include({
      method: "POST",
      url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${TARGET_SERVICE_ACCOUNT}:generateAccessToken`,
      data: {
        delegates: [],
        scope: [
          "https://www.googleapis.com/auth/cloud-platform",
          "https://www.googleapis.com/auth/drive",
        ],
        lifetime: "3600s",
      },
    });
  });

  test("setMetadata handles action without columns", async () => {
    // Partial mock for BigQuery client to avoid real network calls
    const mockBigQuery: any = {
      dataset: () => ({
        table: () => ({
          getMetadata: () => Promise.resolve([{ schema: { fields: [] } }]),
          setMetadata: (metadata: any) => {
            expect(metadata.description).to.equal("test");
            return Promise.resolve([]);
          },
        }),
      }),
    };

    const credentials = sqlanvil.BigQuery.create({ projectId: "p", location: "US" });
    const adapter = new BigQueryDbAdapter(credentials, {
      concurrencyLimit: 1,
      clientProvider: () => mockBigQuery,
    });

    const action = sqlanvil.ExecutionAction.create({
      target: { database: "db", schema: "sch", name: "tab" },
      actionDescriptor: { description: "test" },
      // columns is missing/null in this action
    });

    // This should not throw "cannot read property 'find' of undefined"
    await adapter.setMetadata(action);
  });

  test("setMetadata correctly maps column descriptions", async () => {
    const mockBigQuery: any = {
      dataset: () => ({
        table: () => ({
          getMetadata: () =>
            Promise.resolve([
              {
                schema: {
                  fields: [{ name: "id", type: "INTEGER" }],
                },
              },
            ]),
          setMetadata: (metadata: any) => {
            expect(metadata.schema[0].description).to.equal("id desc");
            return Promise.resolve([]);
          },
        }),
      }),
    };

    const credentials = sqlanvil.BigQuery.create({ projectId: "p", location: "US" });
    const adapter = new BigQueryDbAdapter(credentials, {
      concurrencyLimit: 1,
      clientProvider: () => mockBigQuery,
    });

    const action = sqlanvil.ExecutionAction.create({
      target: { database: "db", schema: "sch", name: "tab" },
      actionDescriptor: {
        columns: [{ path: ["id"], description: "id desc" }],
      },
    });

    await adapter.setMetadata(action);
  });

  test("setMetadata distinguishes flat column from nested column when flat column is listed first", async () => {
    const schema = await setMetadataAndCaptureSchema(
      [
        { name: "userssn", type: "STRING" },
        { name: "user", type: "RECORD", fields: [{ name: "ssn", type: "STRING" }] },
      ],
      [
        { path: ["userssn"], description: "flat column" },
        { path: ["user"], description: "user record" },
        {
          path: ["user", "ssn"],
          description: "nested column",
          bigqueryPolicyTags: [TEST_POLICY_TAG],
        },
      ],
    );

    expect(schema).to.deep.equal([
      { name: "userssn", type: "STRING", description: "flat column" },
      {
        name: "user",
        type: "RECORD",
        description: "user record",
        fields: [
          {
            name: "ssn",
            type: "STRING",
            description: "nested column",
            policyTags: { names: [TEST_POLICY_TAG] },
          },
        ],
      },
    ]);
  });

  test("setMetadata distinguishes flat column from nested column when nested column is listed first", async () => {
    const schema = await setMetadataAndCaptureSchema(
      [
        { name: "userssn", type: "STRING" },
        { name: "user", type: "RECORD", fields: [{ name: "ssn", type: "STRING" }] },
      ],
      [
        {
          path: ["user", "ssn"],
          description: "nested column",
          bigqueryPolicyTags: [TEST_POLICY_TAG],
        },
        { path: ["userssn"], description: "flat column" },
      ],
    );

    expect(schema).to.deep.equal([
      { name: "userssn", type: "STRING", description: "flat column" },
      {
        name: "user",
        type: "RECORD",
        fields: [
          {
            name: "ssn",
            type: "STRING",
            description: "nested column",
            policyTags: { names: [TEST_POLICY_TAG] },
          },
        ],
      },
    ]);
  });

  test("setMetadata distinguishes nested columns with different segment boundaries", async () => {
    const schema = await setMetadataAndCaptureSchema(
      [
        { name: "ab", type: "RECORD", fields: [{ name: "c", type: "STRING" }] },
        { name: "a", type: "RECORD", fields: [{ name: "bc", type: "STRING" }] },
      ],
      [
        { path: ["ab", "c"], description: "ab.c desc", bigqueryPolicyTags: [TEST_POLICY_TAG] },
        { path: ["a", "bc"], description: "a.bc desc", bigqueryPolicyTags: [OTHER_POLICY_TAG] },
      ],
    );

    expect(schema).to.deep.equal([
      {
        name: "ab",
        type: "RECORD",
        fields: [
          {
            name: "c",
            type: "STRING",
            description: "ab.c desc",
            policyTags: { names: [TEST_POLICY_TAG] },
          },
        ],
      },
      {
        name: "a",
        type: "RECORD",
        fields: [
          {
            name: "bc",
            type: "STRING",
            description: "a.bc desc",
            policyTags: { names: [OTHER_POLICY_TAG] },
          },
        ],
      },
    ]);
  });

  test("setMetadata applies a record description and nested field policy tags", async () => {
    const schema = await setMetadataAndCaptureSchema(
      [{ name: "user", type: "RECORD", fields: [{ name: "ssn", type: "STRING" }] }],
      [
        { path: ["user"], description: "user record" },
        {
          path: ["user", "ssn"],
          description: "nested ssn",
          bigqueryPolicyTags: [TEST_POLICY_TAG],
        },
      ],
    );

    expect(schema).to.deep.equal([
      {
        name: "user",
        type: "RECORD",
        description: "user record",
        fields: [
          {
            name: "ssn",
            type: "STRING",
            description: "nested ssn",
            policyTags: { names: [TEST_POLICY_TAG] },
          },
        ],
      },
    ]);
  });

  test("setMetadata ignores a column descriptor without a path", async () => {
    const schema = await setMetadataAndCaptureSchema(
      [{ name: "id", type: "INTEGER" }],
      [
        { description: "missing path", bigqueryPolicyTags: [TEST_POLICY_TAG] },
        { path: ["id"], description: "id desc" },
      ],
    );

    expect(schema).to.deep.equal([{ name: "id", type: "INTEGER", description: "id desc" }]);
  });

  test("search() filters out tables whose metadata is not found", async () => {
    const projectId = "project1";
    const liveSchema = "live_schema";
    const deletedSchema = "deleted_schema";
    const tableName = "table1";

    const mockBigQuery: any = {
      createQueryStream: () => {
        const stream = new EventEmitter();
        process.nextTick(() => {
          stream.emit("data", {
            table_catalog: projectId,
            table_schema: liveSchema,
            table_name: tableName,
          });
          stream.emit("data", {
            table_catalog: projectId,
            table_schema: deletedSchema,
            table_name: tableName,
          });
          stream.emit("end");
        });
        return stream;
      },
      dataset: (schema: string) => ({
        table: (name: string) => ({
          getMetadata: () => {
            if (schema === deletedSchema) {
              return Promise.reject({ errors: [{ reason: "notFound" }] });
            }
            return Promise.resolve([
              {
                type: "TABLE",
                tableReference: { projectId, datasetId: schema, tableId: name },
                schema: { fields: [{ name: "col1", type: "STRING" }] },
                lastModifiedTime: "123456789",
              },
            ]);
          },
        }),
      }),
    };

    const credentials = sqlanvil.BigQuery.create({ projectId, location: "US" });
    const adapter = new BigQueryDbAdapter(credentials, {
      clientProvider: () => mockBigQuery,
    });

    const result = await adapter.search("schema");

    expect(result.length).to.equal(1);
    expect(result[0].target).to.eql({
      database: projectId,
      schema: liveSchema,
      name: tableName,
    });
  });
});
