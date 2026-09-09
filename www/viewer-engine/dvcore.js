"use strict";
var DVCore = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // ../../../../websites/Alldatalogs/packages/datalog-core/browser/entry.ts
  var entry_exports = {};
  __export(entry_exports, {
    HALTECH_TYPES: () => HALTECH_TYPES,
    HPL_PID_NAMES: () => HPL_PID_NAMES,
    bucketDecimate: () => bucketDecimate,
    convertHolleyDlToCsv: () => convertHolleyDlToCsv,
    convertHplToCsv: () => convertHplToCsv,
    convertLdToCsv: () => convertLdToCsv,
    isHaltechCsv: () => isHaltechCsv,
    parseDatalogCsv: () => parseDatalogCsv,
    parseHaltechCsv: () => parseHaltechCsv
  });

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/decimate.ts
  function bucketDecimate(rows, maxPoints) {
    if (maxPoints <= 0 || rows <= maxPoints) {
      return Array.from({ length: rows }, (_, i) => i);
    }
    const indices = /* @__PURE__ */ new Set();
    for (let k = 0; k < maxPoints; k++) {
      indices.add(Math.min(rows - 1, Math.round(k * (rows - 1) / (maxPoints - 1))));
    }
    indices.add(0);
    indices.add(rows - 1);
    return Array.from(indices).sort((a, b) => a - b);
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/haltech/haltech-csv.ts
  var HALTECH_TYPES = {
    Angle: { div: 10, unit: "\xB0" },
    Pressure: { div: 10, unit: "kPa" },
    AbsPressure: { div: 10, unit: "kPa" },
    EngineSpeed: { div: 1, unit: "rpm" },
    Percentage: { div: 10, unit: "%" },
    Temperature: { div: 10, add: -273.15, unit: "\xB0C" },
    // 0.1 K
    BatteryVoltage: { div: 1e3, unit: "V" },
    Time_us: { div: 1e3, unit: "ms" },
    Time_ms_as_s: { div: 1e3, unit: "s" },
    AFR: { div: 1e3, unit: "\u03BB" },
    Speed: { div: 10, unit: "km/h" },
    Acceleration: { div: 1e3, unit: "g" },
    ShorterDistance: { div: 1e3, unit: "mm" },
    // µm
    DrivenDistance: { div: 1e3, unit: "km" },
    // m
    Ratio: { div: 1e3, unit: "" },
    AngularVelocity: { div: 10, unit: "\xB0/s" },
    Gear: { div: 1, unit: "" },
    Position: { div: 1, unit: "" },
    Flow: { div: 1, unit: "" },
    Raw: { div: 1, unit: "" }
  };
  function isHaltechCsv(text) {
    return /^﻿?\s*%DataLog%/.test(text.slice(0, 32));
  }
  var TIME_RE = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/;
  function wallClockSeconds(cell) {
    const m = TIME_RE.exec(cell);
    if (!m) return NaN;
    const frac = m[4] ? Number("0." + m[4]) : 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
  }
  function parseHaltechCsv(text) {
    const warnings = [];
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines[0].charCodeAt(0) === 65279) lines[0] = lines[0].slice(1);
    const chans = [];
    let cur = null;
    let dataStart = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const comma = line.indexOf(",");
      if (TIME_RE.test(comma === -1 ? line : line.slice(0, comma))) {
        dataStart = i;
        break;
      }
      const sep = line.indexOf(" : ");
      if (sep === -1) continue;
      const key = line.slice(0, sep).trim();
      const val = line.slice(sep + 3).trim();
      if (key === "Channel") {
        cur = { name: val, id: 0, type: "Raw" };
        chans.push(cur);
      } else if (cur && key === "ID") cur.id = parseInt(val, 10) || 0;
      else if (cur && key === "Type") cur.type = val;
    }
    if (!chans.length) throw new Error('Haltech CSV: no "Channel :" blocks found in the header.');
    if (dataStart === -1) throw new Error("Haltech CSV: no data rows found after the header.");
    const keep = [];
    chans.forEach((c, i) => {
      if (c.name === "Unknown" && c.id === 0) {
        warnings.push({ code: "haltech_unknown_dropped", message: 'Dropped an "Unknown" placeholder column', channel: `column ${i + 2}` });
        return;
      }
      keep.push(i);
    });
    const seen = {};
    const channelNames = keep.map((i) => {
      const n2 = chans[i].name;
      seen[n2] = (seen[n2] || 0) + 1;
      if (seen[n2] > 1) {
        warnings.push({ code: "dup_channel", message: "Duplicate channel name renamed", channel: n2 });
        return `${n2} (${seen[n2]})`;
      }
      return n2;
    });
    const scales = keep.map((i) => {
      const t = HALTECH_TYPES[chans[i].type];
      if (!t) warnings.push({ code: "haltech_unknown_type", message: `Unknown Haltech channel type "${chans[i].type}"; values kept raw`, channel: chans[i].name });
      return t || { div: 1, unit: "" };
    });
    const units = scales.map((s) => s.unit);
    const n = keep.length;
    const time = [];
    const series = Array.from({ length: n }, () => []);
    const last = new Float64Array(n).fill(NaN);
    let t0 = NaN, prevT = NaN, dayOffset = 0, skipped = 0;
    for (let i = dataStart; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cells = line.split(",");
      const wall = wallClockSeconds(cells[0].trim());
      if (!isFinite(wall)) {
        skipped++;
        continue;
      }
      if (isNaN(t0)) t0 = wall;
      if (isFinite(prevT) && wall + dayOffset - t0 < prevT - 3600) dayOffset += 86400;
      let t = wall + dayOffset - t0;
      if (isFinite(prevT) && t < prevT) t = prevT;
      prevT = t;
      time.push(t);
      for (let k = 0; k < n; k++) {
        const cell = cells[keep[k] + 1];
        let v = last[k];
        if (cell !== void 0 && cell !== "") {
          const raw = Number(cell);
          if (!isNaN(raw)) {
            const s = scales[k];
            v = raw / s.div + (s.add || 0);
            last[k] = v;
          }
        }
        series[k].push(v);
      }
    }
    if (!time.length) throw new Error("Haltech CSV: no data rows could be read.");
    if (skipped) warnings.push({ code: "haltech_rows_skipped", message: `Skipped ${skipped} row(s) without a time stamp` });
    return { channelNames, units, time, series, textLevels: {}, channelIds: null, warnings };
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/megasquirt/msl.ts
  function isMlvlgBinary(head) {
    return head.slice(0, 5) === "MLVLG";
  }
  var HEADER_RE = /^"?\s*Time\s*"?\t/i;
  function isMegaSquirtLog(text) {
    const head = text.slice(0, 4096);
    if (isMlvlgBinary(head)) return true;
    const lines = head.split(/\r\n|\r|\n/, 12);
    if (!lines.length) return false;
    const first = lines[0].replace(/^﻿/, "");
    const quotedStart = first.charAt(0) === '"';
    const captureLine = lines.slice(0, 4).some((l) => /^"?\s*Capture Date:/i.test(l));
    if (!quotedStart && !captureLine) return false;
    return lines.some((l) => HEADER_RE.test(l));
  }
  function csvCell(cell) {
    const s = cell.trim();
    return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function megaSquirtToCsv(text) {
    if (isMlvlgBinary(text.slice(0, 8))) {
      throw new Error("This .mlg is MegaLogViewer's binary log. Open it in MegaLogViewer or TunerStudio and save it as a .msl text log, then open that.");
    }
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length && lines[0].charCodeAt(0) === 65279) lines[0] = lines[0].slice(1);
    let h = -1;
    for (let i = 0; i < lines.length && i < 64; i++) {
      if (HEADER_RE.test(lines[i])) {
        h = i;
        break;
      }
    }
    if (h === -1) throw new Error('MegaSquirt log: no TAB-separated "Time" header row found.');
    const out = [];
    for (let i = h; i < lines.length; i++) {
      const line = lines[i];
      if (i > h + 1 && !line.trim()) continue;
      if (line.charAt(0) === "#" && i > h + 1) continue;
      out.push(line.split("	").map(csvCell).join(","));
    }
    return out.join("\n");
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/importers/csv.ts
  function splitCsvLine(line, parenAware) {
    const hasQuote = line.indexOf('"') !== -1;
    const hasParen = parenAware && line.indexOf("(") !== -1;
    if (!hasQuote && !hasParen) return line.split(",");
    let honourQuotes = hasQuote;
    if (honourQuotes) {
      let nq = 0;
      for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) === 34) nq++;
      if (nq % 2 !== 0) honourQuotes = false;
    }
    let honourParens = hasParen;
    if (honourParens) {
      let bal = 0;
      for (let i = 0; i < line.length && bal >= 0; i++) {
        const ch = line[i];
        if (ch === "(") bal++;
        else if (ch === ")") bal--;
      }
      if (bal !== 0) honourParens = false;
    }
    if (!honourQuotes && !honourParens) return line.split(",");
    const out = [];
    let cur = "";
    let inQ = false;
    let depth = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        cur += ch;
        if (ch === '"') inQ = false;
        continue;
      }
      if (ch === '"' && honourQuotes && cur.trim() === "") {
        inQ = true;
        cur += ch;
        continue;
      }
      if (honourParens) {
        if (ch === "(") depth++;
        else if (ch === ")" && depth > 0) depth--;
      }
      if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    out.push(cur);
    return out;
  }
  function unquote(s) {
    const t = s.trim();
    if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return t.slice(1, -1).replace(/""/g, '"');
    return t;
  }
  var NAN_SPELLINGS = /^(?:[+-]?nan(?:\(ind\))?|[+-]?inf(?:inity)?|#div\/0!|#n\/a|n\/a|null|--)$/i;
  function parseDatalogCsv(text) {
    if (isHaltechCsv(text)) return parseHaltechCsv(text);
    if (isMegaSquirtLog(text)) text = megaSquirtToCsv(text);
    const warnings = [];
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines[0].charCodeAt(0) === 65279) lines[0] = lines[0].slice(1);
    if (/^\s*"?\s*point number\s*"?\s*,\s*"?\s*rtc\s*"?/i.test(lines[0] || "")) {
      for (let i = 0; i < lines.length; i++) {
        const k = lines[i].indexOf(",");
        lines[i] = k >= 0 ? lines[i].slice(k + 1) : lines[i];
      }
      const k0 = lines[0].indexOf(",");
      lines[0] = "Offset" + (k0 >= 0 ? lines[0].slice(k0) : "");
      if (lines.length > 1) lines[1] = lines[1].replace(/[[\]]/g, "");
    }
    let namesLine;
    let unitsLine;
    let dataStart = -1;
    let namesIdx = -1;
    const markerIdx = lines.findIndex((l) => l.trim().toLowerCase() === "[channel data]");
    if (markerIdx !== -1) {
      let j = markerIdx - 1;
      while (j >= 0 && lines[j].trim() === "") j--;
      unitsLine = lines[j];
      j--;
      while (j >= 0 && lines[j].trim() === "") j--;
      namesLine = lines[j];
      namesIdx = j;
      dataStart = markerIdx + 1;
      while (dataStart < lines.length && lines[dataStart].trim() === "") dataStart++;
    } else {
      let headerIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^"?\s*(time|offset)\b[^,]*,/i.test(lines[i])) {
          headerIdx = i;
          break;
        }
      }
      if (headerIdx !== -1) {
        namesLine = lines[headerIdx];
        namesIdx = headerIdx;
        const probeCells = splitCsvLine(lines[headerIdx + 1] || "", false);
        const probeSecond = probeCells.length > 1 ? parseFloat(unquote(probeCells[1])) : NaN;
        if (probeCells.length > 1 && !isFinite(probeSecond)) {
          unitsLine = lines[headerIdx + 1];
          dataStart = headerIdx + 2;
        } else {
          unitsLine = "";
          dataStart = headerIdx + 1;
        }
        while (dataStart < lines.length && lines[dataStart].trim() === "") dataStart++;
      }
    }
    if (namesLine === void 0 || dataStart === -1) {
      throw new Error(
        `This doesn't look like a supported datalog CSV (no "[Channel Data]" section or "time,..."/"offset,..." header row found).`
      );
    }
    const stripSctMeta = (s) => {
      const bar = s.indexOf("|");
      return bar === -1 ? s : s.slice(0, bar).trim();
    };
    let dataCols = 0;
    for (let pc = dataStart; pc < lines.length && pc < dataStart + 5; pc++) {
      const probe = lines[pc].trim();
      if (!probe || probe.charAt(0) === "[" || probe.charAt(0) === "-" && probe.charAt(1) === "-") continue;
      const pn = splitCsvLine(probe, false).length;
      if (pn > dataCols) dataCols = pn;
    }
    let rawNames = splitCsvLine(namesLine, true);
    while (dataCols > 1 && rawNames.length > dataCols && rawNames[rawNames.length - 1].trim() === "") rawNames.pop();
    if (dataCols > 1 && rawNames.length > dataCols) {
      const headerCols = rawNames.length;
      const folded = rawNames.slice(dataCols - 1).join(",");
      rawNames = rawNames.slice(0, dataCols - 1).concat(folded);
      warnings.push({
        code: "header_fold",
        message: `Header has ${headerCols} names for ${dataCols} data columns; folded the last ${headerCols - dataCols + 1} into one channel name`,
        channel: unquote(folded)
      });
    }
    rawNames = rawNames.map((s) => stripSctMeta(unquote(s)));
    const seenNames = {};
    const allNames = rawNames.map((n) => {
      seenNames[n] = (seenNames[n] || 0) + 1;
      if (seenNames[n] > 1) {
        warnings.push({ code: "dup_channel", message: `Duplicate channel name renamed`, channel: n });
        return `${n} (${seenNames[n]})`;
      }
      return n;
    });
    const channelNames = allNames.slice(1);
    let rawUnits = splitCsvLine(unitsLine || "", true);
    if (dataCols > 1 && rawUnits.length > dataCols) {
      rawUnits = rawUnits.slice(0, dataCols - 1).concat(rawUnits.slice(dataCols - 1).join(","));
    }
    const units = rawUnits.map(unquote).slice(1);
    let allIds = null;
    let pidIdx = namesIdx - 1;
    while (pidIdx >= 0 && lines[pidIdx].trim() === "") pidIdx--;
    if (pidIdx >= 0 && lines[pidIdx].trim().charAt(0) !== "[") {
      const pidTokens = lines[pidIdx].split(",").map((s) => s.trim());
      const pidShape = pidTokens.every((s) => s === "" || /^\d+$/.test(s));
      const pidSeen = pidTokens[0] === "0" && pidTokens.slice(1).some((s) => s !== "");
      if (pidShape && pidSeen) {
        allIds = allNames.map((_, i) => {
          const s = i < pidTokens.length ? pidTokens[i] : "";
          if (s === "") return null;
          const id = parseInt(s, 10);
          return i > 0 && id === 0 ? null : id;
        });
      }
    }
    const numCols = allNames.length;
    const time = [];
    const series = Array.from({ length: numCols - 1 }, () => []);
    const dataRows = [];
    for (let i = dataStart; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith("--") || line.startsWith("[")) break;
      dataRows.push(i);
    }
    const nonEmpty = Array.from({ length: numCols - 1 }, () => 0);
    const textCount = Array.from({ length: numCols - 1 }, () => 0);
    for (const i of dataRows) {
      const parts = splitCsvLine(lines[i].trim(), false);
      if (parts.length < numCols) continue;
      if (!isFinite(parseFloat(unquote(parts[0])))) continue;
      for (let c = 1; c < numCols; c++) {
        const raw = unquote(parts[c] || "");
        if (raw === "") continue;
        nonEmpty[c - 1]++;
        if (isNaN(Number(raw)) && !NAN_SPELLINGS.test(raw)) textCount[c - 1]++;
      }
    }
    const isText = textCount.map((n, k) => n * 2 > nonEmpty[k]);
    const levels = Array.from({ length: numCols - 1 }, () => []);
    const levelIndex = Array.from({ length: numCols - 1 }, () => ({}));
    const strayCount = Array.from({ length: numCols - 1 }, () => 0);
    const strayExample = Array.from({ length: numCols - 1 }, () => "");
    for (const i of dataRows) {
      const parts = splitCsvLine(lines[i].trim(), false);
      if (parts.length < numCols) continue;
      const t = parseFloat(unquote(parts[0]));
      if (!isFinite(t)) continue;
      time.push(t);
      for (let c = 1; c < numCols; c++) {
        const k = c - 1;
        const raw = unquote(parts[c] || "");
        if (raw === "") {
          series[k].push(NaN);
          continue;
        }
        if (isText[k]) {
          const key = "#" + raw;
          let idx = levelIndex[k][key];
          if (idx === void 0) {
            idx = levels[k].length;
            levelIndex[k][key] = idx;
            levels[k].push(raw);
          }
          series[k].push(idx);
        } else {
          const v = Number(raw);
          if (isNaN(v)) {
            if (!NAN_SPELLINGS.test(raw)) {
              strayCount[k]++;
              if (strayCount[k] === 1) strayExample[k] = raw;
            }
            series[k].push(NaN);
          } else {
            series[k].push(isFinite(v) && Math.abs(v) < 1e300 ? v : NaN);
          }
        }
      }
    }
    if (time.length === 0) throw new Error("No data rows found in this file.");
    const keepIdx = [];
    for (let c = 0; c < channelNames.length; c++) {
      if (series[c].some((v) => isFinite(v))) keepIdx.push(c);
      else warnings.push({ code: "empty_channel", message: "Channel has no data", channel: channelNames[c] });
    }
    for (const c of keepIdx) {
      if (strayCount[c] > 0) {
        warnings.push({
          code: "non_numeric_cell",
          message: `${strayCount[c]} non-numeric cell(s) treated as missing (e.g. "${strayExample[c]}")`,
          channel: channelNames[c]
        });
      }
    }
    const textLevels = {};
    for (const c of keepIdx) {
      if (isText[c]) textLevels[channelNames[c]] = levels[c];
    }
    const ids = allIds;
    const channelIds = ids === null ? null : [ids[0] ?? null, ...keepIdx.map((c) => ids[c + 1] ?? null)];
    return {
      channelNames: keepIdx.map((c) => channelNames[c]),
      units: keepIdx.map((c) => units[c] || ""),
      time,
      series: keepIdx.map((c) => series[c]),
      textLevels,
      channelIds,
      warnings
    };
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/hpl/hpl-to-csv.ts
  var HPL_PID_NAMES = {
    3: "Fuel System #1 Status (SAE)",
    4: "Calculated Engine Load (SAE)",
    5: "Engine Coolant Temp (SAE)",
    6: "Short Term Fuel Trim Bank 1 (SAE)",
    7: "Long Term Fuel Trim Bank 1 (SAE)",
    8: "Short Term Fuel Trim Bank 2 (SAE)",
    9: "Long Term Fuel Trim Bank 2 (SAE)",
    10: "Fuel Pressure (SAE)",
    11: "Intake Manifold Absolute Pressure (SAE)",
    12: "Engine RPM (SAE)",
    13: "Vehicle Speed (SAE)",
    14: "Timing Advance (SAE)",
    15: "Intake Air Temp (SAE)",
    16: "Mass Airflow (SAE)",
    17: "Throttle Position (SAE)",
    20: "O2 Voltage B1S1 (SAE)",
    21: "O2 Voltage B1S2 (SAE)",
    24: "O2 Voltage B2S1 (SAE)",
    25: "O2 Voltage B2S2 (SAE)",
    35: "Fuel Rail Pressure (SAE)",
    47: "Fuel Level Input (SAE)",
    51: "Barometric Pressure (SAE)",
    52: "WB EQ Ratio 1 (SAE) (2)",
    56: "WB EQ Ratio 5 (SAE) (2)",
    60: "Catalyst Temp B1S1 (SAE)",
    61: "Catalyst Temp B2S1 (SAE)",
    66: "Control Module Voltage (SAE)",
    67: "Absolute Load (SAE)",
    68: "Equivalence Ratio Commanded (SAE)",
    69: "Relative Throttle Position (SAE)",
    70: "Ambient Air Temp (SAE)",
    73: "Accelerator Position D (SAE)",
    74: "Accelerator Position E (SAE)",
    76: "Commanded Throttle Actuator (SAE)",
    82: "Ethanol Fuel % (SAE)",
    94: "Engine Fuel Rate (SAE)",
    99: "Engine Reference Torque (SAE)",
    259: "Fuel System #2 Status (SAE)",
    403: "Relative Throttle Position A (SAE)",
    404: "Relative Throttle Position B (SAE)",
    407: "Commanded Throttle Actuator A (SAE)",
    408: "Commanded Throttle Actuator B (SAE)",
    411: "Mass Airflow A (SAE)",
    412: "Mass Airflow B (SAE)",
    594: "Monitor Status: Fuel System (SAE)",
    597: "Monitor Status: Oxygen Sensor Heater (SAE)",
    598: "Monitor Status: Oxygen Sensor (SAE)",
    2100: "Control Module Voltage",
    2107: "Throttle Position Sensor 2",
    2110: "Throttle Position Sensor",
    2111: "Throttle Position",
    2114: "Accelerator Pedal Position",
    2118: "Accelerator Pedal Position Sensor 1",
    2119: "Accelerator Pedal Position Sensor 2",
    2120: "Engine Oil Pressure",
    2124: "Engine Coolant Temp",
    2125: "Ambient Air Temp",
    2126: "Manifold Air Temp",
    2127: "Intake Air Temp",
    2128: "Intake Air Temp 2",
    2131: "Engine Run Time",
    2133: "Engine Oil Pressure Sensor",
    2135: "Engine RPM",
    2136: "Engine Oil Temp",
    2149: "Aircharge Temperature",
    2154: "Aircharge",
    2161: "Throttle Desired Angle",
    2162: "Throttle Angle",
    2163: "Regulator Voltage",
    2164: "Intake Air Temp Sensor",
    2165: "Cylinder Head Temp",
    2170: "Intake Cam Des Angle",
    2172: "Intake Cam Angle",
    2173: "Intake Cam 2 Angle",
    2174: "Intake Cam Error",
    2175: "Intake Cam 2 Error",
    2176: "Exhaust Cam Des Angle",
    2178: "Exhaust Cam Angle",
    2179: "Exhaust Cam 2 Angle",
    2180: "Exhaust Cam Error",
    2181: "Exhaust Cam 2 Error",
    2182: "Intake Cam DC",
    2183: "Intake Cam 2 DC",
    2184: "Exhaust Cam DC",
    2185: "Exhaust Cam 2 DC",
    2210: "Idle Desired RPM",
    2216: "Relative Throttle",
    2219: "Mass Airflow Sensor 1",
    2240: "Idle Adapt (STIT)",
    2261: "Throttle Desired Angle (Flow Model)",
    2262: "Throttle Angle Feedback Adder",
    2263: "Throttle Angle Predicted (TQ Control)",
    2264: "Aircharge Temperature Sensor",
    2298: "Throttle Body Airflow",
    2300: "Mass Airflow",
    2301: "Mass Airflow Sensor",
    2302: "Mass Airflow Sensor",
    2305: "Base Volumetric Efficiency Bank 1",
    2311: "Volumetric Efficiency Airflow",
    2313: "Total Airflow",
    2316: "Desired Engine Airflow",
    2321: "Cylinder Airmass",
    2323: "Air Load",
    2324: "Intake Manifold Runner Control Sensor",
    2331: "Manifold Absolute Pressure",
    2332: "Manifold Absolute Pressure Sensor",
    2336: "Boost Pressure",
    2337: "Pressure Ratio",
    2340: "Barometric Pressure",
    2342: "Calculated Manifold Absolute Pressure",
    2343: "Supercharger Inlet Pressure",
    2354: "Turbo Bypass DC",
    2362: "Brake Pressure",
    2396: "Idle Torque Base Correction",
    2397: "Idle Torque Instant Correction",
    2398: "Idle RPM Error",
    2399: "Idle Torque Corr. Integral Term",
    2400: "Idle Torque Corr. Proportional Term",
    2401: "Idle Torque Corr. Derivative Term",
    2402: "Idle Torque Instant Corr. Prop. Term",
    2408: "MAP Maximum Achievable (Current Conditions)",
    2409: "Load Maximum Achievable (Current Conditions)",
    2410: "Barometric Pressure - Hi Res",
    2418: "Load Maximum Calibrated (Current Conditions)",
    2429: "Supercharger Inlet Pressure (Inferred)",
    2500: "Timing Advance",
    2501: "Drive Mode Requested",
    2513: "IAT Advance",
    2517: "Torque Mgt Advance",
    2605: "Knock Sensor 1",
    2606: "Knock Sensor 2",
    2630: "Knock Retard",
    2631: "Total Knock Retard",
    2632: "Knock Retard Short Term",
    2649: "Knock Correction (+Adv/-Ret)",
    2702: "Desired Brake Torque",
    2706: "Actual Torque",
    2707: "Expected Torque",
    2795: "Supercharger Bypass Stable Open",
    2796: "Supercharger Bypass Stable Closed",
    2797: "Supercharger Inlet Pressure for Bypass Open",
    2798: "Supercharger Inlet Pressure for Bypass Closed",
    3018: "Throttle Position ADC (Relative)",
    3100: "Misfire Current Cylinder #1",
    3101: "Misfire Current Cylinder #2",
    3102: "Misfire Current Cylinder #3",
    3103: "Misfire Current Cylinder #4",
    3104: "Misfire Current Cylinder #5",
    3105: "Misfire Current Cylinder #6",
    3106: "Misfire Current Cylinder #7",
    3107: "Misfire Current Cylinder #8",
    3130: "Total Misfires",
    3136: "Total Misfires Since Key-on",
    3203: "Relative Pedal",
    4024: "Clutch A Temp",
    4025: "Clutch B Temp",
    4028: "Clutch A Slip",
    4029: "Clutch B Slip",
    4050: "Clutch A Pressure (Corrected)",
    4051: "Clutch B Pressure (Corrected)",
    4100: "Trans Fluid Temp",
    4103: "Rear Diff Fluid Temp",
    4110: "Trans Input Shaft RPM",
    4111: "Trans Output Shaft RPM",
    4112: "Trans Turbine RPM",
    4115: "Trans Input Shaft RPM B",
    4117: "Trans Slip RPM",
    4190: "Clutch A Pressure",
    4191: "Clutch B Pressure",
    4192: "Clutch C Pressure",
    4193: "Clutch D Pressure",
    4194: "Clutch E Pressure",
    4205: "Line Pressure Desired",
    4210: "Line Pressure",
    4221: "Trans Calculated Gear Ratio",
    4254: "Shift Solenoid A Current",
    4255: "Shift Solenoid B Current",
    4256: "Shift Solenoid C Current",
    4257: "Shift Solenoid D Current",
    4258: "Shift Solenoid E Current",
    4260: "Shift Solenoid A Pressure",
    4261: "Shift Solenoid B Pressure",
    4262: "Shift Solenoid C Pressure",
    4263: "Shift Solenoid D Pressure",
    4264: "Shift Solenoid E Pressure",
    4265: "Shift Solenoid F Pressure",
    4267: "Line Pressure Solenoid Current",
    4268: "Shift Solenoid F Current",
    4300: "TCC PWM Duty Cycle",
    4311: "TCC Slip",
    4313: "TCC Desired Slip",
    4340: "TCC Line Pressure",
    4353: "Mass Airflow Period",
    4402: "Driver Demand Torque",
    5100: "Clutch Engine Pressure",
    5101: "Clutch F Pressure",
    5102: "Clutch G Pressure",
    5103: "Clutch H Pressure",
    5556: "Sonic Air Flow",
    6005: "Equivalence Ratio Commanded - Bank 1",
    6006: "Equivalence Ratio Commanded - Bank 2",
    6020: "Alcohol Percent",
    6023: "Desired Lambda B1",
    6040: "Desired FA Ratio Cyl 1",
    6100: "O2 Voltage B1S1",
    6102: "O2 Voltage B2S1",
    6160: "WB EQ Ratio Bank 1",
    6161: "WB EQ Ratio Bank 2",
    6179: "Injector Pulse Width Bank 1",
    6181: "WB EQ Ratio 1",
    6202: "Injector Pulse Width Cyl 1",
    6203: "Injector Pulse Width Cyl 2",
    6204: "Injector Pulse Width Cyl 3",
    6205: "Injector Pulse Width Cyl 4",
    6206: "Injector Pulse Width Cyl 5",
    6207: "Injector Pulse Width Cyl 6",
    6208: "Injector Pulse Width Cyl 7",
    6209: "Injector Pulse Width Cyl 8",
    6253: "Injector Pulse Width Average",
    6255: "Fuel Mass Cyl 1",
    6304: "Short Term Fuel Trim Bank 1",
    6305: "Long Term Fuel Trim Bank 1",
    6306: "Short Term Fuel Trim Bank 2",
    6307: "Long Term Fuel Trim Bank 2",
    6319: "Injector Pulse Width",
    6348: "DI Injector Effective Pulse Width Int.",
    6349: "DI Injector Effective Pulse Width Comp.",
    6376: "PFI Injector Maximum Pulse",
    6403: "Fuel Tank Level",
    6461: "Injector Pulse Width (24 MHz 216K EEC-V)",
    6485: "Low Fuel Pressure Desired",
    6501: "Desired Fuel Pressure",
    6506: "Fuel Pump Commanded DC",
    6509: "Fuel Flow Rate",
    6586: "Fuel Pump Actual",
    6587: "Fuel Pump Voltage Table X Axis Input",
    6588: "Fuel Pump Voltage Table Y Axis Input",
    6629: "Fuel Rail Temperature",
    6751: "Exhaust Gas Temperature B1S1",
    6755: "Fuel Rail Pressure",
    6831: "Average Fuel Mass",
    7101: "AC Pressure Sensor",
    7188: "Indicated Torque",
    7189: "Max Indicated Torque",
    7222: "Engine Load",
    7226: "Desired Charging Voltage",
    7282: "Battery Voltage",
    7323: "Charge Air Temp",
    7375: "Fuel Rail Pressure Sensor",
    7398: "Charge Pressure",
    7447: "TCC Speed Ratio",
    7480: "Turbo Speed Bank 1",
    7481: "Turbo Speed Bank 2",
    7912: "DI End Of Pulse Injection Angle (Intake) Firing Cyl 1",
    7924: "DI Start Of Injection Angle (Intake)",
    7925: "DI End Of Injection Angle (Compression)",
    7990: "Actual Spark",
    8e3: "Vehicle Speed",
    8022: "Torque Airlimit Source",
    8023: "DI/PI Blend Mode",
    8024: "DI/PI Blend",
    8029: "DI End Of Injection Angle",
    8205: "Desired Lambda",
    8215: "Actual Lambda B1",
    8216: "Actual Lambda B2",
    9309: "Torque Max Source",
    9310: "Torque Max Protection Source",
    9311: "Fuel Lift Pump Pressure Desired",
    9312: "Fuel Lift Pump Pressure Actual",
    9389: "Torque Limitation Engine Request",
    9392: "Max Load (Max Injection Time)",
    9393: "Max Load (Fuel System)",
    9394: "Max Load (Turbo Component Protection)",
    9395: "Max Load (Fuel Supply)",
    9397: "Max Load (Max Calibrated Torque)",
    9398: "Max Load (Reduced)",
    9399: "Max Load (Engine Derated)",
    9400: "Max Load (Camshaft Adaption)",
    9401: "Max Load (Rich/Lean Limit Comp. Prot.)",
    9402: "Max Load (Turbo Speed Limit)",
    9403: "Max Load (Final)",
    9404: "Max Load (Without Intervention)",
    10114: "Base Spark (Exh Cam Ref., Int Cam High Ext.)",
    12142: "Accelerator Pedal Position Fail Mode",
    12145: "RPM Limit Source",
    12146: "Trans Protect RPM Limit Source",
    12147: "Trans Protect Group ID",
    12148: "Trans Protect RPM Limit",
    12149: "Engine Speed Limiting Source",
    12200: "Idle Speed Control Mode",
    12304: "Throttle Control TPS State",
    12529: "Engine Indicated Torque Reference",
    12533: "Knock Octane Modifier",
    12534: "Knock Preignition Modifier",
    12535: "Knock Learned Average",
    12536: "Inferred Octane",
    12539: "Wastegate DC Proportional Term",
    12540: "Wastegate DC Integral Term",
    12600: "Crank Sensor Period",
    12700: "Torque Source",
    12701: "Throttle Torque Source",
    12824: "Accumulated Airmass",
    12861: "Fuel Cut",
    12864: "Hot Enrichment",
    12865: "Power Enrichment",
    12878: "Mass Airflow Fail",
    12913: "Injector 1 Fault",
    12961: "Knock Cyl A",
    12962: "Knock Cyl B",
    12963: "Knock Cyl C",
    12964: "Knock Cyl D",
    12965: "Knock Cyl E",
    12966: "Knock Cyl F",
    12967: "Knock Cyl G",
    12968: "Knock Cyl H",
    12971: "Cat Overtemp (COT)",
    12986: "Transbrake State",
    12987: "Transbrake Active",
    12993: "TR Command Spark Retard",
    12994: "TR Command Final",
    12995: "TR Command Cylinder Cutout",
    12996: "TR Command Fuel Enleanment",
    12997: "TR Authority Fuel Enleanment Clip",
    12998: "TR Authority Spark Clip",
    12999: "Burble Active",
    13011: "Antilag Activated",
    13012: "Antilag In Use",
    13013: "Desired Airmass from Antilag",
    13017: "Desired Airmass Arbitration Source",
    13018: "Desired Airmass Arbitration Multiplier",
    13020: "Speed Limit Maximum (Hard Limit)",
    13024: "OL Hard Rev Limit Active",
    13025: "OL Injector Cut Tq Control Active",
    13026: "OL Partial Injector Cut Active",
    13027: "OL Injector Cut Non Tq Control Active",
    14100: "Trans Current Gear",
    14103: "Trans Commanded Gear",
    14104: "Trans Selected Gear",
    14200: "Trans Shift Mode",
    14211: "Shift Map Current",
    14212: "Shift Scheduling State",
    14213: "SST Mode",
    14214: "Shift Character Desired",
    14215: "Ratio Manager Driver Mode",
    14410: "TCC State Commanded",
    14411: "TCC State Actual",
    14412: "TCC Status",
    14510: "Trans In Gear",
    14511: "Neutral Gear",
    14524: "TCC Current",
    14573: "TCC Locked",
    14574: "TCC Unlocked",
    14575: "TCC Slip Normal",
    14576: "TCC Slip AC",
    14994: "TIP Desired Max for Lubrication",
    14995: "TIP Desired Max for Comp. Outlet Pressure",
    14996: "TIP Desired Max for Comp. Outlet Temperature",
    14997: "TIP Desired Max for Turbo Speed",
    14999: "TIP Base from Desired Airmass",
    15002: "MAP from Desired Airmass",
    15003: "Throttle Inlet Pressure Desired",
    15004: "Throttle Inlet Pressure Actual",
    15005: "Throttle Inlet Pressure Error",
    15006: "Turbo Speed Desired",
    15007: "Turbo Speed Inferred",
    15008: "Turbo Speed Error",
    15009: "Turbo Airflow",
    15010: "Turbo Airflow Desired",
    15011: "Turbo Compressor Pressure Ratio",
    15012: "Turbo Exhaust Mass Flow Estimated",
    15013: "Turbo Desired Mass Fraction Exhaust Flow",
    15015: "Turbo Overboost Detected",
    15016: "Turbo Overboost Counter",
    15017: "Wastegate Duty Cycle",
    15018: "Wastegate Duty Cycle Desired",
    15019: "Wastegate Canister Pressure",
    15020: "Wastegate Canister Pressure Desired",
    15021: "Fuel Rail Pressure Actual",
    15022: "Fuel Rail Pressure Desired",
    15026: "Accelerator Pedal Position (Filtered)",
    15029: "Electronic Wastegate Command",
    15040: "Cruise Control Status",
    15534: "Electronic Wastegate A Position",
    15575: "Wastegate Position Actual (Bank 1)",
    15576: "Wastegate Position Actual (Bank 2)",
    15577: "Reduced Mass Flow Pre Turbo",
    16201: "Injector Pulse Mode",
    16204: "Fuel Pump",
    16205: "Fuel Pump Out Fail",
    16408: "Mass Airflow AD Counts",
    16409: "High Pressure Fuel Pump Regulator DC",
    16530: "Trans Fast Torque Reduction Source",
    16532: "Trans Persistant Torque Reduction Source",
    16533: "Trans Slow Torque Reduction Source",
    16535: "Trans Hardware Protection Source",
    17006: "Knock Cyl 1 (+Adv/-Ret)",
    17007: "Knock Cyl 2 (+Adv/-Ret)",
    17008: "Knock Cyl 3 (+Adv/-Ret)",
    17009: "Knock Cyl 4 (+Adv/-Ret)",
    17010: "Knock Cyl 5 (+Adv/-Ret)",
    17011: "Knock Cyl 6 (+Adv/-Ret)",
    17012: "Knock Cyl 7 (+Adv/-Ret)",
    17013: "Knock Cyl 8 (+Adv/-Ret)",
    19017: "Mapped Point 0 Weight",
    19018: "Mapped Point 1 Weight",
    19019: "Mapped Point 2 Weight",
    19020: "Mapped Point 3 Weight",
    19021: "Mapped Point 4 Weight",
    19022: "Mapped Point 5 Weight",
    19023: "Mapped Point 6 Weight",
    19024: "Mapped Point 7 Weight",
    19025: "Mapped Point 8 Weight",
    19026: "Mapped Point 9 Weight",
    19027: "Mapped Point 10 Weight",
    19028: "Mapped Point 11 Weight",
    19029: "Mapped Point 12 Weight",
    19030: "Mapped Point 13 Weight",
    19031: "Mapped Point 14 Weight",
    19032: "Mapped Point 15 Weight",
    19033: "Mapped Point 16 Weight",
    19034: "Mapped Point 17 Weight",
    19035: "Mapped Point 18 Weight",
    19036: "Mapped Point 19 Weight",
    19037: "Mapped Point 20 Weight",
    19038: "Mapped Point 21 Weight",
    19039: "Mapped Point 22 Weight",
    19040: "Mapped Point 23 Weight",
    19041: "Mapped Point 24 Weight",
    19042: "Mapped Point 25 Weight",
    19043: "Mapped Point 26 Weight",
    19044: "Mapped Point OP Weight",
    19045: "VCT Schedule Mode",
    19046: "Spark Source",
    19047: "Fuel Source",
    19048: "Driver Demand Limit Source",
    19049: "Idle Speed Source",
    19050: "Throttle Angle Source",
    19051: "VCT Distance to OP",
    19052: "VCT Number of Mapped Points",
    19053: "VCT Exhaust Cam Phase Angle",
    19054: "VCT Intake Cam Phase Angle",
    19055: "Manifold Charge Temp",
    19056: "Average Air Mass",
    19057: "Engine Brake Torque",
    19059: "ETC Torque Request",
    19061: "MBT Advance",
    19063: "ETC FMEM Mode",
    19068: "Scheduled Torque",
    19069: "IPC Wheel Torque Error",
    19070: "Aircharge Fault",
    19071: "Aircharge MIL Status",
    19073: "Borderline Modifier KOM",
    19074: "Borderline Knock",
    19075: "ETC Throttle Angle Error",
    19076: "Desired Load",
    19077: "Desired Airmass",
    19078: "Manifold Vacuum (ETC Model)",
    19079: "Effective Throttle Area (ETC Model)",
    19081: "Fuel Source (Torque Reduction)",
    19095: "Torque Request from Charge",
    30011: "MPVI2 PL A/D Input 1 (Red)",
    30012: "MPVI2 PL A/D Input 2 (Blue)",
    40001: "MPVI2.1 -> AEM 30-(03x0,2340,5130)",
    40101: "MPVI2.1 -> AEM 30-(03x0,2340,5130)",
    41102: "MPVI2.1 -> AEM (PN 30-2130-50) 50 PSIa (3 bar)",
    41104: "MPVI2.2 -> AEM (PN 30-2130-100) 100 PSIg"
  };
  var HPL_UNIT_CODES = {
    0: "",
    10: "V",
    33: "in\xB2",
    50: "Hz",
    56: "rpm",
    71: "g/s",
    72: "lb/h",
    73: "lb/min",
    75: "kg/h",
    91: "kPa",
    92: "MPa",
    97: "inHg",
    98: "psi",
    99: "bar",
    110: "m/s",
    113: "km/h",
    114: "mph",
    120: "N m",
    127: "lb\xB7ft",
    141: "L/h",
    150: "",
    155: "",
    156: "%",
    161: "\xB0",
    180: "A",
    182: "mA",
    223: "g",
    224: "mg",
    237: "lb",
    238: "\u03BB",
    241: "\xB0C",
    242: "\xB0F",
    248: "s",
    254: "ms",
    255: "\xB5s"
  };
  var NID = 65536;
  function hplValueWidth(tag) {
    return tag === 2 ? 1 : tag === 4 ? 2 : tag === 9 ? 4 : 8;
  }
  function hplTableStartFromHeader(buf) {
    for (let i = 0; i < 40 && i + 25 < buf.length; i++) {
      if (buf[i] === 83 && buf[i + 1] === 67 && buf[i + 2] === 0 && buf[i + 3] === 0 && buf[i + 4] === 1) return i + 21;
    }
    return -1;
  }
  function findChannelTableStart(buf, pos) {
    const known = pos - 5;
    for (let s = 0; s < known; s++) {
      let p = s;
      let count = 0;
      let ok = true;
      while (p < known) {
        if (p + 5 >= buf.length) {
          ok = false;
          break;
        }
        p += 5;
        const tag = buf[p];
        p += 1;
        if (tag !== 10 && tag !== 11 && tag !== 2 && tag !== 4 && tag !== 9) {
          ok = false;
          break;
        }
        p += 16;
        if (p >= buf.length) {
          ok = false;
          break;
        }
        const nl = buf[p];
        p += 1;
        if (nl < 0 || nl > 64 || p + nl > buf.length) {
          ok = false;
          break;
        }
        for (let j = p; j < p + nl; j++) {
          if (buf[j] < 32 || buf[j] > 126) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
        p += nl;
        if (p >= buf.length) {
          ok = false;
          break;
        }
        const ul = buf[p];
        p += 1;
        if (ul >= 16) {
          ok = false;
          break;
        }
        p += ul;
        count++;
      }
      if (ok && p === known && count > 0) return s;
    }
    return known;
  }
  function dryParse(d, idWidth, valid, isEnum, tMax, tagOf) {
    const n = d.length;
    let q = 2;
    let frames = 0;
    while (q + 4 <= n) {
      const t = d[q + 3];
      q += 4;
      if (t < 1 || t > tMax) return false;
      for (let u = 0; u < t; u++) {
        if (q + idWidth > n) return false;
        let id;
        let unchanged;
        if (idWidth === 1) {
          const b = d[q];
          q += 1;
          unchanged = b >= 128;
          id = unchanged ? b - 128 : b;
        } else {
          const b = d[q] | d[q + 1] << 8;
          q += 2;
          unchanged = (b & 32768) !== 0;
          id = unchanged ? b & 32767 : b;
        }
        if (!valid[id]) return false;
        if (!unchanged) {
          if (isEnum[id]) {
            if (q >= n) return false;
            const sl = d[q];
            q++;
            if (q + sl > n) return false;
            q += sl;
          } else {
            const w = hplValueWidth(tagOf[id]);
            if (q + w > n) return false;
            q += w;
          }
        }
      }
      frames++;
    }
    return frames > 0;
  }
  function asciiSlice(u8, start, end) {
    let s = "";
    for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
    return s;
  }
  var utf8 = new TextDecoder("utf-8");
  function convertHplToCsv(input, inflateRaw, opts) {
    const o = opts || {};
    const periodMs = o.periodMs != null ? o.periodMs : 40;
    const interpolate = !!o.interpolate;
    const startOffsetSec = o.startOffsetSec != null ? o.startOffsetSec : 0;
    const usUnits = !!o.usUnits;
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const headerless = buf.length >= 8 && buf[0] === 83 && buf[1] === 83 && buf[2] === 0 && buf[3] === 0 && (buf[4] === 83 && buf[5] === 89 && buf[6] === 78 && buf[7] === 67 || buf[4] === 115 && buf[5] === 121 && buf[6] === 110 && buf[7] === 99);
    if (!headerless && (buf.length < 8 || buf[0] !== 72 || buf[1] !== 80 || buf[2] !== 84)) {
      throw new Error("Not an HP Tuners .hpl file (missing 'HPT' signature).");
    }
    const version = headerless ? buf[4] === 115 ? 7 : 9 : buf[5];
    if (version === 7) {
      return convertV7(buf, { periodMs, interpolate, startOffsetSec, usUnits });
    }
    if (version === 6 || version === 8) {
      return convertV68(buf, inflateRaw, { periodMs, interpolate, startOffsetSec, usUnits, warnings: o.warnings });
    }
    if (version !== 9) {
      throw new Error(
        `This log uses an older HP Tuners format (version ${version}) this viewer can't open directly. Open it in VCM Scanner and re-save it \u2014 the newer file (or a CSV export) will load here.`
      );
    }
    let pos = -1;
    for (let i = 0; i < 512 && i + 8 < buf.length; i++) {
      if (buf[i] === 10 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 7] === 240 && buf[i + 8] === 63) {
        pos = i;
        break;
      }
    }
    let p;
    if (pos >= 0) p = findChannelTableStart(buf, pos);
    else {
      p = hplTableStartFromHeader(buf);
      if (p < 0) throw new Error("Could not locate channel table.");
    }
    const valid = new Array(NID).fill(false);
    const isEnum = new Array(NID).fill(false);
    const name = new Array(NID).fill(null);
    const unit = new Array(NID).fill("");
    const pidOf = new Array(NID).fill(0);
    const tagOf = new Uint8Array(NID);
    const scaleOf = new Float64Array(NID).fill(1);
    const offOf = new Float64Array(NID);
    const order = [];
    let maxId = 0;
    let typed = false;
    while (true) {
      if (p + 5 >= buf.length) break;
      const id = dv.getUint16(p, true);
      const pid = dv.getUint16(p + 2, true);
      p += 5;
      const tag = buf[p];
      p += 1;
      const sc = dv.getFloat64(p, true);
      const off = dv.getFloat64(p + 8, true);
      p += 16;
      const nl = buf[p];
      p += 1;
      if (nl < 0 || nl > 64 || p + nl > buf.length) break;
      let ascii = true;
      for (let j = p; j < p + nl; j++) {
        if (buf[j] < 32 || buf[j] > 126) {
          ascii = false;
          break;
        }
      }
      if (!ascii) break;
      let nm = asciiSlice(buf, p, p + nl);
      if (!nm) nm = HPL_PID_NAMES[pid] || `Channel ${pid}`;
      p += nl;
      const ul = buf[p];
      p += 1;
      let un = "";
      if (ul > 0 && ul < 16) {
        un = utf8.decode(buf.subarray(p, p + ul));
        p += ul;
      } else if (ul >= 16) break;
      if (!valid[id]) {
        valid[id] = true;
        name[id] = nm;
        unit[id] = un;
        pidOf[id] = pid;
        isEnum[id] = tag === 11;
        tagOf[id] = tag;
        scaleOf[id] = sc || 1;
        offOf[id] = off || 0;
        if (tag === 2 || tag === 4 || tag === 9) typed = true;
        order.push(id);
        if (id > maxId) maxId = id;
      }
    }
    const mul = new Float64Array(NID).fill(1);
    const add = new Float64Array(NID);
    const outUnit = new Array(NID).fill("");
    for (const id of order) {
      outUnit[id] = unit[id];
      if (usUnits) applyUsUnit(id, unit[id] || "", mul, add, outUnit);
    }
    const blockRanges = [];
    const blockTicks = [];
    let cutHeader = false;
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 67 && buf[i + 1] === 68 && buf[i + 2] === 71 && buf[i + 3] === 0) {
        if (i + 12 > buf.length) {
          cutHeader = true;
          break;
        }
        const clen = dv.getUint32(i + 4, true);
        blockRanges.push([i + 12, Math.min(i + 12 + clen, buf.length)]);
        const sy = i - 10;
        const hasSync = sy >= 0 && buf[sy] === 83 && buf[sy + 1] === 89 && buf[sy + 2] === 78 && buf[sy + 3] === 67;
        blockTicks.push(hasSync ? dv.getUint32(sy + 4, true) + dv.getUint16(sy + 8, true) * 4294967296 : null);
      }
    }
    const blocks = [];
    let truncated = cutHeader;
    for (const r of blockRanges) {
      let inflated = null;
      try {
        inflated = inflateRaw(buf.subarray(r[0], r[1]));
      } catch {
        inflated = null;
      }
      if (!inflated || inflated.length === 0) {
        truncated = true;
        break;
      }
      blocks.push(inflated);
    }
    const blocksSeen = blockRanges.length + (cutHeader ? 1 : 0);
    if (truncated && o.warnings) {
      o.warnings.push(
        `Log ends mid-block: ${blocks.length} of ${blocksSeen} data blocks read. The file looks truncated; the rows that could be decoded are shown.`
      );
    }
    if (blocks.length === 0) {
      throw new Error(
        truncated ? "This log is cut off before its first complete data block, so nothing can be decoded." : "No data blocks (CDG) found."
      );
    }
    const TICKS_PER_MS = 10;
    const baseTick = blockTicks.find((t) => t != null) ?? null;
    const tMax = order.length;
    let idWidth = maxId >= 128 ? 2 : 1;
    if (!dryParse(blocks[0], idWidth, valid, isEnum, tMax, tagOf)) {
      const alt = idWidth === 1 ? 2 : 1;
      if (dryParse(blocks[0], alt, valid, isEnum, tMax, tagOf)) idWidth = alt;
    }
    let ms24Base = 0;
    let prevMs24 = 0;
    let typedMax = 0;
    const sTime = new Array(NID);
    const sNum = new Array(NID);
    const sStr = new Array(NID);
    for (const id of order) {
      sTime[id] = [];
      if (isEnum[id]) sStr[id] = [];
      else sNum[id] = [];
    }
    const prevD = new Float64Array(NID);
    const prevS = new Array(NID);
    const hasPrev = new Array(NID).fill(false);
    const originMs = Math.round(startOffsetSec * 1e3);
    let blockStartMs = originMs;
    let maxMs = blockStartMs;
    for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
      const d = blocks[bIdx];
      const bt = blockTicks[bIdx];
      if (baseTick != null && bt != null) {
        blockStartMs = originMs + Math.round((bt - baseTick) / TICKS_PER_MS);
      }
      const ddv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const n = d.length;
      let q = 2;
      let baseC = 0;
      let prevC = -1;
      let firstC = -1;
      let lastUnwrap = 0;
      while (q + 4 <= n) {
        const c = d[q];
        const t = d[q + 3];
        q += 4;
        if (t < 1 || t > tMax) break;
        let gms;
        if (typed) {
          const ms24 = d[q - 4] | d[q - 3] << 8 | d[q - 2] << 16;
          if (ms24 < prevMs24 - 8388608) ms24Base += 16777216;
          prevMs24 = ms24;
          gms = ms24Base + ms24;
          if (gms > typedMax) typedMax = gms;
        } else {
          if (firstC < 0) {
            firstC = c;
            prevC = c;
          }
          if (c < prevC) baseC += 256;
          prevC = c;
          const unwrap = baseC + c - firstC;
          lastUnwrap = unwrap;
          gms = blockStartMs + unwrap;
        }
        let bad = false;
        for (let u = 0; u < t; u++) {
          if (q + idWidth > n) {
            bad = true;
            break;
          }
          let id;
          let unchanged;
          if (idWidth === 1) {
            const b = d[q];
            q += 1;
            unchanged = b >= 128;
            id = unchanged ? b - 128 : b;
          } else {
            const b = d[q] | d[q + 1] << 8;
            q += 2;
            unchanged = (b & 32768) !== 0;
            id = unchanged ? b & 32767 : b;
          }
          if (!valid[id]) {
            bad = true;
            break;
          }
          if (unchanged) {
            if (!hasPrev[id]) continue;
            sTime[id].push(gms);
            if (isEnum[id]) sStr[id].push(prevS[id]);
            else sNum[id].push(prevD[id]);
          } else {
            if (isEnum[id]) {
              if (q >= n) {
                bad = true;
                break;
              }
              const sl = d[q];
              q++;
              if (q + sl > n) {
                bad = true;
                break;
              }
              const sv = asciiSlice(d, q, q + sl);
              q += sl;
              prevS[id] = sv;
              hasPrev[id] = true;
              sTime[id].push(gms);
              sStr[id].push(sv);
            } else {
              const w = hplValueWidth(tagOf[id]);
              if (q + w > n) {
                bad = true;
                break;
              }
              const dvv = w === 8 ? ddv.getFloat64(q, true) : w === 4 ? ddv.getFloat32(q, true) : w === 2 ? ddv.getUint16(q, true) / scaleOf[id] + offOf[id] : d[q] / scaleOf[id] + offOf[id];
              q += w;
              prevD[id] = dvv;
              hasPrev[id] = true;
              sTime[id].push(gms);
              sNum[id].push(dvv);
            }
          }
        }
        if (bad) break;
      }
      blockStartMs += lastUnwrap;
      if (blockStartMs > maxMs) maxMs = blockStartMs;
    }
    if (typed) {
      let minMs = Infinity;
      for (const id of order) {
        const t = sTime[id];
        if (t.length && t[0] < minMs) minMs = t[0];
      }
      if (!isFinite(minMs)) throw new Error("No data rows found in this file.");
      for (const id of order) {
        const t = sTime[id];
        for (let z = 0; z < t.length; z++) t[z] = t[z] - minMs + originMs;
      }
      maxMs = typedMax - minMs + originMs;
    }
    return emitCsv(
      { order, name, outUnit, isEnum, sTime, sNum, sStr, mul, add, maxMs, pid: pidOf },
      { periodMs, interpolate, startOffsetSec }
    );
  }
  function applyUsUnit(id, u, mul, add, outUnit) {
    const DEG = "\xB0";
    const MIDDOT = "\xB7";
    if (u === DEG + "C") {
      mul[id] = 1.8;
      add[id] = 32;
      outUnit[id] = DEG + "F";
    } else if (u === "km/h") {
      mul[id] = 0.6213711922;
      outUnit[id] = "mph";
    } else if (u === "m/s") {
      mul[id] = 2.2369362921;
      outUnit[id] = "mph";
    } else if (u === "kPa") {
      mul[id] = 0.1450377377;
      outUnit[id] = "psi";
    } else if (u === "MPa") {
      mul[id] = 145.0377377;
      outUnit[id] = "psi";
    } else if (u === "inHg") {
      mul[id] = 0.4911541474;
      outUnit[id] = "psi";
    } else if (u === "bar") {
      mul[id] = 14.503773773;
      outUnit[id] = "psi";
    } else if (u === "g/s") {
      mul[id] = 0.1322773573;
      outUnit[id] = "lb/min";
    } else if (u === "N m") {
      mul[id] = 0.7375621493;
      outUnit[id] = "lb" + MIDDOT + "ft";
    }
  }
  function findV68Chain(buf, dv) {
    const n = buf.length;
    let best = -1;
    let bestEnd = -1;
    for (let k = 6; k + 8 <= n && k < 8192; k++) {
      let o = k;
      let links = 0;
      while (o + 4 <= n) {
        const len = dv.getUint32(o, true);
        if (len < 1 || o + 4 + len > n) break;
        o += 4 + len;
        links++;
      }
      if (links >= 2 && o === n) return { start: k, truncated: false };
      if (links >= 3 && o > bestEnd) {
        best = k;
        bestEnd = o;
      }
    }
    return best >= 0 && bestEnd > n * 0.9 ? { start: best, truncated: true } : null;
  }
  function convertV68(buf, inflateRaw, o) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const chain = findV68Chain(buf, dv);
    if (!chain) throw new Error("Could not find the data streams in this log.");
    let truncated = chain.truncated;
    const chans = [];
    let pos = chain.start;
    while (pos + 4 <= buf.length) {
      const len = dv.getUint32(pos, true);
      if (len < 1 || pos + 4 + len > buf.length) {
        if (pos !== buf.length) truncated = true;
        break;
      }
      let d;
      try {
        d = inflateRaw(buf.subarray(pos + 4, pos + 4 + len));
      } catch {
        truncated = true;
        break;
      }
      pos += 4 + len;
      if (!d || d.length < 14) continue;
      const ddv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      const pidv = ddv.getUint32(0, true);
      const code = d[5];
      const ord = ddv.getUint32(6, true);
      const cnt = ddv.getUint32(10, true);
      const isStr = code === 0 || d.length - 14 !== cnt * 16;
      const times = [];
      const nums = isStr ? null : [];
      const strs = isStr ? [] : null;
      let q = 14;
      for (let i = 0; i < cnt && q + 9 <= d.length; i++) {
        const lo = ddv.getUint32(q, true);
        const hi = ddv.getUint32(q + 4, true);
        q += 8;
        if (isStr) {
          const sl = d[q];
          q += 1;
          if (q + sl > d.length) break;
          strs.push(asciiSlice(d, q, q + sl));
          q += sl;
        } else {
          if (q + 8 > d.length) break;
          nums.push(ddv.getFloat64(q, true));
          q += 8;
        }
        times.push(hi * 4294967296 + lo);
      }
      chans.push({ pid: pidv, code, ord, isStr, times, nums, strs });
    }
    if (truncated && o.warnings) o.warnings.push("Log ends mid-stream; the channels that could be decoded are shown.");
    if (!chans.length) throw new Error("No channels found.");
    chans.sort((a, b) => a.ord - b.ord);
    let base = Infinity;
    for (const c of chans) if (c.times.length && c.times[0] < base) base = c.times[0];
    if (!isFinite(base)) throw new Error("No data rows found in this file.");
    const n = chans.length;
    const name = new Array(n).fill(null);
    const unit = new Array(n).fill("");
    const isEnum = new Array(n).fill(false);
    const order = [];
    const sTime = new Array(n);
    const sNum = new Array(n);
    const sStr = new Array(n);
    const pidOf = new Array(n).fill(0);
    let maxMs = 0;
    chans.forEach((c, id) => {
      name[id] = HPL_PID_NAMES[c.pid] || `Channel ${c.pid}`;
      unit[id] = c.isStr ? "" : HPL_UNIT_CODES[c.code] || "";
      isEnum[id] = c.isStr;
      pidOf[id] = c.pid;
      order.push(id);
      const t = c.times.map((x) => (x - base) / 1e4);
      sTime[id] = t;
      if (c.isStr) sStr[id] = c.strs;
      else sNum[id] = c.nums;
      if (t.length && t[t.length - 1] > maxMs) maxMs = t[t.length - 1];
    });
    const mul = new Float64Array(n).fill(1);
    const add = new Float64Array(n);
    const outUnit = new Array(n).fill("");
    for (const id of order) {
      outUnit[id] = unit[id] ?? "";
      if (o.usUnits) applyUsUnit(id, unit[id] || "", mul, add, outUnit);
    }
    return emitCsv(
      { order, name, outUnit, isEnum, sTime, sNum, sStr, mul, add, maxMs, pid: pidOf },
      { periodMs: o.periodMs, interpolate: o.interpolate, startOffsetSec: o.startOffsetSec }
    );
  }
  var V7_TAG_U8 = 2;
  var V7_TAG_U16 = 4;
  var V7_TAG_F32 = 9;
  var V7_TAG_F64 = 10;
  var V7_TAG_STR = 11;
  function convertV7(buf, o) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const name = new Array(NID).fill(null);
    const unit = new Array(NID).fill("");
    const isEnum = new Array(NID).fill(false);
    const tag = new Uint8Array(NID);
    const scale = new Float64Array(NID).fill(1);
    const offset = new Float64Array(NID);
    const order = [];
    let p = hplTableStartFromHeader(buf);
    if (p < 0) p = 40;
    for (; ; ) {
      if (p + 24 >= buf.length) break;
      const id = dv.getUint16(p, true);
      p += 5;
      const tg = buf[p];
      p += 1;
      if (tg !== V7_TAG_U8 && tg !== V7_TAG_U16 && tg !== V7_TAG_F32 && tg !== V7_TAG_F64 && tg !== V7_TAG_STR) {
        p -= 6;
        break;
      }
      const sc = dv.getFloat64(p, true);
      const off = dv.getFloat64(p + 8, true);
      p += 16;
      const nl = buf[p];
      p += 1;
      if (nl > 64 || p + nl > buf.length) {
        p -= 23;
        break;
      }
      let ascii = true;
      for (let j = p; j < p + nl; j++) {
        if (buf[j] < 32 || buf[j] > 126) {
          ascii = false;
          break;
        }
      }
      if (!ascii) {
        p -= 23;
        break;
      }
      const nm = asciiSlice(buf, p, p + nl);
      p += nl;
      const ul = buf[p];
      p += 1;
      if (ul >= 16) {
        p -= 24 + nl;
        break;
      }
      const un = ul ? utf8.decode(buf.subarray(p, p + ul)) : "";
      p += ul;
      if (name[id] == null) {
        name[id] = nm;
        unit[id] = un;
        tag[id] = tg;
        scale[id] = sc || 1;
        offset[id] = off;
        isEnum[id] = tg === V7_TAG_STR;
        order.push(id);
      }
    }
    if (order.length === 0) throw new Error("No channels found.");
    const tableEnd = p;
    const blocks = [];
    let start = tableEnd;
    for (let i = tableEnd; i + 4 <= buf.length; i++) {
      if (buf[i] === 115 && buf[i + 1] === 121 && buf[i + 2] === 110 && buf[i + 3] === 99) {
        blocks.push({ start, end: i });
        start = i + 9;
        i += 8;
      }
    }
    blocks.push({ start, end: buf.length });
    let maxId = 0;
    for (const oid of order) if (oid > maxId) maxId = oid;
    const v7Dry = (blk, w) => {
      let q = blk.start;
      let frames = 0;
      while (q + 4 <= blk.end) {
        const count = buf[q + 3];
        q += 4;
        if (count < 1 || count > order.length) break;
        for (let u = 0; u < count; u++) {
          if (q + w > blk.end) return false;
          let id;
          let unchanged;
          if (w === 1) {
            const b = buf[q];
            q += 1;
            unchanged = b >= 128;
            id = unchanged ? b - 128 : b;
          } else {
            const b = dv.getUint16(q, true);
            q += 2;
            unchanged = (b & 32768) !== 0;
            id = unchanged ? b & 32767 : b;
          }
          if (name[id] == null) return false;
          if (unchanged) continue;
          if (isEnum[id]) {
            if (q >= blk.end) return false;
            const sl = buf[q];
            q += 1 + sl;
          } else q += tag[id] === V7_TAG_U8 ? 1 : tag[id] === V7_TAG_U16 ? 2 : tag[id] === V7_TAG_F64 ? 8 : 4;
          if (q > blk.end) return false;
        }
        frames++;
      }
      return frames > 0;
    };
    let idWidth = maxId >= 128 ? 2 : 1;
    const firstBlk = blocks.find((bk) => bk.end - bk.start >= 8) || blocks[0];
    if (!v7Dry(firstBlk, idWidth)) {
      const alt = idWidth === 1 ? 2 : 1;
      if (v7Dry(firstBlk, alt)) idWidth = alt;
    }
    const sTime = new Array(NID);
    const sNum = new Array(NID);
    const sStr = new Array(NID);
    for (const id of order) {
      sTime[id] = [];
      if (isEnum[id]) sStr[id] = [];
      else sNum[id] = [];
    }
    const prevNum = new Float64Array(NID);
    const prevStr = new Array(NID);
    const hasPrev = new Array(NID).fill(false);
    let maxMs = 0;
    for (const blk of blocks) {
      let q = blk.start;
      while (q + 4 <= blk.end) {
        const ms = buf[q] | buf[q + 1] << 8 | buf[q + 2] << 16;
        const count = buf[q + 3];
        q += 4;
        if (count < 1 || count > order.length) break;
        let bad = false;
        for (let u = 0; u < count; u++) {
          if (q + idWidth > blk.end) {
            bad = true;
            break;
          }
          let id;
          let unchanged;
          if (idWidth === 1) {
            const b = buf[q];
            q += 1;
            unchanged = b >= 128;
            id = unchanged ? b - 128 : b;
          } else {
            const b = dv.getUint16(q, true);
            q += 2;
            unchanged = (b & 32768) !== 0;
            id = unchanged ? b & 32767 : b;
          }
          if (name[id] == null) {
            bad = true;
            break;
          }
          if (unchanged) {
            if (!hasPrev[id]) continue;
            sTime[id].push(ms);
            if (isEnum[id]) sStr[id].push(prevStr[id]);
            else sNum[id].push(prevNum[id]);
            if (ms > maxMs) maxMs = ms;
            continue;
          }
          if (isEnum[id]) {
            if (q >= blk.end) {
              bad = true;
              break;
            }
            const sl = buf[q];
            q += 1;
            if (q + sl > blk.end) {
              bad = true;
              break;
            }
            const sv = asciiSlice(buf, q, q + sl);
            q += sl;
            prevStr[id] = sv;
            hasPrev[id] = true;
            sTime[id].push(ms);
            sStr[id].push(sv);
          } else {
            let v;
            if (tag[id] === V7_TAG_U8) {
              if (q + 1 > blk.end) {
                bad = true;
                break;
              }
              v = buf[q] / scale[id] + offset[id];
              q += 1;
            } else if (tag[id] === V7_TAG_U16) {
              if (q + 2 > blk.end) {
                bad = true;
                break;
              }
              v = dv.getUint16(q, true) / scale[id] + offset[id];
              q += 2;
            } else if (tag[id] === V7_TAG_F64) {
              if (q + 8 > blk.end) {
                bad = true;
                break;
              }
              v = dv.getFloat64(q, true);
              q += 8;
            } else {
              if (q + 4 > blk.end) {
                bad = true;
                break;
              }
              v = dv.getFloat32(q, true);
              q += 4;
            }
            prevNum[id] = v;
            hasPrev[id] = true;
            sTime[id].push(ms);
            sNum[id].push(v);
          }
          if (ms > maxMs) maxMs = ms;
        }
        if (bad) break;
      }
    }
    let minMs = Infinity;
    for (const id of order) {
      const t = sTime[id];
      if (t.length && t[0] < minMs) minMs = t[0];
    }
    if (!isFinite(minMs)) throw new Error("No data rows found in this file.");
    for (const id of order) {
      const t = sTime[id];
      for (let i = 0; i < t.length; i++) t[i] = t[i] - minMs;
    }
    maxMs -= minMs;
    const mul = new Float64Array(NID).fill(1);
    const add = new Float64Array(NID);
    const outUnit = new Array(NID).fill("");
    for (const id of order) {
      outUnit[id] = unit[id] ?? "";
      if (o.usUnits) applyUsUnit(id, unit[id] || "", mul, add, outUnit);
    }
    return emitCsv(
      { order, name, outUnit, isEnum, sTime, sNum, sStr, mul, add, maxMs },
      { periodMs: o.periodMs, interpolate: o.interpolate, startOffsetSec: o.startOffsetSec }
    );
  }
  function emitCsv(d, o) {
    const { order, name, outUnit, isEnum, sTime, sNum, sStr, mul, add, maxMs } = d;
    const csvEsc = (s) => {
      if (s == null) return "";
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const fmtNum = (v) => {
      if (!isFinite(v)) return "";
      let s = v.toFixed(10);
      if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
      return s;
    };
    const fmtOffset = (sec) => {
      let s = sec.toFixed(3);
      if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
      return s;
    };
    const firstMs = Math.round(o.startOffsetSec * 1e3);
    const rows = Math.floor((maxMs - firstMs) / o.periodMs) + 1;
    if (!(rows >= 1) || rows > 5e7) throw new Error(`This log decodes to an implausible span (${Math.round((maxMs - firstMs) / 1e3)} s); the file is probably corrupt.`);
    const cur = new Int32Array(NID);
    const lines = [];
    const pid = d.pid;
    if (pid && order.some((id) => (pid[id] ?? 0) > 0)) {
      lines.push("0," + order.map((id) => (pid[id] ?? 0) > 0 ? String(pid[id]) : "").join(","));
    }
    lines.push("Offset," + order.map((id) => csvEsc(name[id])).join(","));
    lines.push("s," + order.map((id) => csvEsc(outUnit[id])).join(","));
    for (let r = 0; r < rows; r++) {
      const tms = firstMs + Math.floor(r * o.periodMs);
      const cells = [fmtOffset(tms / 1e3)];
      for (const id of order) {
        const ts = sTime[id];
        const m = ts.length;
        if (m === 0) {
          cells.push("");
          continue;
        }
        let ci = cur[id];
        while (ci + 1 < m && ts[ci + 1] <= tms) ci++;
        cur[id] = ci;
        if (isEnum[id]) {
          cells.push(csvEsc(sStr[id][ci]));
        } else {
          let v = sNum[id][ci];
          if (o.interpolate && ci + 1 < m && ts[ci] <= tms && ts[ci + 1] > tms) {
            const t0 = ts[ci];
            const t1 = ts[ci + 1];
            if (t1 !== t0) {
              const v1 = sNum[id][ci + 1];
              v = v + (v1 - v) * ((tms - t0) / (t1 - t0));
            }
          }
          cells.push(fmtNum(v * mul[id] + add[id]));
        }
      }
      lines.push(cells.join(","));
    }
    return lines.join("\n") + "\n";
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/motec/ld-to-csv.ts
  function convertLdToCsv(input, opts) {
    const o = opts || {};
    const outRate = o.outRateHz != null ? o.outRateHz : 200;
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (buf.length < 80 || buf[0] !== 64) throw new Error("Not a MoTeC .ld file.");
    const str = (off, n) => {
      let s = "";
      for (let i = off; i < off + n && i < buf.length; i++) {
        if (buf[i] === 0) break;
        s += String.fromCharCode(buf[i]);
      }
      return s.trim();
    };
    const device = str(76, 8);
    const date = str(94, 16);
    const time = str(126, 16);
    const driver = str(222, 32);
    const metaPtr = dv.getUint32(8, true);
    const chans = [];
    let p = metaPtr;
    let guard = 0;
    while (p !== 0 && p + 124 <= buf.length && guard++ < 2e3) {
      const next = dv.getUint32(p + 4, true);
      const ch = {
        dataAddr: dv.getUint32(p + 8, true),
        count: dv.getUint32(p + 12, true),
        dtA: dv.getUint16(p + 18, true),
        size: dv.getUint16(p + 20, true),
        freq: dv.getUint16(p + 22, true),
        name: str(p + 32, 32).replace(/\./g, " "),
        unit: str(p + 64, 12),
        isFloat: false,
        vals: new Float64Array(0),
        firstValid: 0
      };
      if (ch.size > 0 && ch.freq > 0 && ch.count > 0 && ch.name.length > 0) chans.push(ch);
      if (next === 0) break;
      p = next;
    }
    if (chans.length === 0) throw new Error("No channels found.");
    for (const ch of chans) {
      ch.isFloat = ch.dtA === 7;
      ch.vals = new Float64Array(ch.count);
      let good = ch.count;
      for (let i = 0; i < ch.count; i++) {
        const off = ch.dataAddr + i * ch.size;
        if (off + ch.size > buf.length) {
          good = i;
          break;
        }
        if (ch.dtA === 7 && ch.size === 4) ch.vals[i] = dv.getFloat32(off, true);
        else if (ch.size === 4) ch.vals[i] = dv.getInt32(off, true);
        else if (ch.size === 2) ch.vals[i] = dv.getInt16(off, true);
        else ch.vals[i] = buf[off];
      }
      ch.count = good;
      ch.firstValid = 0;
      if (ch.isFloat) {
        while (ch.firstValid < ch.count && ch.vals[ch.firstValid] === 0) ch.firstValid++;
      }
    }
    let maxT = 0;
    for (const ch of chans) {
      const tt = (ch.count - 1) / ch.freq;
      if (tt > maxT) maxT = tt;
    }
    const rows = Math.round(maxT * outRate) + 1;
    const dt = 1 / outRate;
    const q = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    const fmt2 = (v) => {
      let s = v.toFixed(3);
      if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
      return s;
    };
    const out = [];
    out.push(q("Format") + "," + q("MoTeC CSV File"));
    out.push(q("Device") + "," + q(device));
    out.push(q("Driver") + "," + q(driver));
    out.push(q("Log Date") + "," + q(date));
    out.push(q("Log Time") + "," + q(time));
    out.push(q("Sample Rate") + "," + q(outRate.toFixed(3)) + "," + q("Hz"));
    out.push(q("Duration") + "," + q(maxT.toFixed(3)) + "," + q("s"));
    out.push("");
    out.push("");
    out.push(q("Time") + "," + chans.map((c) => q(c.name)).join(","));
    out.push(q("s") + "," + chans.map((c) => q(c.unit)).join(","));
    out.push("");
    const cells = new Array(chans.length + 1);
    for (let r = 0; r < rows; r++) {
      const t = r * dt;
      cells[0] = fmt2(t);
      for (let c = 0; c < chans.length; c++) {
        const ch = chans[c];
        const s = t * ch.freq;
        const i0 = Math.floor(s + 1e-9);
        if (i0 < ch.firstValid || i0 >= ch.count) {
          cells[c + 1] = "";
          continue;
        }
        let v;
        if (ch.isFloat && i0 + 1 < ch.count) {
          const frac = s - i0;
          v = ch.vals[i0] * (1 - frac) + ch.vals[i0 + 1] * frac;
        } else v = ch.vals[i0];
        cells[c + 1] = ch.isFloat ? fmt2(v) : String(Math.round(v));
      }
      out.push(cells.join(","));
    }
    return out.join("\n") + "\n";
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/holley/holley-channels.ts
  var HOLLEY_DICTS = [
    {
      product: "holley-v6-516",
      channelCount: 516,
      names: ["Point Number", "RTC", "RPM", "Inj PW", "Duty Cycle", "CL Comp", "Target AFR", "AFR Left", "AFR Right", "AFR Average", "Air Temp Enr", "Coolant Enr", "Coolant AFR Offset", "Afterstart Enr", "Current Learn", "CL Status", "Learn Status", "Fuel Economy", "Fuel Flow", "MAP RoC", "TPS RoC", "Tuning Change", "Estimated VE", "Fuel Table 1 %", "Fuel Table 2 %", "Fuel Table 3 %", "Ignition Timing", "Knock Retard", "Knock Level", "Spark Pad2", "IAC Position", "Target Idle Speed", "MAP", "TPS", "MAT", "CTS", "Baro", "Battery", "Oil Pressure", "Fuel Pressure", "Pedal Position", "Main Rev Limit", "Rev Limit #1", "Rev Limit #2", "AC Kick", "Timing Retard #1", "Timing Retard #2", "Timing Retard #3", "Fan #1", "Fan #2", "#2 Fuel Pump", "AC Shutdown", "TCC Lockup", "Sensor Warning", "Sensor Caution", "Base Fuel lb/hr", "Base Fuel VE", "Base Timing", "Base Target AFR", "Base Ign Dwell", "Vol Comp Ign Dwell", "Inj End Angle", "ECU Log Trigger", "Timing vs Air", "Timing vs Cool", "Status 1", "Status 2", "Status 3", "Status 4", "Status 5", "Status 6", "Status 7", "Status 8", "Inj Driver #1 PPH", "Inj Driver #2 PPH", "Inj Driver #3 PPH", "Inj Driver #4 PPH", "Inj Driver #5 PPH", "Inj Driver #6 PPH", "Inj Driver #7 PPH", "Inj Driver #8 PPH", "Inj Driver #9 PPH", "Inj Driver #10 PPH", "Inj Driver #11 PPH", "Inj Driver #12 PPH", "Inj Driver #13 PPH", "Inj Driver #14 PPH", "Inj Driver #15 PPH", "Inj Driver #16 PPH", "Inj Driver #17 PPH", "Inj Driver #18 PPH", "Inj Driver #19 PPH", "Inj Driver #20 PPH", "Inj Driver #21 PPH", "Inj Driver #22 PPH", "Inj Driver #23 PPH", "Inj Driver #24 PPH", "Inj Driver #25 PPH", "Inj Driver #26 PPH", "Inj Driver #27 PPH", "Inj Driver #28 PPH", "Inj Driver #1 PW", "Inj Driver #2 PW", "Inj Driver #3 PW", "Inj Driver #4 PW", "Inj Driver #5 PW", "Inj Driver #6 PW", "Inj Driver #7 PW", "Inj Driver #8 PW", "Inj Driver #9 PW", "Inj Driver #10 PW", "Inj Driver #11 PW", "Inj Driver #12 PW", "Inj Driver #13 PW", "Inj Driver #14 PW", "Inj Driver #15 PW", "Inj Driver #16 PW", "Inj Driver #17 PW", "Inj Driver #18 PW", "Inj Driver #19 PW", "Inj Driver #20 PW", "Inj Driver #21 PW", "Inj Driver #22 PW", "Inj Driver #23 PW", "Inj Driver #24 PW", "Inj Driver #25 PW", "Inj Driver #26 PW", "Inj Driver #27 PW", "Inj Driver #28 PW", "Cyl #1 Fuel Cor", "Cyl #2 Fuel Cor", "Cyl #3 Fuel Cor", "Cyl #4 Fuel Cor", "Cyl #5 Fuel Cor", "Cyl #6 Fuel Cor", "Cyl #7 Fuel Cor", "Cyl #8 Fuel Cor", "Cyl #9 Fuel Cor", "Cyl #10 Fuel Cor", "Cyl #11 Fuel Cor", "Cyl #12 Fuel Cor", "Cyl #13 Fuel Cor", "Cyl #14 Fuel Cor", "Cyl #15 Fuel Cor", "Cyl #16 Fuel Cor", "Cyl #1 Timing Cor", "Cyl #2 Timing Cor", "Cyl #3 Timing Cor", "Cyl #4 Timing Cor", "Cyl #5 Timing Cor", "Cyl #6 Timing Cor", "Cyl #7 Timing Cor", "Cyl #8 Timing Cor", "Cyl #9 Timing Cor", "Cyl #10 Timing Cor", "Cyl #11 Timing Cor", "Cyl #12 Timing Cor", "Cyl #13 Timing Cor", "Cyl #14 Timing Cor", "Cyl #15 Timing Cor", "Cyl #16 Timing Cor", "DI Target FP", "Boost PSIG", "Staging Input #1", "Staging Input #2", "Staging Output", "System Pad2", "System Pad3", "System Pad4", "Boost Gear", "Boost Stage", "Boost", "Boost Speed", "Boost Time", "Target Dome", "Trans Brake", "Boost Scramble +", "Boost Scramble -", "Manual Boost Build", "Manual Boost Reset", "Boost Build", "Boost Solenoid Duty", "Boost Safety", "Boost Master Enbl", "Boost Man Shift Inp", "Boost Man Stage Inp", "Boost Fill Sol DC", "Boost Vent Sol DC", "W/M Injection", "W/M Manual Enable", "W/M Low Fluid", "W/M Pump", "W/M Sol 1 Flow", "W/M Sol 2 Flow", "W/M Flow Total", "W/M Sol 1 DC", "W/M Sol 2 DC", "W/M Pad1", "W/M Pad2", "N2O Stage 1", "N2O Stage 2", "N2O Stage 3", "N2O Stage 4", "N2O Stage 5", "N2O Stage 6", "N2O Stage 7", "N2O Stage 8", "GPO 1", "GPO 2", "GPO 3", "GPO 4", "GPO 5", "GPO 6", "GPO 7", "GPO 8", "N2O Enabled", "N2O Input #1", "N2O Input #2", "N2O Input #3", "N2O Input #4", "N2O Input #5", "N2O Input #6", "N2O Input #7", "N2O Input #8", "N2O Purge", "N2O Lean Cutoff", "N2O Rich Cutoff", "N2O RPM Cutoff", "N2O MAP Cutoff", "N2O Purge Output", "N2O Dry Fuel #1", "N2O Dry Fuel #2", "N2O Dry Fuel #3", "N2O Dry Fuel #4", "N2O Dry Fuel #5", "N2O Dry Fuel #6", "N2O Dry Fuel #7", "N2O Dry Fuel #8", "N2O Tmg Mod #1", "N2O Tmg Mod #2", "N2O Tmg Mod #3", "N2O Tmg Mod #4", "N2O Tmg Mod #5", "N2O Tmg Mod #6", "N2O Tmg Mod #7", "N2O Tmg Mod #8", "N2O Timer #1", "N2O Timer #2", "N2O Timer #3", "N2O Timer #4", "N2O Timer #5", "N2O Timer #6", "N2O Timer #7", "N2O Timer #8", "N20 Pad1", "N20 Pad2", "N20 Pad3", "N20 Pad4", "Gear", "Speed", "Line Pressure", "Input Shaft Speed", "Accum Pressure", "TCC Duty Cycle", "Line Temp", "Torque Time", "Trans Man US Input", "Trans Man DS Input", "Trans Auto/Man In", "Trans Range Pos", "Race Trans Launch", "Shift Single Out", "Shift Output 1-2", "Shift Output 2-3", "Shift Output 3-4", "Shift Output 4-5", "Shift Output 5-6", "Shift Output 6-7", "Shift Output 7-8", "Shift Over-Ride", "Shift Mster Enable", "Shift Ignition Cut", "Shift Timing Mod", "Shift Timer", "Conv Lockup #1", "Conv Lockup #2", "Conv Lockup #3", "Conv Lockup #4", "Conv Lock Disable", "Spool Assist Out 1", "Spool Assist Out 2", "External Dump", "Internal Dump", "Dump #3", "Dump #4", "Trans Dump Disable", "Trans Pad 2", "TB TPS #1", "TB TPS #2", "Pedal TPS #1", "Pedal TPS #2", "TB2 TPS #1", "TB2 TPS #2", "TB Position", "TB2 Position", "Brake Pedal", "DBW Pad2", "TC Smartdrop", "TC Timing Retard", "TC N2O Decrease", "TC Boost Decrease", "TC DBW Decrease", "DS Timing Offset", "CS Timing Offset", "DS Rev Limit", "CS Rev Limit", "TC Time", "TC Launch Input", "Diag #1", "Diag #2", "Diag #3", "Diag #4", "Diag #5", "Diag #6", "Diag #7", "Diag #8", "Diag #9", "Diag #10", "Diag #11", "Diag #12", "Diag #13", "Diag #14", "Diag #15", "Diag #16", "Diag #17", "Diag #18", "Diag #19", "Diag #20", "AT Launch Input", "AT Shift Input", "AT Manual Reset", "AT Gear", "Launch Knob", "AT 1D #2", "AT 1D #3", "AT 1D #4", "AT 1D #5", "AT 1D #6", "AT 1D #7", "AT 1D #8", "Oil PSI Safety", "3 step", "wheelie2d", "Spool timing", "spool fuel", "Timing Retard", "Launch Offset Kn", "AT 2D #8", "AT 1DGear #1", "AT 1DGear #2", "AT 1DGear #3", "AT 1DGear #4", "AT 1DGear #5", "AT 1DGear #6", "AT 1DGear #7", "AT 1DGear #8", "AT 2DGear #1", "AT 2DGear #2", "AT 2DGear #3", "AT 2DGear #4", "AT 2DGear #5", "AT 2DGear #6", "AT 2DGear #7", "AT 2DGear #8", "DRIVESHAFT RPM", "IAT PRE COOLER", "CC PRESSURE", "BRAKE INPUT", "LOGGING", "Dome Pressure", "KeyOn", "Convert Pressure", "Shock Travel (RR", "Shock Travel (LR", "Shock Travel (RF", "Shock Travel (LF", "RADIATOR TEMP", "TRANS TEMP", "Coolant Pressure", "EGT#1", "EGT#2", "EGT#3", "EGT#4", "EGT#5", "EGT#6", "EGT#7", "EGT#8", "Chassis Angle", "Pitch Velocity", "X Accel Raw", "X Accel Correcte", "ACASX Temp", "12 Pos AEM(L)", "12 Pos AEM(R)", "Turbo Shaft Spee", "OIL TEMP", "Backpressure", "Brake Pressure", "Input #35", "Input #36", "Input #37", "Input #38", "Input #39", "Input #40", "Input #41", "Input #42", "Input #43", "Input #44", "Input #45", "Input #46", "Input #47", "Input #48", "Input #49", "Input #50", "Input #51", "Input #52", "Input #53", "Input #54", "Input #55", "Input #56", "Input #57", "Input #58", "Input #59", "Input #60", "Input #61", "Input #62", "Input #63", "Input #64", "Input #65", "Input #66", "Input #67", "Input #68", "Input #69", "Input #70", "Input #71", "Input #72", "Input #73", "Input #74", "DiffFuelPressure", "Converter Slip", "Dome Error", "EBP", "Lambda", "IC Boost Drop", "SHIFT LIGHT", "Oil Pump Power", "Shifter", "Safety Out", "Bst Cntrl Pwr", "Egate PWM-", "Egate Shutdown", "ExternalDump", "Internal Dump", "Rear Linelock", "Output #11", "Output #12", "Output #13", "Output #14", "Output #15", "Output #16", "Output #17", "Output #18", "Output #19", "ACAS Launch Zero", "Output #21", "Output #22", "Output #23", "Output #24", "Output #25", "Output #26", "Output #27", "Output #28", "Output #29", "Output #30", "Output #31", "Output #32", "Output #33", "Output #34", "Output #35", "Output #36", "Output #37", "Output #38", "Output #39", "Output #40", "Output #41", "Output #42", "Output #43", "Output #44", "Output #45", "Output #46", "Output #47", "Output #48", "Output #49", "Output #50", "Output #51", "Output #52", "Output #53", "Output #54", "Output #55", "Output #56", "Output #57", "Output #58", "Output #59", "Output #60", "Output #61", "Output #62"],
      units: ["", "sec", "RPM", "msec", "%", "%", "A/F", "A/F", "A/F", "A/F", "%", "%", "A/F", "%", "%", "", "", "mpg", "lb/hr", "kpa/sec x10", "%/sec", "", "%", "%", "%", "%", "\uFFFD", "\uFFFD", "%", "", "%", "RPM", "kPa", "%", "\uFFFDF", "\uFFFDF", "kPa", "Volts", "psi", "psi", "%", "", "", "", "", "\uFFFD", "\uFFFD", "\uFFFD", "", "", "", "", "", "", "", "lb/hr", "%", "\uFFFD", "A/F", "msec", "msec", "\uFFFD", "sec", "%\uFFFD", "%\uFFFD", "", "", "", "", "", "", "", "", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "msec", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "%", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "bar", "psig", "", "", "%", "", "", "", "", "", "psig", "MPH", "sec", "psig", "", "", "", "", "", "", "%", "", "", "", "", "%", "%", "%", "", "", "", "lb/hr", "lb/hr", "lb/hr", "%", "%", "", "", "%", "%", "%", "%", "%", "%", "%", "%", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "%", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "\uFFFD", "sec", "sec", "sec", "sec", "sec", "sec", "sec", "sec", "", "", "", "", "", "MPH", "%", "RPM", "%", "%", "\uFFFDF", "sec", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "\uFFFD", "sec", "%", "%", "%", "%", "", "", "", "%", "%", "%", "%", "", "", "Volts", "Volts", "Volts", "Volts", "Volts", "Volts", "%", "%", "", "", "", "\uFFFD", "%", "PSI", "%", "\uFFFD", "\uFFFD", "", "", "sec", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "RPM", "%", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "RPM", "\uFFFD", "\uFFFD", "A/F", "\uFFFD", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "lb/hr", "rpm", "\uFFFDF", "kPa", "", "", "psi", "\uFFFDF", "psi", "in", "in", "in", "in", "\uFFFDF", "\uFFFDF", "psi", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFDF", "\uFFFD", "d/s", "G", "G", "\uFFFD", "#", "#", "RPM", "\uFFFDF", "psi", "psi", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "%", "", "", "", "", "%", "", "%", "%", "", "", "", "", "", "", "", "", "", "", "%", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]
    }
  ];
  function holleyDictForChannels(nCh) {
    return HOLLEY_DICTS.find((d) => d.channelCount === nCh + 2);
  }

  // ../../../../websites/Alldatalogs/packages/datalog-core/src/holley/dl-to-csv.ts
  var CLOCK_LO = 1e8;
  var CLOCK_HI = 4293e6;
  var GAP_MAX = 1e5;
  function isHolleyDl(buf) {
    return buf.length > 16 && buf[0] === 31 && buf[1] === 244 && buf[2] === 133 && buf[3] === 0;
  }
  function detectHolleyLayout(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const L = buf.length;
    const u32 = (o) => dv.getUint32(o, true);
    const clock = (v) => v >= CLOCK_LO && v <= CLOCK_HI;
    const sustains = (A2, rB2, need) => {
      let prev = u32(A2);
      for (let k = 1; k <= need; k++) {
        const o = A2 + k * rB2;
        if (o + 4 > L) return false;
        const v = u32(o);
        const d = v - prev;
        if (!(d >= 1 && d <= GAP_MAX)) return false;
        prev = v;
      }
      return true;
    };
    let A = -1;
    let rB = 0;
    outer: for (let a = 8; a + 4e4 < L; a += 4) {
      if (!clock(u32(a))) continue;
      for (let cand = 16; cand <= 4e4; cand += 8) {
        if (clock(u32(a + cand)) && sustains(a, cand, 40)) {
          A = a;
          rB = cand;
          break outer;
        }
      }
    }
    if (A < 0) throw new Error("Not a recognizable Holley .dl data log (no sample-clock data section found).");
    let ds = A;
    while (ds - rB >= 0) {
      const d = u32(ds) - u32(ds - rB);
      if (!(d >= 1 && d <= GAP_MAX) || !clock(u32(ds - rB))) break;
      ds -= rB;
    }
    return { rowBytes: rB, nCh: (rB - 8) / 8, dataStart: ds, nRows: Math.floor((L - ds) / rB) };
  }
  function fmt(v) {
    if (!isFinite(v)) return "";
    if (v === 0) return "0";
    const a = Math.abs(v);
    if (a >= 1e-4 && a < 1e7) {
      let s = v.toFixed(6);
      if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
      return s;
    }
    return v.toPrecision(7);
  }
  function readCStr(buf, o, max = 30) {
    let s = "";
    for (let i = o; i < o + max && i < buf.length; i++) {
      const b = buf[i];
      if (b === void 0 || b === 0 || b < 32 || b > 126) break;
      s += String.fromCharCode(b);
    }
    return s;
  }
  function readHolleyAnalogLabels(buf, headerEnd) {
    const REC = 56;
    const limit = Math.min(headerEnd, buf.length);
    const isRec = (rs) => rs + REC <= limit && readCStr(buf, rs + 16).length >= 2 && /^%.*f/.test(readCStr(buf, rs + 62));
    let best = { start: -1, len: 0 };
    for (let s = 8e3; s < limit - REC; s++) {
      if (!isRec(s)) continue;
      let n = 0;
      let o = s;
      while (isRec(o)) {
        n++;
        o += REC;
      }
      if (n > best.len) best = { start: s, len: n };
      s = o - 1;
    }
    const out = [];
    for (let k = 0; k < best.len; k++) {
      const o = best.start + k * REC;
      out.push({ name: readCStr(buf, o + 16), unit: readCStr(buf, o + 56) });
    }
    return out;
  }
  function convertHolleyDlToCsv(input) {
    const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isHolleyDl(buf)) throw new Error("Not a Holley .dl file (missing 1F F4 85 00 signature).");
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const { rowBytes, nCh, dataStart, nRows } = detectHolleyLayout(buf);
    const dict = holleyDictForChannels(nCh);
    const names = dict ? dict.names.slice(2) : Array.from({ length: nCh }, (_, i) => `Channel ${i + 1}`);
    const units = dict ? dict.units.slice(2) : names.map(() => "");
    const chNames = names.length === nCh ? names : Array.from({ length: nCh }, (_, i) => `Channel ${i + 1}`);
    const chUnits = units.length === nCh ? units : chNames.map(() => "");
    if (nCh === 514) {
      const labels = readHolleyAnalogLabels(buf, dataStart);
      const INPUT_START = 372;
      const INPUT_COUNT = 74;
      for (let k = 0; k < INPUT_COUNT && INPUT_START + k < nCh; k++) {
        const idx = INPUT_START + k;
        const lbl = labels[k];
        if (lbl && lbl.name) {
          chNames[idx] = lbl.name;
          chUnits[idx] = lbl.unit;
        } else {
          chNames[idx] = `Input #${k + 1}`;
          chUnits[idx] = "";
        }
      }
    }
    const t0 = dv.getUint32(dataStart, true);
    const parts = [];
    parts.push("Offset," + chNames.join(","));
    parts.push("sec," + chUnits.join(","));
    for (let r = 0; r < nRows; r++) {
      const base = dataStart + r * rowBytes;
      const time = (dv.getUint32(base, true) - t0) / 1e3;
      const cells = new Array(nCh + 1);
      cells[0] = fmt(time);
      for (let k = 0; k < nCh; k++) cells[k + 1] = fmt(dv.getFloat32(base + 8 + k * 8, true));
      parts.push(cells.join(","));
    }
    return parts.join("\n");
  }
  return __toCommonJS(entry_exports);
})();
