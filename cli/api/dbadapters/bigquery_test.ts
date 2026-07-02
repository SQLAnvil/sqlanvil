import { Dataset, Table } from "@google-cloud/bigquery";
import { expect } from "chai";
import { anything, instance, mock, verify, when } from "ts-mockito";

import { BigQueryDbAdapter, bigQueryClientOptions } from "sa/cli/api/dbadapters/bigquery";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";

suite("BigQueryDbAdapter", () => {
  test("tables() with schema filters correctly", async () => {
    const mockBigQuery = mock<any>();
    const mockDataset = mock<Dataset>();
    const mockTable = mock<Table>();

    const tableName = "table1";
    const schemaName = "schema1";
    const projectId = "project1";

    const credentials = sqlanvil.BigQuery.create({ projectId, location: "US" });
    const adapter = new BigQueryDbAdapter(credentials, { bigqueryClient: instance(mockBigQuery) });

    when(mockBigQuery.dataset(schemaName)).thenReturn(instance(mockDataset));
    // getTables returns an array where the first element is an array of tables.
    // Each table object needs an 'id' property.
    when(mockDataset.getTables()).thenReturn(Promise.resolve([[{ id: tableName }]] as any));
    when(mockDataset.table(tableName)).thenReturn(instance(mockTable));
    when(mockTable.getMetadata()).thenReturn(
      Promise.resolve([
        {
          type: "TABLE",
          tableReference: { projectId, datasetId: schemaName, tableId: tableName },
          schema: { fields: [{ name: "col1", type: "STRING", mode: "NULLABLE" }] },
          lastModifiedTime: "123456789"
        }
      ] as any)
    );

    const result = await adapter.tables(projectId, schemaName);

    expect(result.length).to.equal(1);
    expect(result[0].target.database).to.equal(projectId);
    expect(result[0].target.schema).to.equal(schemaName);
    expect(result[0].target.name).to.equal(tableName);
    expect(result[0].fields.length).to.equal(1);
    expect(result[0].fields[0].name).to.equal("col1");
  });

  test("tables() without schema lists all datasets and tables", async () => {
    const mockBigQuery = mock<any>();
    const mockDataset = mock<Dataset>();
    const mockTable = mock<Table>();
    const schemaName = "schema1";
    const tableName = "table1";
    const projectId = "project";

    const credentials = sqlanvil.BigQuery.create({ projectId, location: "US" });
    const adapter = new BigQueryDbAdapter(credentials, { bigqueryClient: instance(mockBigQuery) });

    when(mockBigQuery.dataset(schemaName)).thenReturn(instance(mockDataset));
    when(mockDataset.getTables()).thenReturn(Promise.resolve([[{ id: tableName }]] as any));
    when(mockDataset.table(tableName)).thenReturn(instance(mockTable));
    when(mockTable.getMetadata()).thenReturn(
      Promise.resolve([
        {
          type: "TABLE",
          tableReference: { projectId, datasetId: schemaName, tableId: tableName },
          schema: { fields: [{ name: "col1", type: "STRING" }] },
          lastModifiedTime: "123456789"
        }
      ] as any)
    );

    when(mockBigQuery.getDatasets()).thenReturn(Promise.resolve([[{ id: schemaName }]] as any));

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
        accessToken: "ya29.test-token"
      });
      const opts = bigQueryClientOptions(credentials, "p") as any;
      expect(opts.projectId).to.equal("p");
      expect(opts.location).to.equal("US");
      expect(opts.authClient).to.be.ok;
      expect(opts.authClient.credentials.access_token).to.equal("ya29.test-token");
      expect(opts.credentials).to.be.undefined;
    });

    test("JSON key → parsed credentials, no authClient", () => {
      const key = JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com", private_key: "K" });
      const credentials = sqlanvil.BigQuery.create({ projectId: "p", location: "EU", credentials: key });
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
      const key = JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com", private_key: "K" });
      const credentials = sqlanvil.BigQuery.create({
        projectId: "p",
        location: "US",
        credentials: key,
        accessToken: "ya29.override"
      });
      const opts = bigQueryClientOptions(credentials, "p") as any;
      expect(opts.authClient).to.be.ok;
      expect(opts.authClient.credentials.access_token).to.equal("ya29.override");
      expect(opts.credentials).to.be.undefined;
    });
  });
});
