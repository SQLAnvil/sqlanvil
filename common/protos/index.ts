import { configure, util } from "protobufjs";

import {
  isPlainObject,
  isProtoMessageInstance,
  Structs,
  UnsupportedStructValueError,
} from "sa/common/protos/structs";
import { google } from "sa/protos/ts";

const CONFIGS_PROTO_DOCUMENTATION_URL = "https://sqlanvil.com/docs/reference/configs/";
const REPORT_ISSUE_URL = "https://github.com/sqlanvil/sqlanvil/issues";

/**
 * Whether `candidate` is a `Buffer` class belonging to a realm other than this one.
 *
 * A `Buffer` from another realm does not share this realm's `Uint8Array`, so its prototype fails
 * an `instanceof` check against it.
 */
export function isForeignBuffer(candidate: any): boolean {
  try {
    if (!candidate?.prototype) {
      return false;
    }
    return !(candidate.prototype instanceof Uint8Array);
  } catch (e) {
    // A `Buffer` we cannot even introspect is certainly not one of ours.
    return true;
  }
}

/**
 * Makes protobufjs encode into plain `Uint8Array`s rather than `Buffer`s when `bufferClass` does
 * not belong to this realm.
 *
 * protobufjs decides once, at load time, whether to encode into a Node `Buffer` or a plain
 * `Uint8Array`, by looking at `global.Buffer`. Inside the vm context the CLI compiles projects in,
 * that is the host realm's `Buffer` (VmRunner passes it into the sandbox). Encoding through a
 * `Buffer` from another realm is very slow (under vm2 it crossed a proxy membrane on every call;
 * under node:vm it still means cross-realm objects), and the encoded bytes are the same either
 * way; only the container type differs. When `Buffer` belongs to this realm this is a no-op, so
 * the host keeps protobufjs's native `Buffer` fast paths.
 *
 * Upstream #2300 (issue #2298).
 *
 * @returns whether protobufjs was reconfigured.
 */
export function avoidForeignBufferEncoding(bufferClass: any): boolean {
  if (!isForeignBuffer(bufferClass)) {
    return false;
  }
  (util as any).Buffer = null;
  configure();
  return true;
}

avoidForeignBufferEncoding(typeof global === "undefined" ? undefined : (global as any).Buffer);

export interface IProtoClass<IProto, Proto> {
  new (): Proto;

  create(iProto?: IProto | Proto): Proto;

  encode(proto: IProto | Proto): { finish(): Uint8Array };
  decode(bytes: Uint8Array): Proto;

  toObject(proto: Proto): { [k: string]: any };
  fromObject(obj: { [k: string]: any }): Proto;

  verify(obj: any): string | null;

  getTypeUrl(prefix: string): string;
}

export enum VerifyProtoErrorBehaviour {
  DEFAULT,
  SUGGEST_REPORTING_TO_DATAFORM_TEAM,
  SHOW_DOCS_LINK,
}

Structs.installNonMutatingProtoHandlers();

// This is a minimalist Typescript equivalent for the validation part of Profobuf's JsonFormat's
// mergeMessage method:
// https://github.com/protocolbuffers/protobuf/blob/670e0c2a0d0b64c994f743a73ee9b8926c47580d/java/util/src/main/java/com/google/protobuf/util/JsonFormat.java#L1455
// This is used because:
// * ProtobufJS's native verify method does not check that only defined fields are present.
// * Other protobuf libraries, such as ProtobufTS, incur significant performance hits.
// A key downside of using ProtobufJS is that it does not record the expected types of fields,
// meaning that the type of fields cannot be verified; an int can be confused with a string.
function isVerifiableObject(value: unknown): boolean {
  return (
    Array.isArray(value) ||
    isPlainObject(value) ||
    isProtoMessageInstance(value) ||
    value instanceof Uint8Array ||
    Boolean(util.Long && value instanceof util.Long)
  );
}

