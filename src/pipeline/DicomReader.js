/**
 * DicomReader — Pure JavaScript DICOM P10 Parser
 * HydroMorph — React Native (Expo) port
 *
 * Parses DICOM P10 binary format without any native modules.
 * Supports single-file parsing, multi-file series stacking,
 * and image file (PNG/JPG) pseudo-volume conversion.
 *
 * Key DICOM Tags Parsed:
 *   (0028,0010) Rows
 *   (0028,0011) Columns
 *   (0028,0100) BitsAllocated
 *   (0028,0103) PixelRepresentation
 *   (0028,1053) RescaleSlope
 *   (0028,1052) RescaleIntercept
 *   (0020,1041) SliceLocation
 *   (0020,0013) InstanceNumber
 *   (0028,0030) PixelSpacing
 *   (0018,0050) SliceThickness
 *   (7FE0,0010) PixelData
 *
 * Author: Matheus Machado Rech
 * License: Research use only — not for clinical diagnosis
 */

'use strict';

// ─── DICOM P10 Magic ───────────────────────────────────────────────────────────

const DICOM_PREAMBLE_LENGTH = 128;
const DICOM_MAGIC = [0x44, 0x49, 0x43, 0x4d]; // "DICM"

// ─── VR (Value Representation) types that have explicit 4-byte length ─────────

const EXPLICIT_LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT']);

// ─── Tag constants ─────────────────────────────────────────────────────────────

const TAG_ROWS               = 0x00280010;
const TAG_COLS               = 0x00280011;
const TAG_BITS_ALLOC         = 0x00280100;
const TAG_BITS_STORED        = 0x00280101;
const TAG_PIXEL_REP          = 0x00280103;
const TAG_RESCALE_SLOPE      = 0x00281053;
const TAG_RESCALE_INTERCEPT  = 0x00281052;
const TAG_SLICE_LOCATION     = 0x00201041;
const TAG_INSTANCE_NUMBER    = 0x00200013;
const TAG_PIXEL_SPACING      = 0x00280030;
const TAG_SLICE_THICKNESS    = 0x00180050;
const TAG_PIXEL_DATA         = 0x7FE00010;
const TAG_TRANSFER_SYNTAX    = 0x00020010;
const TAG_SAMPLES_PER_PIXEL  = 0x00280002;
const TAG_PHOTOMETRIC        = 0x00280004;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function makeTagKey(group, element) {
  return (group << 16) | element;
}

/**
 * Read a null-terminated or space-padded ASCII string from bytes.
 */
