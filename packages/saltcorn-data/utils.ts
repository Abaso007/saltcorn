/**
 * @category saltcorn-data
 * @module utils
 */
import { serialize, deserialize } from "v8";
import { createReadStream, readdirSync } from "fs";
import { GenObj, instanceOfType } from "@saltcorn/types/common_types";
import { Row, Where, prefixFieldsInWhere } from "@saltcorn/db-common/internal";
import type {
  ConnectedObjects,
  Req,
  ResultType,
  StepResType,
} from "@saltcorn/types/base_types";
import crypto from "crypto";
import { join, dirname } from "path";
import type Field from "./models/field"; // only type, shouldn't cause require loop
import type User from "./models/user"; // only type, shouldn't cause require loop
import { existsSync } from "fs-extra";
import _ from "underscore";
const unidecode = require("unidecode");
import { HttpsProxyAgent } from "https-proxy-agent";
// import { ResultType, StepResType } from "types";'

const getFetchProxyOptions = () => {
  if (process.env["HTTPS_PROXY"]) {
    const agent = new HttpsProxyAgent(process.env["HTTPS_PROXY"]);
    return { agent };
  } else return {};
};

// for database cols
const validSqlId = (s: string): string =>
  unidecode(s)
    .replace(/[ -]/g, "_")
    .replace(/[&\/\\#,+()$~%.'":*?<>{}`]/g, "")
    .toLowerCase()
    .trim();

const removeEmptyStrings = (obj: GenObj) => {
  var o: GenObj = {};
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== "" && v !== null) o[k] = v;
  });
  return o;
};
const removeEmptyStringsKeepNull = (obj: GenObj) => {
  var o: GenObj = {};
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== "") o[k] = v;
  });
  return o;
};
const removeDefaultColor = (obj: GenObj) => {
  var o: GenObj = {};
  Object.entries(obj).forEach(([k, v]) => {
    if (v !== "#000000") o[k] = v;
  });
  return o;
};
const isEmpty = (o: GenObj) => Object.keys(o).length === 0;

const asyncMap = async (xs: any[], asyncF: Function) => {
  var res = [];
  var ix = 0;
  for (const x of xs) {
    res.push(await asyncF(x, ix));
    ix += 1;
  }
  return res;
};

const numberToBool = (b: boolean): number | boolean =>
  typeof b === "number" ? b > 0 : b;

