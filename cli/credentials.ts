import * as fs from "fs";

import { question, selectionQuestion } from "sa/cli/console";
import { actuallyResolve } from "sa/cli/util";
import { sqlanvil } from "sa/protos/ts";

export interface ICredentialsPrompts {
  question: (questionText: string) => string;
  selectionQuestion: (questionText: string, options: string[]) => number;
}

export function getBigQueryCredentials(
  prompts: ICredentialsPrompts = { question, selectionQuestion },
): sqlanvil.IBigQuery {
  const locationIndex = prompts.selectionQuestion("Enter the location of your datasets:", [
    "US (default)",
    "EU",
    "other",
  ]);
  let location = locationIndex === 0 ? "US" : "EU";
  if (locationIndex === 2) {
    location = prompts.question("Enter the location's region name (e.g. 'asia-south1'):");
  }
  const isApplicationDefaultOrJSONKeyIndex = prompts.selectionQuestion(
    "Do you wish to use Application Default Credentials or JSON Key:",
    ["ADC (default)", "JSON Key"],
  );
  if (isApplicationDefaultOrJSONKeyIndex === 0) {
    const projectId = prompts.question("Enter your billing project ID:");
    return withServiceAccountToImpersonate({ projectId, location }, prompts);
  }
  const cloudCredentialsPath = actuallyResolve(
    prompts.question(
      "Follow instructions for creating a service account key for BigQuery access\n" +
        "(see https://cloud.google.com/iam/docs/keys-create-delete) and download as JSON.\n" +
        "(You can delete this file after credential initialization is complete.)\n\n" +
        "Enter the path to your Google Cloud private key file:",
    ),
  );
  if (!fs.existsSync(cloudCredentialsPath)) {
    throw new Error(`Google Cloud private key file "${cloudCredentialsPath}" does not exist!`);
  }
  const cloudCredentials = JSON.parse(fs.readFileSync(cloudCredentialsPath, "utf8"));
  return withServiceAccountToImpersonate(
    {
      projectId: cloudCredentials.project_id,
      credentials: fs.readFileSync(cloudCredentialsPath, "utf8"),
      location,
    },
    prompts,
  );
}

/** Asks for an optional service account to impersonate with the given credentials. */
function withServiceAccountToImpersonate(
  credentials: sqlanvil.IBigQuery,
  prompts: ICredentialsPrompts,
): sqlanvil.IBigQuery {
  const impersonateServiceAccount = prompts
    .question("Enter a service account to impersonate (optional, press Enter to skip):")
    .trim();
  return impersonateServiceAccount ? { ...credentials, impersonateServiceAccount } : credentials;
}