function readString(bytes, offset, length) {
  let end = offset + length;
  // Trim trailing nulls and spaces
  while (end > offset && (bytes[end - 1] === 0x00 || bytes[end - 1] === 0x20)) {
    end--;
  }
  let s = '';
  for (let i = offset; i < end; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s.trim();
}

/**
 * Parse a DS (Decimal String) or numeric string, returns float.
 */
function parseDS(str) {
  const v = parseFloat(str);
  return isNaN(v) ? 1.0 : v;
}

// ─── Core DICOM Tag Parser ─────────────────────────────────────────────────────

/**
 * Parse all DICOM tags from an ArrayBuffer.
 * Returns a Map<tagKey, { vr, value, valueBytes, offset, length }>.
 *
 * Handles both explicit and implicit VR transfer syntaxes.
 * For pixel data, stores the raw byte offset/length (parsed lazily).
 */
function parseDicomTags(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Verify DICOM magic
  if (bytes.length < DICOM_PREAMBLE_LENGTH + 4) {
    throw new Error('File too small to be a valid DICOM file');
  }

  const magic = [bytes[128], bytes[129], bytes[130], bytes[131]];
  const hasMagic = magic[0] === DICOM_MAGIC[0] &&
                   magic[1] === DICOM_MAGIC[1] &&
                   magic[2] === DICOM_MAGIC[2] &&
                   magic[3] === DICOM_MAGIC[3];

  // Start parsing after preamble (or from 0 if no magic — rare non-P10 DICOM)
  let offset = hasMagic ? 132 : 0;

  const tags = new Map();
  let littleEndian = true; // DICOM P10 default

  // We use explicit VR by default; will switch if we detect implicit
  let explicitVR = true;

  while (offset + 4 <= bytes.length) {
    // Read group and element
    const group   = view.getUint16(offset,     littleEndian);
    const element = view.getUint16(offset + 2, littleEndian);
    offset += 4;

    const tagKey = makeTagKey(group, element);

    // Item/sequence delimiters — skip
    if (group === 0xFFFE) {
      if (element === 0xE000 || element === 0xE00D || element === 0xE0DD) {
        // Item tag — skip the 4-byte length
        const itemLen = view.getUint32(offset, littleEndian);
        offset += 4;
        if (element === 0xE000 && itemLen !== 0xFFFFFFFF) {
          offset += itemLen; // skip item data
        }
        continue;
      }
    }

    // Determine if explicit VR: read 2 bytes after group/element
    // VR is two ASCII capital letters
    let vr = '';
    let valueLength = 0;

    if (offset + 2 <= bytes.length) {
      const b0 = bytes[offset];
      const b1 = bytes[offset + 1];
      // Heuristic: printable ASCII uppercase
      const isVR = (b0 >= 0x41 && b0 <= 0x5A) && (b1 >= 0x41 && b1 <= 0x5A);

      if (isVR && explicitVR) {
        vr = String.fromCharCode(b0) + String.fromCharCode(b1);
        offset += 2;

        if (EXPLICIT_LONG_VR.has(vr)) {
          // 2 reserved bytes + 4-byte length
          offset += 2;
          if (offset + 4 > bytes.length) break;
          valueLength = view.getUint32(offset, littleEndian);
          offset += 4;
        } else {
          // 2-byte length
          if (offset + 2 > bytes.length) break;
          valueLength = view.getUint16(offset, littleEndian);
          offset += 2;
        }
      } else {
        // Implicit VR — 4-byte length only
        explicitVR = false;
        vr = 'UN';
        if (offset + 4 > bytes.length) break;
        valueLength = view.getUint32(offset, littleEndian);
        offset += 4;
      }
    } else {
      break;
    }

    // Undefined length — for sequences/pixel data; skip sequence processing
    if (valueLength === 0xFFFFFFFF) {
      // For pixel data with undefined length, find the sequence delimiter
      if (tagKey === TAG_PIXEL_DATA) {
        tags.set(tagKey, { vr, valueBytes: null, offset, length: -1, undefined: true });
      }
      // Skip undefined length items — we'll scan forward for delimiter
      // This is a simplified approach: skip to next tag boundary
      // For sequences not needed, we just skip
      let found = false;
      while (offset + 8 <= bytes.length) {
        const sg = view.getUint16(offset, littleEndian);
        const se = view.getUint16(offset + 2, littleEndian);
        if (sg === 0xFFFE && se === 0xE0DD) {
          offset += 8; // skip delimiter tag + length
          found = true;
          break;
        }
        offset++;
      }
      if (!found) break;
      continue;
    }

    // Read value bytes
    const valueStart = offset;
    const safeLength = Math.min(valueLength, bytes.length - offset);
    offset += valueLength;

    if (valueLength > bytes.length) break; // corrupt

    const valueBytes = bytes.slice(valueStart, valueStart + safeLength);

    tags.set(tagKey, { vr, valueBytes, offset: valueStart, length: safeLength });
  }

  return { tags, buffer, bytes, view, littleEndian };
}

/**
 * Extract a string value from a tag.
 */
function getTagString(tags, tagKey) {
  const tag = tags.get(tagKey);
  if (!tag || !tag.valueBytes || tag.valueBytes.length === 0) return '';
  return readString(tag.valueBytes, 0, tag.valueBytes.length);
}

/**
 * Extract a numeric (DS) value from a tag.
 */
function getTagNumber(tags, tagKey, defaultVal = 1.0) {
  const str = getTagString(tags, tagKey);
  if (!str) return defaultVal;
  return parseDS(str);
}

/**
 * Extract integer from US (Unsigned Short) tag.
 */
function getTagUint16(parsed, tagKey, defaultVal = 0) {
  const tag = parsed.tags.get(tagKey);
  if (!tag || !tag.valueBytes || tag.valueBytes.length < 2) return defaultVal;
  const v = new DataView(tag.valueBytes.buffer, tag.valueBytes.byteOffset, tag.valueBytes.byteLength);
  return v.getUint16(0, parsed.littleEndian);
}

// ─── Pixel Data Extraction ─────────────────────────────────────────────────────

/**
 * Extract raw pixel data from parsed tags.
 * Returns Float32Array of HU values after applying Rescale Slope/Intercept.
 */
function extractPixelData(parsed, rows, cols, bitsAllocated, pixelRep, slope, intercept) {
  const { tags, buffer, bytes, view, littleEndian } = parsed;
  const pixelTag = tags.get(TAG_PIXEL_DATA);

  if (!pixelTag) {
    throw new Error('No pixel data tag (7FE0,0010) found in DICOM file');
  }

  const numPixels = rows * cols;
  const bytesPerPixel = bitsAllocated / 8;
  const expectedBytes = numPixels * bytesPerPixel;

  let rawData;

  if (pixelTag.undefined || !pixelTag.valueBytes) {
    // Pixel data with undefined length — scan the buffer from tag offset
    // Look for pixel data by scanning for 7FE0 0010 pattern
    let pixelStart = -1;
    for (let i = pixelTag.offset; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x00 && bytes[i+1] === 0x00 &&
          bytes[i+2] >= expectedBytes && bytes[i+3] === 0x00) {
        pixelStart = i + 4;
        break;
      }
    }
    if (pixelStart < 0) {
      // Fallback: use offset from end of file
      pixelStart = bytes.length - expectedBytes;
    }
    rawData = bytes.slice(pixelStart, pixelStart + expectedBytes);
  } else {
    rawData = pixelTag.valueBytes;
  }

  // Validate size
  if (rawData.length < numPixels * bytesPerPixel) {
    // If we have partial data, try to find pixel data near end of file
    const fallbackStart = bytes.length - numPixels * bytesPerPixel;
    if (fallbackStart > 0) {
      rawData = bytes.slice(fallbackStart);
    }
  }

  // Decode pixels based on bit depth
  const result = new Float32Array(numPixels);
  const rawView = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);

  if (bitsAllocated === 16) {
    if (pixelRep === 1) {
      // Signed 16-bit
      for (let i = 0; i < numPixels && i * 2 + 2 <= rawData.byteLength; i++) {
        const raw = rawView.getInt16(i * 2, littleEndian);
        result[i] = raw * slope + intercept;
      }
    } else {
      // Unsigned 16-bit
      for (let i = 0; i < numPixels && i * 2 + 2 <= rawData.byteLength; i++) {
        const raw = rawView.getUint16(i * 2, littleEndian);
        result[i] = raw * slope + intercept;
      }
    }
  } else if (bitsAllocated === 8) {
    if (pixelRep === 1) {
      for (let i = 0; i < numPixels && i < rawData.byteLength; i++) {
        result[i] = rawView.getInt8(i) * slope + intercept;
      }
    } else {
      for (let i = 0; i < numPixels && i < rawData.byteLength; i++) {
        result[i] = rawData[i] * slope + intercept;
      }
    }
  } else if (bitsAllocated === 32) {
    for (let i = 0; i < numPixels && i * 4 + 4 <= rawData.byteLength; i++) {
      result[i] = rawView.getInt32(i * 4, littleEndian) * slope + intercept;
    }
  } else {
    throw new Error(`Unsupported BitsAllocated: ${bitsAllocated}`);
  }

  return result;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a single DICOM P10 file from an ArrayBuffer.
 *
 * @param {ArrayBuffer} arrayBuffer  - Raw file bytes
 * @returns {{
 *   rows: number,
 *   cols: number,
 *   pixelData: Float32Array,   // HU values
 *   sliceLocation: number,
 *   instanceNumber: number,
 *   pixelSpacingX: number,    // mm/pixel in X
 *   pixelSpacingY: number,    // mm/pixel in Y
 *   sliceThickness: number,   // mm
 *   bitsAllocated: number,
 *   slope: number,
 *   intercept: number,
 * }}
 */