export function verifyObjectMatchesProto<Proto>(
  protoType: IProtoClass<any, Proto>,
  object: object,
  errorBehaviour: VerifyProtoErrorBehaviour = VerifyProtoErrorBehaviour.DEFAULT,
): Proto {
  if (Array.isArray(object)) {
    throw ReferenceError(`Expected a top-level object, but found an array`);
  }

  // ProtobufJS's verify checks the TYPES of known fields ("partitionBy: string expected").
  // Ignoring its result entirely (as upstream did) lets an OBJECT-valued scalar field — e.g. a
  // dbt-style `partitionBy: {field, dataType, granularity}` — sail through (the toObject
  // round-trip preserves it, so the typeof comparison below matches) and crash much later at
  // binary encode with an inscrutable ERR_INVALID_ARG_TYPE. Throw a per-file config error for
  // exactly that class. Everything else verify complains about stays lenient, because create()
  // handles it faithfully: enum names as strings ("PARQUET"), coercible primitives, and
  // map/array shape mismatches (which checkFields below reports as before).
  const verificationError = protoType.verify(object);
  if (verificationError && verifyErrorIsNonPrimitiveInScalarField(verificationError, object)) {
    if (errorBehaviour === VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM) {
      throw ReferenceError(
        `Invalid property value: ${verificationError}, please report this to the sqlanvil team ` +
          `at ${REPORT_ISSUE_URL}.`,
      );
    }
    throw ReferenceError(
      `Invalid property value: ${verificationError}.` +
        maybeGetDocsLinkPrefix(errorBehaviour, protoType),
    );
  }
  let normalizedObject: object;
  try {
    normalizedObject = Structs.normalizeForProtoVerification(protoType, object);
  } catch (err) {
    if (err instanceof UnsupportedStructValueError) {
      throw formatUnexpectedPropertyError(protoType, err.key ?? "", err.valueType, errorBehaviour);
    }
    throw err;
  }
  const proto = protoType.create(normalizedObject);
  const protoCastObject = protoType.toObject(proto);

  function checkFields(present: { [k: string]: any }, desired: { [k: string]: any }) {
    // Only the entries of `present` need to be iterated through as `desired` is guaranteed to be a
    // strict subset of `present`.
    Object.entries(present).forEach(([presentKey, presentValue]) => {
      if (presentValue instanceof google.protobuf.Struct) {
        return;
      }
      if (presentValue && typeof presentValue === "object" && !isVerifiableObject(presentValue)) {
        throw formatUnexpectedPropertyError(
          protoType,
          presentKey,
          typeof presentValue,
          errorBehaviour,
        );
      }
      const desiredValue = desired[presentKey];
      if (
        typeof desiredValue !== typeof presentValue ||
        Array.isArray(desiredValue) !== Array.isArray(presentValue)
      ) {
        if (Array.isArray(presentValue) && presentValue.length === 0) {
          // Empty arrays are assigned to empty proto array fields by ProtobufJS.
          return;
        }
        if (!presentValue) {
          throw ReferenceError(
            `Unexpected empty value for "${presentKey}".` +
              maybeGetDocsLinkPrefix(errorBehaviour, protoType),
          );
        }
        if (
          typeof presentValue === "object" &&
          !Array.isArray(presentValue) &&
          (isPlainObject(presentValue) || isProtoMessageInstance(presentValue)) &&
          Object.keys(presentValue).length === 0
        ) {
          // Empty objects are assigned to empty object fields by ProtobufJS.
          return;
        }
        throw formatUnexpectedPropertyError(
          protoType,
          presentKey,
          typeof presentValue,
          errorBehaviour,
        );
      }
      if (typeof presentValue === "object") {
        checkFields(presentValue, desiredValue);
      }
    });
  }

  checkFields(normalizedObject, protoCastObject);
  return proto;
}

/**
 * True only when a protobufjs verify error describes a non-primitive value (object/array) in a
 * SCALAR-typed field — the one shape create() cannot coerce and binary encode crashes on.
 * Message/map/repeated mismatches ("object expected", "array expected", "string{k:string}") are
 * excluded; those flow through the legacy checkFields reporting. When the error path cannot be
 * resolved against the input (e.g. repeated nesting without indices), stay lenient.
 */