const stringToJSON = (v: string | any): any => {
  try {
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch (e: any) {
    throw new Error(`stringToJSON(${JSON.stringify(v)}): ${e.message}`);
  }
};
const apply = (f: Function | any, ...x: any[]) =>
  typeof f === "function" ? f(...x) : f;

const applyAsync = async (f: Function | any, ...x: any[]) => {
  if (typeof f === "function") return await f(...x);
  else return f;
};

const structuredClone = (obj: any) => {
  if (isNode()) return deserialize(serialize(obj));
  else return JSON.parse(JSON.stringify(obj));
};

class InvalidAdminAction extends Error {
  headline: string;
  httpCode: number;
  severity: number;
  constructor(message: string) {
    super(message);
    this.headline = "Invalid administrative action";
    this.httpCode = 406;
    this.severity = 5; //syslog equivalent severity level
  }
}

class InvalidConfiguration extends Error {
  headline: string;
  httpCode: number;
  severity: number;
  constructor(message: string) {
    super(message);
    this.httpCode = 500;
    this.headline = "A configuration error occurred";
    this.severity = 3;
  }
}

class NotAuthorized extends Error {
  headline: string;
  httpCode: number;
  severity: number;
  constructor(message: string) {
    super(message);
    this.httpCode = 401;
    this.headline = "Not Authorized";
    this.severity = 5; //syslog equivalent severity level
  }
}
type VType = {
  or?: any[];
  in?: any[];
  ilike?: string;
  json?: GenObj;
  [key: string]: any;
};
const sat1 = (obj: GenObj, [k, v]: [k: string, v: VType]): boolean =>
  v && v.or
    ? v.or.some((v1) => sat1(obj, [k, v1]))
    : v && v.in
      ? v.in.includes(obj[k])
      : v && v.ilike
        ? typeof obj[k] === "string" &&
          obj[k].toLowerCase().includes(v.ilike.toLowerCase())
        : v && v.json
          ? Object.entries(v.json).every((kv: [k: string, v: any]) =>
              sat1(obj[k], kv)
            )
          : obj[k] === v;

const satisfies = (where: Where) => (obj: any) =>
  Object.entries(where || {}).every((kv) => sat1(obj, kv));

// https://gist.github.com/jadaradix/fd1ef195af87f6890448
const getLines = (filename: string, lineCount: number): Promise<string> =>
  new Promise((resolve) => {
    let stream = createReadStream(filename, {
      flags: "r",
      encoding: "utf-8",
      fd: undefined,
      mode: 438, // 0666 in Octal
      // @ts-ignore
      bufferSize: 64 * 1024,
    });

    let data = "";
    let lines: string[] = [];
    stream.on("data", function (moreData) {
      data += moreData;
      lines = data.split("\n");
      // probably that last line is "corrupt" - halfway read - why > not >=
      if (lines.length > lineCount + 1) {
        stream.destroy();
        lines = lines.slice(0, lineCount); // junk as above
        resolve(lines.join("\n"));
      }
    });

    /*stream.on("error", function () {
    callback("Error");
  });*/

    stream.on("end", function () {
      resolve(lines.join("\n"));
    });
  });

const removeAllWhiteSpace = (s: string) =>
  s.replace(/\s+/g, "").split("&nbsp;").join("").split("<hr>").join("");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const mergeIntoWhere = (where: Where, newWhere: GenObj) => {
  Object.entries(newWhere).forEach(([k, v]) => {
    if (k == "or") {
      if (where.and) where.and.push({ or: v });
      else if (where.or) {
        where.and = [{ or: where.or }, { or: v }];
        delete where.or;
      } else where.or = v;
      return;
    }
    if (typeof where[k] === "undefined") where[k] = v;
    else where[k] = [where[k], v];
  });
  return where;
};

const mergeActionResults = (result: ResultType, stepres: StepResType) => {
  Object.keys(stepres || {}).forEach((k) => {
    if (k === "set_fields") {
      if (!result.set_fields) result.set_fields = {};
      Object.keys(stepres.set_fields || {}).forEach((f) => {
        (result.set_fields ??= {})[f] = (stepres.set_fields ??= {})[f];
      });
    } else if (
      !["notify", "notify_success", "error", "eval_js", "download"].includes(k)
    )
      result[k] = stepres[k];
    else if (Array.isArray(result[k])) result[k].push(stepres[k]);
    else if (typeof result[k] !== "undefined")
      result[k] = [result[k], stepres[k]];
    else result[k] = stepres[k];
  });
};

/**
 * @function
 * @param {Date} date
 * @param {string} [hours = 24]
 * @returns {boolean}
 */
const isStale = (date: Date | string, hours: number = 24): boolean => {
  const oneday = 60 * 60 * hours * 1000;
  let now = new Date();
  return new Date(date).valueOf() < now.valueOf() - oneday;
};

declare const window: Window & typeof globalThis;

/**
 * returns true if it's a node enviroment,
 * false if it's webpack bundled code
 */
const isNode = (): boolean => {
  return typeof window === "undefined";
};

/**
 * returns true if it's node and not a 'saltcorn mobile requeset'
 * a saltcorn mobile request is identified by the smr header
 * @param req express request
 */
const isWeb = (req: Req): boolean => {
  return isNode() && !req?.smr;
};

/**
 * returns the session id
 * @param req express request
 */

const getSessionId = (req: Req): string => {
  return req?.sessionID || req?.cookies?.["express:sess"];
};

/**
 * @returns true if the mobile offline mode is active
 */
const isOfflineMode = (): boolean => {
  const state = require("./db/state").getState();
  return !isNode() && state.mobileConfig?.isOfflineMode;
};

/**
 * merges the arrays from 'lhs' and 'rhs'
 * @param lhs
 * @param rhs
 * @returns instance with merged arrays
 */
const mergeConnectedObjects = (
  lhs: ConnectedObjects,
  rhs: ConnectedObjects
): ConnectedObjects => {
  const merge = (arrOne: any, arrTwo: any) => [
    ...(arrOne ? arrOne : []),
    ...(arrTwo ? arrTwo : []),
  ];
  return {
    linkedViews: merge(lhs.linkedViews, rhs.linkedViews),
    embeddedViews: merge(lhs.embeddedViews, rhs.embeddedViews),
    linkedPages: merge(lhs.linkedPages, rhs.linkedPages),
    tables: merge(lhs.tables, rhs.tables),
  };
};

const objectToQueryString = (o: Object): string => {
  const f = ([k, v]: any): string =>
    v?.or
      ? v.or.map((val: any) => f([k, val])).join("&")
      : Array.isArray(v)
        ? v.map((val) => f([k, val])).join("&")
        : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;

  return Object.entries(o || {})
    .map(f)
    .join("&");
};

const urlStringToObject = (url: string): any => {
  if (!url) return {};
  const noHash = url.split("#")[0];
  const qs = noHash.split("?")[1];
  if (!qs) return {};
  const parsedQuery = new URLSearchParams(qs);
  const result: any = {};
  if (parsedQuery) {
    for (let [key, value] of parsedQuery) {
      result[key] = value;
    }
  }
  return result;
};

/**
 * create a hash from a state object so that views with identical type can be uniquely identified
 * "_page", "_pagesize", "_sortby", "_sortdesc" are ecxluded
 * @param state
 * @param viewname
 * @returns
 */
const hashState = (state: any, viewname: string): string => {
  const excluded = ["_page", "_pagesize", "_sortby", "_sortdesc"];
  const include = (k: string, v: any) =>
    !excluded.some((val) => k.endsWith(val)) && typeof v !== "undefined";
  const filteredState: any = {};
  for (const [k, v] of Object.entries(state)) {
    if (include(k, v)) filteredState[k] = v;
  }
  const stringToHash = `${viewname}:${objectToQueryString(filteredState)}`;
  const hash = crypto.createHash("sha1").update(stringToHash).digest("hex");
  return hash.substring(0, 5);
};

const extractPagings = (state: any): any => {
  const result: any = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.endsWith("_page") || k.endsWith("_pagesize")) {
      result[k] = v;
    }
  }
  return result;
};

