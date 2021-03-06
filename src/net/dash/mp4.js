/**
 * Copyright 2015 CANAL+ Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from "../../utils/assert";
import {
  itobe4, be8toi, be4toi, be2toi,
  hexToBytes, strToBytes, concat,
} from "../../utils/bytes";

/**
 * Find the right atom (box) in an isobmff file from its hexa-encoded name.
 * /!\ Only works for top-level boxes
 * @param {Uint8Array} buf - the isobmff structure
 * @param {Number} atomName - the 'name' of the box (e.g. 'sidx' or 'moov'),
 * hexa encoded
 * @returns {Number} - offset where the corresponding box is (starting with its
 * size), 0 if not found.
 */
function findAtom(buf, atomName) {
  const l = buf.length;
  let i = 0;

  let name, size;
  while (i + 8 < l) {
    size = be4toi(buf, i);
    name = be4toi(buf, i + 4);
    assert(size > 0, "dash: out of range size");
    if (name === atomName) {
      break;
    } else {
      i += size;
    }
  }

  if (i >= l) {
    return -1;
  }

  assert(i + size <= l, "dash: atom out of range");
  return i;
}

/**
 * @param {Uint8Array} buf - the isobmff structure
 * @param {Number} atomName - the 'name' of the box (e.g. 'sidx' or 'moov'),
 * hexa encoded
 * @returns {Number} - offset where the corresponding box is (starting with its
 * size), 0 if not found.
 */
function getAtomContent(buf, atomName) {
  const l = buf.length;
  let i = 0;

  let name, size;
  while (i + 8 < l) {
    size = be4toi(buf, i);
    name = be4toi(buf, i + 4);
    assert(size > 0, "dash: out of range size");
    if (name === atomName) {
      break;
    } else {
      i += size;
    }
  }

  if (i < l) {
    return buf.subarray(i + 8, i + size);
  } else {
    return null;
  }
}

function getMdat(buf) {
  return getAtomContent(buf, 0x6D646174 /* "mdat" */);
}

/**
 * Parse the sidx part (segment index) of the isobmff.
 * Returns null if not found.
 *
 * The object returned contains two keys:
 *   - segments {Array.<Object>} - Informations about each subsegment.
 *     Basically contains three keys:
 *       - ts {Number}: starting _presentation time_ for the subsegment,
 *         timescaled
 *       - d {Number}: duration of the subsegment, timescaled
 *       - r {Number}: always at 0
 *       - range {Array.<Number>}: first and last bytes in the media file
 *         from the anchor point (first byte after the sidx box) for the
 *         concerned subsegment.
 *   - timescale {Number}: The timescale used, to convert it to seconds
 * @param {Uint8Array} buf
 * @param {Number} offset
 * @returns {Object|null}
 */
function parseSidx(buf, offset) {
  const index = findAtom(buf, 0x73696478 /* "sidx" */);
  if (index == -1) {
    return null;
  }

  const size = be4toi(buf, index);
  let pos = index + /* size */4 + /* name */4;

  /* version(8) */
  /* flags(24) */
  /* reference_ID(32); */
  /* timescale(32); */
  const version = buf[pos]; pos += 4 + 4;
  const timescale = be4toi(buf, pos); pos += 4;

  /* earliest_presentation_time(32 / 64) */
  /* first_offset(32 / 64) */
  let time;
  if (version === 0) {
    time    = be4toi(buf, pos);        pos += 4;
    offset += be4toi(buf, pos) + size; pos += 4;
  }
  else if (version === 1) {
    time    = be8toi(buf, pos);        pos += 8;
    offset += be8toi(buf, pos) + size; pos += 8;
  }
  else {
    return null;
  }

  const segments = [];

  /* reserved(16) */
  /* reference_count(16) */
  pos += 2;
  let count = be2toi(buf, pos);
  pos += 2;
  while (--count >= 0) {
    /* reference_type(1) */
    /* reference_size(31) */
    /* segment_duration(32) */
    /* sap..(32) */
    const refChunk = be4toi(buf, pos);
    pos += 4;
    const refType = (refChunk & 0x80000000) >>> 31;
    const refSize = (refChunk & 0x7fffffff);

    // when set to 1 indicates that the reference is to a sidx, else to media
    if (refType == 1) {
      throw new Error("not implemented");
    }

    const d = be4toi(buf, pos);
    pos += 4;

    // let sapChunk = be4toi(buf, pos + 8);
    pos += 4;

    // TODO(pierre): handle sap
    // let startsWithSap = (sapChunk & 0x80000000) >>> 31;
    // let sapType = (sapChunk & 0x70000000) >>> 28;
    // let sapDelta = sapChunk & 0x0FFFFFFF;

    const ts = time;
    segments.push({
      ts, d, r: 0,
      range: [offset, offset + refSize - 1],
    });

    time += d;
    offset += refSize;
  }

  return { segments, timescale };
}

/**
 * Create a new _Atom_ (isobmff box).
 * @param {string} name - The box name (e.g. sidx, moov, pssh etc.)
 * @param {Uint8Array} buff - The box's content
 */
function Atom(name, buff) {
  const len = buff.length + 8;
  return concat(itobe4(len), strToBytes(name), buff);
}

/**
 * Returns a PSSH Atom from a systemId and private data.
 * @param {Object} args
 * @returns {Uint8Array}
 */
function createPssh({ systemId, privateData }) {
  systemId = systemId.replace(/-/g, "");

  assert(systemId.length === 32);
  return Atom("pssh", concat(
    4, // 4 initial zeroed bytes
    hexToBytes(systemId),
    itobe4(privateData.length),
    privateData
  ));
}

/**
 * Update ISOBMFF given to add a "pssh" box in the "moov" box for every content
 * protection in the pssList array given.
 * @param {Uint8Array} buf - the ISOBMFF file
 * @param {Array.<Object>} pssList - The content protections under the form of
 * objects containing two properties:
 *   - systemId {string}: The uuid code. Should only contain 32 hexadecimal
 *     numbers and hyphens
 *   - privateData {*}: private data associated.
 * @returns {Uint8Array} - The new ISOBMFF generated.
 */
function patchPssh(buf, pssList) {
  if (!pssList || !pssList.length) {
    return buf;
  }

  const pos = findAtom(buf, 0x6d6f6f76 /* = "moov" */);
  if (pos == -1) {
    return buf;
  }

  const size = be4toi(buf, pos); // size of the "moov" box
  const moov = buf.subarray(pos, pos + size);

  let newmoov = [moov];
  for (let i = 0; i < pssList.length; i++) {
    newmoov.push(createPssh(pssList[i]));
  }

  newmoov = concat.apply(null, newmoov);
  newmoov.set(itobe4(newmoov.length), 0); // overwrite "moov" length

  return concat(
    buf.subarray(0, pos),
    newmoov,
    buf.subarray(pos + size)
  );
}

export {
  parseSidx,
  patchPssh,
  getMdat,
};