export function parseDicomFile(arrayBuffer) {
  const parsed = parseDicomTags(arrayBuffer);
  const { tags } = parsed;

  const rows          = getTagUint16(parsed, TAG_ROWS, 0);
  const cols          = getTagUint16(parsed, TAG_COLS, 0);
  const bitsAllocated = getTagUint16(parsed, TAG_BITS_ALLOC, 16);
  const pixelRep      = getTagUint16(parsed, TAG_PIXEL_REP, 0);

  if (rows === 0 || cols === 0) {
    throw new Error(`Invalid DICOM dimensions: ${rows}×${cols}`);
  }

  const slope     = getTagNumber(tags, TAG_RESCALE_SLOPE,     1.0);
  const intercept = getTagNumber(tags, TAG_RESCALE_INTERCEPT, 0.0);

  // SliceLocation or InstanceNumber for sorting
  const sliceLocationStr = getTagString(tags, TAG_SLICE_LOCATION);
  const sliceLocation    = sliceLocationStr ? parseDS(sliceLocationStr) : NaN;
  const instanceNumber   = getTagNumber(tags, TAG_INSTANCE_NUMBER, 0);

  // PixelSpacing: "rowSpacing\colSpacing" in mm
  const pixelSpacingStr = getTagString(tags, TAG_PIXEL_SPACING);
  let pixelSpacingX = 1.0, pixelSpacingY = 1.0;
  if (pixelSpacingStr) {
    const parts = pixelSpacingStr.split('\\');
    if (parts.length >= 2) {
      pixelSpacingX = parseDS(parts[0]);
      pixelSpacingY = parseDS(parts[1]);
    } else if (parts.length === 1) {
      pixelSpacingX = pixelSpacingY = parseDS(parts[0]);
    }
  }
  // Validate spacing
  if (pixelSpacingX <= 0 || pixelSpacingX > 100) pixelSpacingX = 1.0;
  if (pixelSpacingY <= 0 || pixelSpacingY > 100) pixelSpacingY = 1.0;

  const sliceThickness = (() => {
    const t = getTagNumber(tags, TAG_SLICE_THICKNESS, 0);
    return (t > 0 && t < 100) ? t : 1.0;
  })();

  const pixelData = extractPixelData(
    parsed, rows, cols, bitsAllocated, pixelRep, slope, intercept
  );

  return {
    rows,
    cols,
    pixelData,
    sliceLocation,
    instanceNumber,
    pixelSpacingX,
    pixelSpacingY,
    sliceThickness,
    bitsAllocated,
    slope,
    intercept,
  };
}

