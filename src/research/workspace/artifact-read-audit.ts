import { CliError } from "../../errors.js";
import {
  validateArtifactViewIndex,
  type ArtifactReadReceipt,
  type ArtifactViewIndex,
} from "./artifact-views.js";
import { canonicalJson, isObject, sha256Bytes, sha256Text } from "./storage.js";
import type { JournalEvent, OutputRecord } from "./types.js";

const HASH = /^[a-f0-9]{64}$/;
/** File inventories alone cannot attest read delivery. Replay exact selectors
 * against their stored object and the packet/journal authority that recorded it. */
export async function verifyArtifactReadAudit(input: {
  projectId: string;
  files: OutputRecord[];
  events: Array<
    Pick<JournalEvent, "scope" | "type" | "payload"> & { sourcePayloadSha256?: string }
  >;
  readBytes: (path: string) => Promise<Buffer>;
}) {
  if (!Array.isArray(input.events)) throw invalid("Read audit requires the journal proof records.");
  const files = new Map(input.files.map((file) => [file.path, file]));
  const indexes = new Map<string, ArtifactViewIndex>();
  const declarations = new Map<
    string,
    { packet: string; index: string; receipt?: ArtifactReadReceipt }
  >();
  const anchors = new Set<string>();
  const bytes = async (path: string) => {
    const expected = files.get(path);
    if (!expected) throw invalid("An artifact read audit reference is absent.");
    const value = await input.readBytes(path);
    if (value.length !== expected.bytes || sha256Bytes(value) !== expected.sha256)
      throw invalid("Artifact read audit bytes changed during verification.");
    return value;
  };
  const json = async (path: string): Promise<Record<string, unknown>> => {
    let value: unknown;
    try {
      value = JSON.parse((await bytes(path)).toString("utf8"));
    } catch {
      throw invalid("An artifact read audit object is missing or invalid JSON.");
    }
    if (!isObject(value)) throw invalid("Artifact read audit objects must be records.");
    return value;
  };
  for (const file of input.files) {
    const index = /^reads\/indexes\/([a-f0-9]{64})\.json$/u.exec(file.path);
    if (!index) continue;
    if (index[1] !== file.sha256)
      throw invalid("The artifact directory name does not match its exact bytes.");
    const value = validateArtifactViewIndex(await json(file.path));
    if (value.projectId !== input.projectId)
      throw invalid("The artifact directory belongs to a different project.");
    indexes.set(file.sha256, value);
  }
  const declare = (
    hash: unknown,
    packet: unknown,
    index: unknown,
    receipt?: ArtifactReadReceipt,
  ) => {
    if (
      typeof hash !== "string" ||
      !HASH.test(hash) ||
      typeof packet !== "string" ||
      !HASH.test(packet) ||
      typeof index !== "string" ||
      !HASH.test(index)
    )
      throw invalid("Read delivery declaration has invalid identities.");
    const old = declarations.get(hash);
    if (old && (old.packet !== packet || old.index !== index))
      throw invalid("One read receipt has conflicting delivery authority.");
    declarations.set(hash, { packet, index, ...(receipt ? { receipt } : {}) });
  };
  for (const event of input.events) {
    if (event.scope !== input.projectId) continue;
    const value = event.payload;
    if (
      ["native.artifact.read", "review.artifacts.read"].includes(event.type) &&
      event.sourcePayloadSha256 !== undefined &&
      event.sourcePayloadSha256 !== sha256Text(canonicalJson(value))
    )
      throw invalid("Read delivery proof was changed after export.");
    if (
      ["native.stage.prepared", "scientific-review.execution.started"].includes(event.type) &&
      typeof value.packetSha256 === "string" &&
      typeof value.artifactViewIndexSha256 === "string"
    )
      anchors.add(`${value.packetSha256}:${value.artifactViewIndexSha256}`);
    if (event.type === "native.artifact.read") {
      const receipt = validateReadReceipt(value);
      declare(receipt.receiptSha256, receipt.packetSha256, receipt.indexSha256, receipt);
    } else if (event.type === "review.artifacts.read") {
      if (!Array.isArray(value.receipts)) throw invalid("Reviewer read declaration is malformed.");
      for (const hash of value.receipts) declare(hash, value.packetSha256, value.indexSha256);
    }
  }
  const receipts = new Map<string, ArtifactReadReceipt>();
  const byObject = new Map<string, ArtifactReadReceipt[]>();
  for (const file of input.files) {
    const matched = /^reads\/receipts\/([a-f0-9]{64})\.json$/u.exec(file.path);
    if (!matched) continue;
    const receipt = validateReadReceipt(await json(file.path));
    if (matched[1] !== receipt.receiptSha256) throw invalid("Read receipt address changed.");
    const declared = declarations.get(receipt.receiptSha256);
    if (
      declared &&
      (declared.packet !== receipt.packetSha256 ||
        declared.index !== receipt.indexSha256 ||
        (declared.receipt && canonicalJson(declared.receipt) !== canonicalJson(receipt)))
    )
      throw invalid("A read receipt differs from its recorded delivery.");
    const index = indexes.get(receipt.indexSha256);
    const object = index?.objects.find((object) => object.objectId === receipt.objectId);
    if (!object || object.sha256 !== receipt.objectSha256 || receipt.endOffset > object.bytes)
      throw invalid("A read receipt is outside its exact artifact directory.");
    const key = `${receipt.packetSha256}:${receipt.indexSha256}`;
    if (!anchors.has(key)) {
      const packet = await json(`review/packets/${receipt.packetSha256}.json`);
      const { packetSha256, ...core } = packet;
      if (
        packetSha256 !== receipt.packetSha256 ||
        sha256Text(canonicalJson(core)) !== packetSha256 ||
        packet.projectId !== input.projectId ||
        !isObject(packet.artifactViews) ||
        packet.artifactViews.sha256 !== receipt.indexSha256 ||
        packet.artifactViews.path !== `reads/indexes/${receipt.indexSha256}.json`
      )
        throw invalid("Read receipt has no exact packet/index authority.");
      anchors.add(key);
    }
    const objectFile = files.get(`reads/objects/${receipt.objectSha256}`);
    if (!objectFile || objectFile.sha256 !== object.sha256 || objectFile.bytes !== object.bytes)
      throw invalid("The complete object for a read receipt is missing or inconsistent.");
    receipts.set(receipt.receiptSha256, receipt);
    const group = byObject.get(receipt.objectSha256) ?? [];
    group.push(receipt);
    byObject.set(receipt.objectSha256, group);
  }
  for (const hash of declarations.keys())
    if (!receipts.has(hash)) throw invalid("A journal-declared read receipt is missing.");
  // One selected object at a time; pages do not reread/redecode the full file.
  for (const [hash, group] of byObject) {
    const object = await bytes(`reads/objects/${hash}`);
    if (group.some((receipt) => receipt.encoding === "utf8")) {
      try {
        new TextDecoder("utf8", { fatal: true }).decode(object);
      } catch {
        throw invalid("A UTF-8 receipt claims a binary object.");
      }
    }
    for (const receipt of group) {
      const selected = object.subarray(receipt.offset, receipt.endOffset);
      if (
        receipt.deliveredBytes !== selected.length ||
        receipt.viewSha256 !== sha256Bytes(selected) ||
        (receipt.encoding === "utf8" &&
          ((receipt.offset < object.length && (object[receipt.offset]! & 0xc0) === 0x80) ||
            (receipt.endOffset < object.length && (object[receipt.endOffset]! & 0xc0) === 0x80)))
      )
        throw invalid("Read selector bytes do not match the delivered view.");
    }
  }
  return {
    verifiedReadReceipts: declarations.size,
    uncommittedReadReceipts: receipts.size - declarations.size,
  };
}

export function validateReadReceipt(value: unknown): ArtifactReadReceipt {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join(",") !==
      "deliveredBytes,encoding,endOffset,indexSha256,objectId,objectSha256,offset,packetSha256,receiptSha256,schemaVersion,viewSha256" ||
    value.schemaVersion !== 1 ||
    !["utf8", "base64"].includes(String(value.encoding)) ||
    ![
      "packetSha256",
      "indexSha256",
      "objectId",
      "objectSha256",
      "viewSha256",
      "receiptSha256",
    ].every((key) => typeof value[key] === "string" && HASH.test(value[key] as string)) ||
    !["offset", "endOffset", "deliveredBytes"].every(
      (key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0,
    ) ||
    Number(value.endOffset) < Number(value.offset)
  )
    throw invalid("Artifact read receipt is malformed.");
  const { receiptSha256, ...core } = value;
  if (receiptSha256 !== sha256Text(canonicalJson(core)))
    throw invalid("Artifact read receipt failed its intrinsic hash binding.");
  return value as unknown as ArtifactReadReceipt;
}
function invalid(message: string) {
  return new CliError(message, { code: "RESEARCH_ARTIFACT_READ_AUDIT_INVALID", exitCode: 3 });
}
