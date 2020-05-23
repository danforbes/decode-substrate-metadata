const fs = require("fs");
const path = require("path");

const WebSocket = require("ws");

(async () => {
  const rawMetadata = await getMetadata();
  const magic = rawMetadata.toString("utf-8", 0, 4);
  if (magic !== "meta") {
    throw new Error(`First four bytes of metadata should be 0x6d657461, found 0x${rawMetadata.toString("hex", 0, 4)}.`);
  }

  const version = `v${rawMetadata.readUInt8(4)}`;
  if (version !== `v11`) {
    throw new Error(`Metadata version should be v11, found ${version}.`);
  }

  const { offset: modulesOffset, value: modules } = decodeModules(rawMetadata, 5);
  // TODO: decode extrinsics
  const parsedMetadata = {
    magic,
    version,
    modules,
  };

  fs.writeFileSync(path.join(__dirname, "metadata.json"), JSON.stringify(parsedMetadata, null, 2));
  fs.writeFileSync(path.join(__dirname, "metadata.scale"), `0x${rawMetadata.toString("hex")}`);
})();

function getRpc() {
  return new Promise((resolve) => {
    const rpc = new WebSocket("wss://kusama-rpc.polkadot.io/");
    rpc.on("open", () => {
      resolve(rpc);
    });
  });
}

async function getMetadata() {
  const rpc = await getRpc();
  const request = {
    id: 1,
    jsonrpc: "2.0",
    method: "state_getMetadata",
    params: [],
  };

  rpc.send(JSON.stringify(request));

  return new Promise((resolve) => {
    rpc.onmessage = (msg) => {
      const result = JSON.parse(msg.data).result.substring(2);
      rpc.close();
      resolve(Buffer.from(result, "hex"));
    };
  });
}

// https://www.substrate.io/kb/advanced/codec#boolean
function decodeBool(buffer, offset) {
  const val = buffer.readUInt8(offset);
  return { offset: offset + 1, value: val ? true : false };
}

// https://www.substrate.io/kb/advanced/codec#compactgeneral-integers
function decodeCompact(buffer, offset) {
  const raw = buffer.readUInt8(offset);
  const flag = raw & 0b11;
  if (!flag) {
    return { offset: offset + 1, value: raw >> 2 };
  } else if (flag === 0b01) {
    return { offset: offset + 2, value: buffer.readUInt16LE(offset) >> 2 };
  } else if (flag === 0b10) {
    return { offset: offset + 4, value: buffer.readUInt32LE(offset) >> 2 };
  }

  const len = (raw >> 2) + 4;
  return { offset: offset + len, value: buffer.readIntLE(offset + 1, len) };
}

function decodeString(buffer, offset) {
  const { offset: compactOffset, value: len } = decodeCompact(buffer, offset);
  const strEnd = compactOffset + len;
  return { offset: strEnd, value: buffer.toString("utf-8", compactOffset, strEnd) };
}

// https://www.substrate.io/kb/advanced/codec#vectors-lists-series-sets
function decodeByteArray(buffer, offset) {
  const { offset: numBytesOffset, value: numBytes } = decodeCompact(buffer, offset);
  const arrEnd = numBytesOffset + numBytes;
  return { offset: arrEnd, value: buffer.slice(numBytesOffset, arrEnd) };
}

// https://www.substrate.io/kb/advanced/codec#vectors-lists-series-sets
function decodeArray(buffer, offset, decodeElem) {
  const { offset: numElemOffset, value: numElems } = decodeCompact(buffer, offset);
  let elemOffset = numElemOffset;
  const elems = [];

  for (let idx = 0; idx < numElems; ++idx) {
    const { offset, value: elem } = decodeElem(buffer, elemOffset);
    elemOffset = offset;
    elems.push(elem);
  }

  return { offset: elemOffset, value: elems };
}

function decodeStringArray(buffer, offset) {
  return decodeArray(buffer, offset, decodeString);
}

// https://www.substrate.io/kb/advanced/codec#options
function decodeOption(buffer, offset, decodeOpt) {
  const opt = buffer.readUInt8(offset);
  if (!opt) {
    return { offset: offset + 1, value: null };
  }

  return decodeOpt(buffer, offset + 1);
}

function decodeModules(buffer, offset) {
  const { offset: numModulesOffset, value: numModules } = decodeCompact(buffer, offset);
  const { offset: moduleOffset, value: module } = decodeModule(buffer, numModulesOffset);
  return { offset: moduleOffset, value: [module] };
}

// https://crates.parity.io/frame_metadata/struct.ModuleMetadata.html
function decodeModule(buffer, offset) {
  const { offset: nameOffset, value: name } = decodeString(buffer, offset);
  const { offset: storageOffset, value: storage } = decodeOption(buffer, nameOffset, decodeStorage);
  const { offset: callsOffset, value: calls } = decodeOption(buffer, storageOffset, decodeCalls);
  const { offset: eventsOffset, value: events } = decodeOption(buffer, callsOffset, decodeEvents);
  const { offset: constsOffset, value: constants } = decodeConstants(buffer, eventsOffset);
  // TODO: errors
  const module = {
    name,
    storage,
    calls,
    events,
    constants,
  };

  return { offset: constsOffset, value: module };
}

// https://crates.parity.io/frame_metadata/struct.StorageMetadata.html
function decodeStorage(buffer, offset) {
  const { offset: prefixOffset, value: prefix } = decodeString(buffer, offset);
  const { offset: entriesOffset, value: entries } = decodeStorageEntries(buffer, prefixOffset);
  return { offset: entriesOffset, value: { prefix, entries } };
}