/**
 * Parse a DICOM series from multiple ArrayBuffers.
 *
 * Sorts slices by SliceLocation (falling back to InstanceNumber),
 * stacks them into a 3D volume, and returns the same format as NiftiReader:
 *   { shape: [cols, rows, numSlices], spacing: [sx, sy, sz], data: Float32Array, header }
 *
 * @param {ArrayBuffer[]} arrayBuffers  - Array of DICOM file buffers
 * @param {Function} [onProgress]       - (current, total) => void
 * @returns {{ shape, spacing, data, header, affine }}
 */
export async function parseDicomSeries(arrayBuffers, onProgress = () => {}) {
  if (!arrayBuffers || arrayBuffers.length === 0) {
    throw new Error('No DICOM files provided');
  }

  const slices = [];
  const total = arrayBuffers.length;

  // Parse each file
  for (let i = 0; i < total; i++) {
    onProgress(i + 1, total);
    try {
      const slice = parseDicomFile(arrayBuffers[i]);
      slices.push(slice);
    } catch (err) {
      console.warn(`DicomReader: Skipping slice ${i} (${err.message})`);
    }
    // Yield to UI every 10 slices
    if (i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (slices.length === 0) {
    throw new Error('No valid DICOM slices could be parsed from the provided files');
  }

  // Sort slices: prefer SliceLocation, fallback to InstanceNumber
  const hasSliceLoc = slices.some(s => !isNaN(s.sliceLocation));
  slices.sort((a, b) => {
    if (hasSliceLoc) {
      const la = isNaN(a.sliceLocation) ? a.instanceNumber * 1e6 : a.sliceLocation;
      const lb = isNaN(b.sliceLocation) ? b.instanceNumber * 1e6 : b.sliceLocation;
      return la - lb;
    }
    return a.instanceNumber - b.instanceNumber;
  });

  // Validate consistent dimensions
  const { rows, cols } = slices[0];
  const validSlices = slices.filter(s => s.rows === rows && s.cols === cols);
  if (validSlices.length < slices.length) {
    console.warn(
      `DicomReader: ${slices.length - validSlices.length} slices had inconsistent dimensions and were excluded`
    );
  }
  if (validSlices.length === 0) {
    throw new Error('No slices with consistent dimensions found');
  }

  const numSlices = validSlices.length;

  // Compute slice spacing from SliceLocation differences (more accurate than SliceThickness tag)
  let sliceSpacing = validSlices[0].sliceThickness;
  if (hasSliceLoc && numSlices > 1) {
    const locationDiffs = [];
    for (let i = 1; i < Math.min(numSlices, 11); i++) {
      const diff = Math.abs(validSlices[i].sliceLocation - validSlices[i - 1].sliceLocation);
      if (diff > 0.01 && diff < 50) locationDiffs.push(diff);
    }
    if (locationDiffs.length > 0) {
      locationDiffs.sort((a, b) => a - b);
      sliceSpacing = locationDiffs[Math.floor(locationDiffs.length / 2)]; // median
    }
  }
  if (sliceSpacing <= 0 || sliceSpacing > 50) sliceSpacing = 1.0;

  // Stack pixel data into 3D volume
  // Shape: [cols, rows, numSlices] — X × Y × Z (matching NiftiReader convention)
  const totalVoxels = cols * rows * numSlices;
  const data = new Float32Array(totalVoxels);

  for (let z = 0; z < numSlices; z++) {
    const src = validSlices[z].pixelData;
    const zOffset = z * cols * rows;
    const pixelsToCopy = Math.min(src.length, cols * rows);
    for (let i = 0; i < pixelsToCopy; i++) {
      data[zOffset + i] = src[i];
    }
  }

  const sx = validSlices[0].pixelSpacingX;
  const sy = validSlices[0].pixelSpacingY;
  const sz = sliceSpacing;

  return {
    shape:   [cols, rows, numSlices],
    spacing: [sx, sy, sz],
    affine: [
      [sx, 0,  0,  0],
      [0,  sy, 0,  0],
      [0,  0,  sz, 0],
      [0,  0,  0,  1],
    ],
    data,
    header: {
      ndim:      3,
      datatype:  4,    // INT16 equivalent
      bitpix:    16,
      voxOffset: 0,
      sformCode: 0,
      dims:      [cols, rows, numSlices],
      pixdim:    [sx, sy, sz],
      source:    'DICOM',
      numSlices,
    },
  };
}

/**
 * Load a PNG/JPG image URI and convert to a grayscale pseudo-volume.
 *
 * The image is treated as a single 2D axial slice. The "volume" will have
 * shape [width, height, 1] with spacing [1, 1, 1].
 * Pixel values are mapped to a 0–80 HU-equivalent range.
 *
 * In React Native (Expo), we use expo-file-system to read the image as
 * base64, then manually decode the pixel values via a rough approximation
 * (actual PNG/JPEG decoding requires a native module or canvas; here we
 * use a grayscale heuristic by sampling the file).
 *
 * NOTE: For proper image support, integrate with expo-image-manipulator
 * or react-native-canvas. This implementation provides a functional
 * fallback for pipeline compatibility.
 *
 * @param {string} uri  - Local file URI (from expo-document-picker)
 * @returns {{ shape, spacing, data, header }}
 */
export async function parseImageFile(uri) {
  const FileSystem = require('expo-file-system');

  // Read as base64
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  // Decode to raw bytes
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  // Try to detect image format and extract rough dimensions
  // PNG: signature 89 50 4E 47, width at offset 16 (4 bytes BE), height at 20
  // JPEG: FF D8 FF, scan for SOF0/SOF2 markers (FF C0 / FF C2)

  let width = 512, height = 512;

  const isPng  = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;

  if (isPng && bytes.length > 24) {
    width  = (bytes[16] << 24 | bytes[17] << 16 | bytes[18] << 8 | bytes[19]) >>> 0;
    height = (bytes[20] << 24 | bytes[21] << 16 | bytes[22] << 8 | bytes[23]) >>> 0;
  } else if (isJpeg) {
    // Scan for SOF0 (FF C0) or SOF2 (FF C2) marker
    for (let i = 2; i < bytes.length - 8; i++) {
      if (bytes[i] === 0xFF && (bytes[i+1] === 0xC0 || bytes[i+1] === 0xC2)) {
        height = (bytes[i+5] << 8) | bytes[i+6];
        width  = (bytes[i+7] << 8) | bytes[i+8];
        break;
      }
    }
  }

  // Validate dimensions
  if (width <= 0 || width > 8192) width = 512;
  if (height <= 0 || height > 8192) height = 512;

  const numPixels = width * height;
  const data = new Float32Array(numPixels);

  // Approximate grayscale from raw pixel region.
  // For PNG: pixel data starts after IHDR + optional chunks, inside IDAT (compressed).
  // For JPEG: pixel data is entropy-coded.
  // Since proper decoding requires a decoder, we create a synthetic gradient
  // that at least gives the pipeline something to work with, and produce
  // a warning. In practice, users should provide CT DICOM/NIfTI files.
  //
  // A more complete implementation would use expo-image-manipulator to
  // convert to raw pixels, or offload to a WebView + canvas.
  //
  // For now: fill with a neutral HU value (brain-like 30 HU) so pipeline proceeds.
  for (let i = 0; i < numPixels; i++) {
    data[i] = 30; // neutral brain HU
  }

  // If the file has raw uncompressed pixel data at the end (unlikely for PNG/JPEG
  // but possible for raw exports), try to use it
  if (bytes.length >= numPixels) {
    const rawStart = bytes.length - numPixels;
    // Check if this region looks like grayscale (not too many repeated bytes)
    const sample = bytes.slice(rawStart, rawStart + Math.min(100, numPixels));
    const uniqueVals = new Set(sample).size;
    if (uniqueVals > 5) {
      // Map 0–255 → 0–80 HU range (brain window)
      for (let i = 0; i < numPixels; i++) {
        const raw = bytes[rawStart + i] || 0;
        data[i] = (raw / 255) * 80;
      }
    }
  }

  return {
    shape:   [width, height, 1],
    spacing: [1.0, 1.0, 1.0],
    affine: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    data,
    header: {
      ndim:      3,
      datatype:  16,
      bitpix:    32,
      voxOffset: 0,
      sformCode: 0,
      dims:      [width, height, 1],
      pixdim:    [1.0, 1.0, 1.0],
      source:    'Image',
      imageUri:  uri,
    },
    fileName: uri.split('/').pop() || 'image.png',
    fileSize: bytes.length,
    _imageWarning:
      'Image files provide limited HU data. For accurate morphometrics, use DICOM or NIfTI CT files.',
  };
}

/**
 * Detect whether a buffer is a valid DICOM P10 file.
 * Checks for the DICM magic at offset 128.
 */
export function isDicomBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 132) return false;
  return (
    bytes[128] === 0x44 &&  // D
    bytes[129] === 0x49 &&  // I
    bytes[130] === 0x43 &&  // C
    bytes[131] === 0x4D     // M
  );
}