function verifyErrorIsNonPrimitiveInScalarField(message: string, root: object): boolean {
  if (/object expected|array expected|\{k:/.test(message)) {
    return false;
  }
  const path = message.split(":")[0].trim().split(".");
  let value: any = root;
  for (const segment of path) {
    if (Array.isArray(value)) {
      value = value.find(
        (element) => element !== null && typeof element === "object" && segment in element,
      );
    }
    if (value === null || typeof value !== "object" || !(segment in value)) {
      return false;
    }
    value = value[segment];
  }
  return value !== null && typeof value === "object";
}

function formatUnexpectedPropertyError<Proto>(
  protoType: IProtoClass<any, Proto>,
  propertyName: string,
  propertyType: string,
  errorBehaviour: VerifyProtoErrorBehaviour,
): ReferenceError {
  if (errorBehaviour === VerifyProtoErrorBehaviour.SUGGEST_REPORTING_TO_DATAFORM_TEAM) {
    return ReferenceError(
      `Unexpected property "${propertyName}" for "${protoType
        .getTypeUrl("")
        .replace("/", "")}", please report this to the sqlanvil team at ` + `${REPORT_ISSUE_URL}.`,
    );
  }
  return ReferenceError(
    `Unexpected property "${propertyName}", or property value type of ` +
      `"${propertyType}" is incorrect.` +
      maybeGetDocsLinkPrefix(errorBehaviour, protoType),
  );
}

function maybeGetDocsLinkPrefix<Proto>(
  errorBehaviour: VerifyProtoErrorBehaviour,
  protoType: IProtoClass<any, Proto>,
) {
  return errorBehaviour === VerifyProtoErrorBehaviour.SHOW_DOCS_LINK
    ? ` See ${CONFIGS_PROTO_DOCUMENTATION_URL}#${protoType
        .getTypeUrl("")
        // Clean up the proto type into its URL form.
        .replace(/\./g, "-")
        .replace(/\//, "")} for allowed properties.`
    : "";
}

export function encode64<IProto, Proto>(
  protoType: IProtoClass<IProto, Proto>,
  value: IProto | Proto = {} as IProto,
): string {
  return toBase64(protoType.encode(protoType.create(value)).finish());
}

export function decode64<Proto>(protoType: IProtoClass<any, Proto>, encodedValue?: string): Proto {
  if (!encodedValue) {
    return protoType.create();
  }
  return protoType.decode(fromBase64(encodedValue));
}

export function equals<IProto, Proto>(
  protoType: IProtoClass<IProto, Proto>,
  valueA: IProto | Proto,
  valueB: IProto | Proto,
): boolean {
  return encode64(protoType, valueA) === encode64(protoType, valueB);
}

export function deepClone<IProto, Proto>(
  protoType: IProtoClass<IProto, Proto>,
  value: IProto | Proto,
) {
  return protoType.fromObject(protoType.toObject(protoType.create(value)));
}

function toBase64(value: Uint8Array): string {
  return util.base64.encode(value, 0, value.length);
}

function fromBase64(value: string): Uint8Array {
  const buf = new Uint8Array(util.base64.length(value));
  util.base64.decode(value, buf, 0);
  return buf;
}

export function unknownToValue(raw: unknown): google.protobuf.IValue {
  if (raw === null || typeof raw === "undefined") {
    return { nullValue: 0 };
  }
  if (typeof raw === "string") {
    return { stringValue: raw };
  }
  if (typeof raw === "number") {
    return { numberValue: raw };
  }
  if (typeof raw === "boolean") {
    return { boolValue: raw };
  }
  if (Array.isArray(raw)) {
    return { listValue: { values: raw.map(unknownToValue) } };
  }
  if (typeof raw === "object") {
    return {
      structValue: {
        fields: Object.fromEntries(
          Object.entries(raw).map(([key, value]) => [key, unknownToValue(value)]),
        ),
      },
    };
  }
  throw new Error(`Unsupported value: ${raw}`);
}
