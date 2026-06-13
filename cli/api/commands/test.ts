import * as dbadapters from "sa/cli/api/dbadapters";
import { sqlanvil } from "sa/protos/ts";

export async function test(
  dbadapter: dbadapters.IDbAdapter,
  tests: sqlanvil.ITest[]
): Promise<sqlanvil.ITestResult[]> {
  return await Promise.all(tests.map(testCase => runTest(dbadapter, testCase)));
}

async function runTest(
  dbadapter: dbadapters.IDbAdapter,
  testCase: sqlanvil.ITest
): Promise<sqlanvil.ITestResult> {
  // Test result sets must be compared in full. An explicit (empty) options object
  // opts out of the adapter's default row/byte caps (1000 rows / 1MB) — those
  // defaults only apply when `execute` is called with no options argument at all.
  // Do NOT drop this argument: without it the caps return and rows past the limit
  // are silently truncated and never compared, so a test could pass or fail on a
  // partial result. See SQLAnvil/sqlanvil#19.
  const noLimit = {};
  let actualResults;
  let expectedResults;
  try {
    [actualResults, expectedResults] = await Promise.all([
      dbadapter.execute(testCase.testQuery, noLimit),
      dbadapter.execute(testCase.expectedOutputQuery, noLimit)
    ]);
  } catch (e) {
    return {
      name: testCase.name,
      successful: false,
      messages: [`Error thrown: ${e.message}.`]
    };
  }

  // Check row counts.
  if (actualResults.rows.length !== expectedResults.rows.length) {
    return {
      name: testCase.name,
      successful: false,
      messages: [
        `Expected ${expectedResults.rows.length} rows, but saw ${actualResults.rows.length} rows.`
      ]
    };
  }
  // If the result set is empty and the number of actual rows is equal to the number of expected rows
  // (asserted above), this test is therefore successful.
  if (actualResults.rows.length === 0) {
    return {
      name: testCase.name,
      successful: true
    };
  }

  // Check column sets.
  const actualColumns = Object.keys(actualResults.rows[0]);
  const expectedColumns = Object.keys(expectedResults.rows[0]);
  if (actualColumns.length !== expectedColumns.length) {
    return {
      name: testCase.name,
      successful: false,
      messages: [`Expected columns "${expectedColumns}", but saw "${actualColumns}".`]
    };
  }
  // We assume: (a) column order does not matter, and (b) column names are unique.
  for (const expectedColumn of expectedColumns) {
    if (
      !actualColumns.some(
        actualColumn => normalizeColumnName(actualColumn) === normalizeColumnName(expectedColumn)
      )
    ) {
      return {
        name: testCase.name,
        successful: false,
        messages: [`Expected columns "${expectedColumns}", but saw "${actualColumns}".`]
      };
    }
  }

  // Check row contents.
  const rowMessages: string[] = [];
  for (let i = 0; i < actualResults.rows.length; i++) {
    const actualResultRow = normalizeRow(actualResults.rows[i]);
    const expectedResultRow = normalizeRow(expectedResults.rows[i]);

    for (const column of actualColumns) {
      const normalizedColumn = normalizeColumnName(column);
      const expectedValue = expectedResultRow[normalizedColumn];
      const actualValue = actualResultRow[normalizedColumn];
      // Null value check
      if (expectedValue === null && actualValue !== null) {
        rowMessages.push(
          `For row ${i} and column "${column}": expected null, but saw "${actualValue}".`
        );
        break;
      }
      if (expectedValue !== null && actualValue === null) {
        rowMessages.push(
          `For row ${i} and column "${column}": expected "${expectedValue}", but saw null.`
        );
        break;
      }
      if (typeof expectedValue !== typeof actualValue) {
        rowMessages.push(
          `For row ${i} and column "${column}": expected type "${typeof expectedValue}", but saw type "${typeof actualValue}".`
        );
        break;
      }
      const comparableExpectedValue =
        typeof expectedValue === "object" ? JSON.stringify(expectedValue) : expectedValue;
      const comparableActualValue =
        typeof actualValue === "object" ? JSON.stringify(actualValue) : actualValue;
      if (comparableExpectedValue !== comparableActualValue) {
        rowMessages.push(
          `For row ${i} and column "${column}": expected "${comparableExpectedValue}", but saw "${comparableActualValue}".`
        );
      }
    }
  }
  if (rowMessages.length > 0) {
    return {
      name: testCase.name,
      successful: false,
      messages: rowMessages
    };
  }

  return {
    name: testCase.name,
    successful: true
  };
}

function normalizeColumnName(name: string) {
  return name.toUpperCase();
}

function normalizeRow(row: any) {
  const newRow: { [col: string]: any } = {};
  Object.keys(row).forEach(colName => {
    newRow[normalizeColumnName(colName)] = row[colName];
  });
  return newRow;
}