/**
 * create a sha1 hash from a string
 * @param s string to hash
 * @returns sha1 hash
 */
const hashString = (s: string): string => {
  return crypto.createHash("sha1").update(s).digest("hex");
};

/**
 * check if 'saltcorn' is in the PATH env or build a full path
 * @returns string ready to use for spawn
 */
const getSafeSaltcornCmd = () => {
  return process.env.PATH!.indexOf("saltcorn-cli/bin") > 0
    ? "saltcorn"
    : process.env.JEST_WORKER_ID === undefined
      ? join(dirname(require!.main!.filename), "saltcorn")
      : join(
          dirname(require!.main!.filename),
          "..",
          "..",
          "saltcorn-cli",
          "bin",
          "saltcorn"
        );
};

/**
 * get base_url config without ending slash
 * @returns url or empty string
 */
const getSafeBaseUrl = () => {
  const path = require("./db/state").getState().getConfig("base_url");
  return !path
    ? ""
    : path.endsWith("/")
      ? path.substring(0, path.length - 1)
      : path;
};

/**
 * @param str
 * @returns
 */
const removeNonWordChars = (str: string) => {
  return str.replace(/[\W_]+/g, "");
};
const nubBy = (prop: string, xs: any[]) => {
  const vs = new Set();
  return xs.filter((x) => {
    if (vs.has(x[prop])) return false;
    vs.add(x[prop]);
    return true;
  });
};
// add a $ in front of every key
const dollarizeObject = (state: object) =>
  Object.fromEntries(Object.entries(state).map(([k, v]) => [`$${k}`, v]));

/**
 * @returns true if the NODE_ENV is 'test'
 */
const isTest = () =>
  process.env.NODE_ENV === "test" || process.env.REMOTE_QUERIES === "true";

/**
 * Compare objects (for Array.sort) by property name or function
 */
const comparing = (f: ((o: any) => any) | string) => (a: any, b: any) => {
  const fa = typeof f === "string" ? a[f] : f(a);
  const fb = typeof f === "string" ? b[f] : f(b);
  return fa > fb ? 1 : fb > fa ? -1 : 0;
};

const comparingCaseInsensitive = (k: string) => (a: any, b: any) => {
  const fa = a[k]?.toLowerCase?.();
  const fb = b[k]?.toLowerCase?.();
  return fa > fb ? 1 : fb > fa ? -1 : 0;
};

const comparingCaseInsensitiveValue = (a: any, b: any) => {
  const fa = a?.toLowerCase?.();
  const fb = b?.toLowerCase?.();
  return fa > fb ? 1 : fb > fa ? -1 : 0;
};

const ppVal = (x: any) =>
  typeof x === "string"
    ? x
    : typeof x === "function"
      ? x.toString()
      : JSON.stringify(x, null, 2);

const interpolate = (
  s: string,
  row: any,
  user?: any,
  errorLocation?: string
) => {
  try {
    if (s && typeof s === "string") {
      const template = _.template(s, {
        interpolate: /\{\{!(.+?)\}\}/g,
        escape: /\{\{([^!].+?)\}\}/g,
      });
      return template({ row, user, ...(row || {}) });
    } else return s;
  } catch (e: any) {
    e.message = `In evaluating the interpolation ${s}${
      errorLocation ? ` in ${errorLocation}` : ""
    }:\n\n${e.message}`;
    throw e;
  }
};