function decodeStorageEntries(buffer, offset) {
  return decodeArray(buffer, offset, decodeStorageEntry);
}

// https://crates.parity.io/frame_metadata/struct.StorageEntryMetadata.html
function decodeStorageEntry(buffer, offset) {
  const { offset: nameOffset, value: name } = decodeString(buffer, offset);
  const { offset: modifierOffset, value: modifier } = decodeStorageModifier(buffer, nameOffset);
  const { offset: typeOffset, value: ty } = decodeStorageType(buffer, modifierOffset);
  const { offset: defaultOffset, value: _default } = decodeByteArray(buffer, typeOffset);
  const { offset: docOffset, value: documentation } = decodeStringArray(buffer, defaultOffset);
  const entry = {
    name,
    modifier,
    ty,
    default: _default,
    documentation,
  };

  return { offset: docOffset, value: entry };
}

// https://crates.parity.io/frame_metadata/enum.StorageEntryModifier.html
// https://www.substrate.io/kb/advanced/codec#enumerations-tagged-unions
function decodeStorageModifier(buffer, offset) {
  const idx = buffer.readUInt8(offset);
  return { offset: offset + 1, value: idx ? "Default" : "Optional" };
}

// https://crates.parity.io/frame_metadata/enum.StorageEntryType.html
// https://www.substrate.io/kb/advanced/codec#enumerations-tagged-unions
function decodeStorageType(buffer, offset) {
  const idx = buffer.readUInt8(offset);
  if (!idx) {
    const { offset: nameOffset, value: name } = decodeString(buffer, offset + 1);
    return { offset: nameOffset, value: { Plain: name } };
  } else if (idx === 1) {
    const { offset: hasherOffset, value: hasher } = decodeStorageHasher(buffer, offset + 1);
    const { offset: keyOffset, value: key } = decodeString(buffer, hasherOffset);
    const { offset: valueOffset, value: value } = decodeString(buffer, keyOffset);
    const { offset: unusedOffset, value: unused } = decodeBool(buffer, valueOffset);
    const Map = {
      hasher,
      key,
      value,
      unused,
    };

    return { offset: unusedOffset, value: { Map } };
  }

  const { offset: hasherOffset, value: hasher } = decodeStorageHasher(buffer, offset + 1);
  const { offset: key1Offset, value: key1 } = decodeString(buffer, hasherOffset);
  const { offset: key2Offset, value: key2 } = decodeString(buffer, key1Offset);
  const { offset: valueOffset, value: value } = decodeString(buffer, key2Offset);
  const { offset: key2HasherOffset, value: key2Hasher } = decodeStorageHasher(buffer, valueOffset);
  const DoubleMap = {
    hasher,
    key1,
    key2,
    value,
    key2Hasher,
  };

  return { offset: key2HasherOffset, value: { DoubleMap } };
}

// https://crates.parity.io/frame_metadata/enum.StorageHasher.html
// https://www.substrate.io/kb/advanced/codec#enumerations-tagged-unions
function decodeStorageHasher(buffer, offset) {
  const hashers = ["Blake2_128", "Blake2_256", "Blake2_128Concat", "Twox128", "Twox256", "Twox64Concat", "Identity"];

  const idx = buffer.readUInt8(offset);
  return { offset: offset + 1, value: hashers[idx] };
}

function decodeCalls(buffer, offset) {
  return decodeArray(buffer, offset, decodeCall);
}

// https://crates.parity.io/frame_metadata/struct.FunctionMetadata.html
function decodeCall(buffer, offset) {
  const { offset: nameOffset, value: name } = decodeString(buffer, offset);
  const { offset: argsOffset, value: arguments } = decodeCallArgs(buffer, nameOffset);
  const { offset: docOffset, value: documentation } = decodeStringArray(buffer, argsOffset);
  const call = {
    name,
    arguments,
    documentation,
  };

  return { offset: docOffset, value: call };
}

function decodeCallArgs(buffer, offset) {
  return decodeArray(buffer, offset, decodeCallArg);
}

// https://crates.parity.io/frame_metadata/struct.FunctionArgumentMetadata.html
function decodeCallArg(buffer, offset) {
  const { offset: nameOffset, value: name } = decodeString(buffer, offset);
  const { offset: typeOffset, value: ty } = decodeString(buffer, nameOffset);
  const arg = {
    name,
    ty,
  };

  return { offset: typeOffset, value: arg };
}

function decodeEvents(buffer, offset) {
  return decodeArray(buffer, offset, decodeEvent);
}

// https://crates.parity.io/frame_metadata/struct.EventMetadata.html
function decodeEvent(buffer, offset) {
  const { offset: nameOffset, value: name } = decodeString(buffer, offset);
  const { offset: argsOffset, value: arguments } = decodeStringArray(buffer, nameOffset);
  const { offset: docOffset, value: documentation } = decodeStringArray(buffer, argsOffset);
  const event = {
    name,
    arguments,
    documentation,
  };

  return { offset: docOffset, value: event };
}

function decodeConstants(buffer, offset) {
  return decodeArray(buffer, offset, decodeConstant);
}

// https://crates.parity.io/frame_metadata/struct.ModuleConstantMetadata.html
function decodeConstant(buffer, offset) {
  const { offset: nameOffset, value: name } = decodeString(buffer, offset);
  const { offset: typeOffset, value: ty } = decodeString(buffer, nameOffset);
  const { offset: valueOffset, value } = decodeByteArray(buffer, typeOffset);
  const { offset: docOffset, value: documentation } = decodeStringArray(buffer, valueOffset);
  const constant = {
    name,
    ty,
    value,
    documentation,
  };

  return { offset: docOffset, value: constant };
}