function escapeHtml(str: string): string {
  if (!str || !str.replace) return str;
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const prepMobileRows = (rows: Row[], fields: Field[]) => {
  const dateFields = fields.filter(
    (f) => instanceOfType(f.type) && f.type?.name === "Date"
  );
  if (dateFields.length === 0) return rows;
  else {
    const dateFieldNames = dateFields.map((f: any) => f.name);
    return rows.map((row) => {
      const newRow = { ...row };
      for (const fn of dateFieldNames) {
        if (newRow[fn]) newRow[fn] = new Date(newRow[fn]);
        if (newRow.row?.[fn]) newRow.row[fn] = new Date(newRow.row[fn]);
      }
      return newRow;
    });
  }
};

/**
 * find all files with specific ending
 * @param directory directory to search
 * @param ending wantet ending
 */
const filesWithEnding = (directory: string, ending: string): string[] => {
  const result = new Array<string>();
  if (!existsSync(directory)) return result;
  for (const file of readdirSync(directory)) {
    if (file.endsWith(ending)) result.push(file);
  }
  return result;
};

const safeEnding = (file: string, ending: string): string => {
  if (!file.endsWith(ending)) return `${file}${ending}`;
  return file;
};

/**
 * Ensure that string is finished with /
 * @param {string} s
 * @returns {string}
 */
const ensure_final_slash = (s: string): string =>
  s.endsWith("/") ? s : s + "/";

const cloneName = (name: string, allNames: Array<string>): string => {
  const basename = name + "-copy";
  let newname = basename;
  // todo there is hard code limitation about 100 copies of view
  for (let i = 0; i < 100; i++) {
    newname = i ? `${basename}-${i}` : basename;

    if (!allNames.includes(newname)) break;
  }
  return newname;
};

/**
 * @returns if the current schema is the default root schema
 */
const isRoot = () => {
  const db = require("./db");
  return db.getTenantSchema() === db.connectObj.default_schema;
};

/**
 * flat comparison of two objects (fast for comparing objects with primitive values, only first level)
 * @param a lhs
 * @param b rhs
 * @returns true or false
 */
const flatEqual = (a: any, b: any) => {
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Object.keys(a).length !== Object.keys(b).length) return false;
  for (const k in a) {
    if (!(k in b) || a[k] !== b[k]) return false;
  }
  return true;
};

const jsIdentifierValidator = (s: string) => {
  if (!s) return "An identifier is required";
  if (s.includes(" ")) return "Spaces not allowd";
  let badc = "'#:/\\@()[]{}\"!%^&*-+*~<>,.?|"
    .split("")
    .find((c) => s.includes(c));

  if (badc) return `Character ${badc} not allowed`;
};

const isPushEnabled = (user?: User): user is User => {
  if (!user?.id) return false;
  const push_policy_by_role =
    require("./db/state").getState()?.getConfig("push_policy_by_role") || {};
  const pushPolicy = push_policy_by_role[user.role_id || 100] || "Default on";
  if (pushPolicy === "Always") return true;
  if (pushPolicy === "Never") return false;
  const userAttr = isNode() ? user._attributes : user.attributes;
  if (userAttr?.notify_push === undefined) return pushPolicy === "Default on";
  return userAttr?.notify_push;
};

export = {
  cloneName,
  dollarizeObject,
  objectToQueryString,
  removeEmptyStrings,
  removeEmptyStringsKeepNull,
  removeDefaultColor,
  prefixFieldsInWhere,
  isEmpty,
  asyncMap,
  numberToBool,
  stringToJSON,
  applyAsync,
  apply,
  structuredClone,
  InvalidAdminAction,
  InvalidConfiguration,
  NotAuthorized,
  satisfies,
  getLines,
  removeAllWhiteSpace,
  sleep,
  mergeIntoWhere,
  isStale,
  isNode,
  isWeb,
  isOfflineMode,
  mergeConnectedObjects,
  hashState,
  hashString,
  extractPagings,
  getSafeSaltcornCmd,
  getSafeBaseUrl,
  removeNonWordChars,
  nubBy,
  isTest,
  getSessionId,
  mergeActionResults,
  urlStringToObject,
  comparing,
  comparingCaseInsensitive,
  comparingCaseInsensitiveValue,
  ppVal,
  interpolate,
  prepMobileRows,
  filesWithEnding,
  safeEnding,
  isRoot,
  flatEqual,
  validSqlId,
  ensure_final_slash,
  getFetchProxyOptions,
  jsIdentifierValidator,
  escapeHtml,
  isPushEnabled,
};
